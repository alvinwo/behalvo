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
}

export interface LocalAgent {
  store: SqliteStore;
  registry: ModelRegistry;
  service: AgentService;
  operator: Operator;
  close(): void;
}

export function openLocalAgent(options: LocalAgentOptions): LocalAgent {
  const store = new SqliteStore(options.dbPath);
  try {
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
    return {
      store,
      registry,
      service: new AgentService(store, registry),
      operator: new Operator(store),
      close: () => store.close()
    };
  } catch (error) {
    store.close();
    throw error;
  }
}
