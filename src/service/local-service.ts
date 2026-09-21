import { randomUUID } from 'node:crypto';
import { AgentService } from '../runtime/agent-service.js';
import { ServiceRuntime } from '../runtime/service-runtime.js';
import { ModelRegistry } from '../model/registry.js';
import type { ModelGateway } from '../model/types.js';
import { OperationRegistry } from '../operations/registry.js';
import { OperationService } from '../operations/service.js';
import { openSyntheticOperations, type PersistentSyntheticOperationsProvider } from '../operations/local-synthetic.js';
import { Operator } from '../runtime/operator.js';
import { acquireLocalProcessLock } from '../storage/process-lock.js';
import { SqliteStore } from '../storage/sqlite-store.js';
import { OwnerControlSessions } from '../control/session.js';
import { OwnerControlService } from '../control/review-service.js';
import { ServiceControlService } from '../control/service-control.js';
import { startOwnerControlServer } from '../control/http-server.js';
import { validateLocalServiceOptions, type LocalServiceOptions } from './config.js';

export interface LocalService {
  readonly origin: string;
  readonly bootstrapPath: string;
  readonly control: ServiceControlService;
  shutdown(): Promise<boolean>;
}

export interface LocalServiceRecoveryOptions {
  dbPath: string;
  workspaceId: string;
  exclusiveMaintenance: true;
  encryptionKey?: Uint8Array;
}

export interface LocalServiceRecoveryResult {
  jobsInterrupted: number;
  jobsRepaired: number;
  actionsUnknown: number;
}

const activeServices = new Set<string>();

function unavailableGateway(): ModelGateway {
  return {
    async listModels() { return []; },
    async complete() { throw new Error('Model configuration is unavailable.'); }
  };
}

export async function startLocalService(input: LocalServiceOptions): Promise<LocalService> {
  const options = validateLocalServiceOptions(input);
  const processLock = acquireLocalProcessLock(options.dbPath);
  if (activeServices.has(processLock.dbPath)) {
    processLock.release();
    throw new Error('Local service is already running for this database.');
  }
  activeServices.add(processLock.dbPath);
  let store: SqliteStore | undefined;
  let synthetic: PersistentSyntheticOperationsProvider | undefined;
  let reviews: OwnerControlService | undefined;
  let control: ServiceControlService | undefined;
  let server: Awaited<ReturnType<typeof startOwnerControlServer>> | undefined;
  let runtime: ServiceRuntime | undefined;
  let released = false;
  const releaseResources = (): void => {
    if (released) return;
    released = true;
    try { control?.close(); } finally {
      try { reviews?.close(); } finally {
        try { synthetic?.close(); } finally {
          try { store?.close(); } finally {
            activeServices.delete(processLock.dbPath);
            processLock.release();
          }
        }
      }
    }
  };
  try {
    store = new SqliteStore(processLock.dbPath, {
      serviceQueue: { upgradeExisting: options.upgradeStorage },
      ...(options.encryptionKey ? { encryptionKey: options.encryptionKey } : {})
    });
    store.bindLocalMode(options.syntheticOperations ? 'synthetic' : 'ordinary');
    let state;
    try { state = store.state(options.workspaceId); }
    catch (error) {
      if (!(error instanceof Error) || error.message !== 'Workspace not found') throw error;
      state = store.createWorkspace(options.workspaceId, options.ownerId);
    }
    if (state.ownerId !== options.ownerId) throw new Error('Local service workspace binding mismatch.');

    const gateways = options.gateways ?? [];
    const gateway = gateways.length > 0 ? new ModelRegistry(gateways) : unavailableGateway();
    if (options.model && !(gateway instanceof ModelRegistry))
      throw new Error('Configured model gateway is unavailable.');
    const operationRegistry = new OperationRegistry();
    const isoClock = (): string => new Date((options.clock ?? Date.now)()).toISOString();
    const operations = new OperationService(store, operationRegistry, isoClock, options.workspaceId);
    if (options.syntheticOperations) synthetic = openSyntheticOperations(store, operationRegistry, operations, {
      dbPath: processLock.dbPath, workspaceId: options.workspaceId, ownerId: options.ownerId
    });
    const agent = new AgentService(store, gateway, isoClock, {
      service: operations, registry: operationRegistry, workspaceId: options.workspaceId
    });
    const sessions = new OwnerControlSessions({ workspaceId: options.workspaceId, ownerId: options.ownerId },
      options.clock ?? Date.now);
    const operator = new Operator(store, isoClock);
    reviews = new OwnerControlService({ store, operator, operations, sessions,
      binding: { workspaceId: options.workspaceId, ownerId: options.ownerId },
      onFatalStorageError: error => runtime?.reportStorageError(error),
      ...(options.clock ? { clock: options.clock } : {}) });
    runtime = new ServiceRuntime(store, agent, operations, {
      workspaceId: options.workspaceId, ownerId: options.ownerId, instanceId: sessions.instanceId,
      serviceGeneration: randomUUID(), clock: isoClock
    });
    control = new ServiceControlService({ store, runtime, reviews, sessions, operator,
      binding: { workspaceId: options.workspaceId, ownerId: options.ownerId },
      ...(options.model ? { model: options.model } : {}),
      databaseMode: options.encryptionKey ? 'encrypted' : 'plaintext',
      ...(options.clock ? { clock: options.clock } : {}) });
    const app = { sessions, service: reviews, serviceControl: control, close: releaseResources };
    server = await startOwnerControlServer({ app, bootstrapDirectory: options.bootstrapDirectory,
      assets: options.assets, ...(options.port !== undefined ? { port: options.port } : {}) });
    runtime.start();
    let shutdownPromise: Promise<boolean> | undefined;
    return {
      origin: server.origin,
      bootstrapPath: server.bootstrapPath,
      control,
      shutdown(): Promise<boolean> {
        shutdownPromise ??= (async () => {
          const settling = runtime!.shutdown();
          const listenerClosing = server!.close();
          const settled = await settling;
          await listenerClosing;
          if (settled) releaseResources();
          return settled;
        })();
        return shutdownPromise;
      }
    };
  } catch (error) {
    try { await server?.close(); } catch { /* Preserve the fixed startup error. */ }
    releaseResources();
    throw error;
  }
}

export function recoverLocalService(options: LocalServiceRecoveryOptions): LocalServiceRecoveryResult {
  if (!options || options.exclusiveMaintenance !== true)
    throw new Error('Exclusive maintenance is required.');
  const processLock = acquireLocalProcessLock(options.dbPath);
  if (activeServices.has(processLock.dbPath)) {
    processLock.release();
    throw new Error('Exclusive maintenance ownership is unavailable while the local service is running.');
  }
  let store: SqliteStore | undefined;
  try {
    store = new SqliteStore(processLock.dbPath, {
      serviceQueue: { upgradeExisting: false },
      ...(options.encryptionKey ? { encryptionKey: options.encryptionKey } : {})
    });
    const state = store.state(options.workspaceId);
    const inspected = store.inspectInterruptedServiceJobs(options.workspaceId, new Date().toISOString());
    const operations = new OperationService(store, new OperationRegistry(), undefined, state.workspaceId);
    const actionsUnknown = operations.recoverInterrupted({
      workspaceId: options.workspaceId, exclusiveMaintenance: true
    });
    return { jobsInterrupted: inspected.interrupted, jobsRepaired: inspected.repaired, actionsUnknown };
  } finally {
    try { store?.close(); } finally { processLock.release(); }
  }
}
