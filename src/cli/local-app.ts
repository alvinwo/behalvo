import { OperationRegistry } from '../operations/registry.js';
import { OperationService } from '../operations/service.js';
import { openSyntheticOperations, type PersistentSyntheticOperationsProvider } from '../operations/local-synthetic.js';
import type { ModelGateway } from '../model/types.js';
import { ModelRegistry } from '../model/registry.js';
import { AgentService } from '../runtime/agent-service.js';
import { Operator } from '../runtime/operator.js';
import { SqliteStore } from '../storage/sqlite-store.js';
import { acquireLocalProcessLock } from '../storage/process-lock.js';

export interface LocalAgentOptions {
  dbPath: string;
  workspaceId: string;
  ownerId: string;
  gateways: readonly ModelGateway[];
  syntheticOperations?: boolean;
  encryptionKey?: Uint8Array;
}

export interface LocalAgent {
  store: SqliteStore;
  registry: ModelRegistry;
  service: AgentService;
  operator: Operator;
  operations: OperationService;
  operationRegistry: OperationRegistry;
  close(): void;
}

export function openLocalAgent(options: LocalAgentOptions): LocalAgent {
  if (options.encryptionKey !== undefined && options.syntheticOperations && options.dbPath !== ':memory:')
    throw new Error('Encrypted storage cannot use persistent synthetic operations.');
  const processLock = acquireLocalProcessLock(options.dbPath);
  let store: SqliteStore | undefined;
  let synthetic: PersistentSyntheticOperationsProvider | undefined;
  try {
    store = new SqliteStore(processLock.dbPath, options.encryptionKey === undefined ? {} : { encryptionKey: options.encryptionKey });
    store.bindLocalMode(options.syntheticOperations ? 'synthetic' : 'ordinary');
    let state;
    try {
      state = store.state(options.workspaceId);
    } catch (error) {
      if (!(error instanceof Error) || error.message !== 'Workspace not found') throw error;
      state = store.createWorkspace(options.workspaceId, options.ownerId);
    }
    if (state.ownerId !== options.ownerId)
      throw new Error(`Workspace owner mismatch: expected ${state.ownerId}`);

    const registry = new ModelRegistry(options.gateways);
    const operationRegistry = new OperationRegistry();
    const operations = new OperationService(store, operationRegistry, undefined, options.workspaceId);
    if (options.syntheticOperations)
      synthetic = openSyntheticOperations(store, operationRegistry, operations, { ...options, dbPath: processLock.dbPath });
    let closed = false;
    return {
      store,
      operations,
      operationRegistry,
      registry,
      service: new AgentService(store, registry, undefined, { service: operations, registry: operationRegistry, workspaceId: options.workspaceId }),
      operator: new Operator(store),
      close: () => {
        if (closed) return;
        closed = true;
        try { synthetic?.close(); } finally {
          try { store?.close(); } finally { processLock.release(); }
        }
      }
    };
  } catch (error) {
    try { synthetic?.close(); } finally {
      try { store?.close(); } finally { processLock.release(); }
    }
    throw error;
  }
}
