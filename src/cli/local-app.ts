import { OperationRegistry } from '../operations/registry.js';
import { OperationService } from '../operations/service.js';
import { openSyntheticOperations, type PersistentSyntheticOperationsProvider } from '../operations/local-synthetic.js';
import type { ModelGateway } from '../model/types.js';
import { ModelRegistry } from '../model/registry.js';
import { AgentService } from '../runtime/agent-service.js';
import { Operator } from '../runtime/operator.js';
import { SqliteStore } from '../storage/sqlite-store.js';

export interface LocalAgentOptions {
  dbPath: string;
  workspaceId: string;
  ownerId: string;
  gateways: readonly ModelGateway[];
  syntheticOperations?: boolean;
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
  const store = new SqliteStore(options.dbPath);
  let synthetic: PersistentSyntheticOperationsProvider | undefined;
  try {
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
      synthetic = openSyntheticOperations(store, operationRegistry, operations, options);
    return {
      store,
      operations,
      operationRegistry,
      registry,
      service: new AgentService(store, registry, undefined, { service: operations, registry: operationRegistry, workspaceId: options.workspaceId }),
      operator: new Operator(store),
      close: () => { synthetic?.close(); store.close(); }
    };
  } catch (error) {
    synthetic?.close();
    store.close();
    throw error;
  }
}
