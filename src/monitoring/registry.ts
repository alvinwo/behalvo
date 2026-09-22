import type { MonitoredActionPolicyAdapter } from './types.js';
import { identifier } from '../kernel/types.js';

export class MonitoringRegistry {
  readonly #adapters = new Map<string, MonitoredActionPolicyAdapter>();
  readonly #disabled = new Map<string, { id: string; version: number; reason: 'supervised_discovery_required' }>();

  register(adapter: MonitoredActionPolicyAdapter): void {
    if (!adapter || typeof adapter !== 'object') throw new Error('Invalid monitoring adapter');
    identifier(adapter.id, 'adapter');
    if (!Number.isSafeInteger(adapter.version) || adapter.version < 1 ||
        typeof adapter.validateScope !== 'function' || typeof adapter.coverageSufficient !== 'function' ||
        typeof adapter.selectCommand !== 'function' ||
        (adapter.inspect !== undefined && typeof adapter.inspect !== 'function') ||
        (adapter.executeReserved !== undefined && typeof adapter.executeReserved !== 'function') ||
        (adapter.verifyReserved !== undefined && typeof adapter.verifyReserved !== 'function'))
      throw new Error('Invalid monitoring adapter');
    const key = this.#key(adapter.id, adapter.version);
    if (this.#adapters.has(key) || this.#disabled.has(key)) throw new Error('Monitoring adapter already registered');
    this.#adapters.set(key, Object.freeze({
      id: adapter.id, version: adapter.version,
      validateScope: adapter.validateScope.bind(adapter),
      coverageSufficient: adapter.coverageSufficient.bind(adapter),
      selectCommand: adapter.selectCommand.bind(adapter),
      ...(adapter.inspect ? { inspect: adapter.inspect.bind(adapter) } : {}),
      ...(adapter.executeReserved ? { executeReserved: adapter.executeReserved.bind(adapter) } : {}),
      ...(adapter.verifyReserved ? { verifyReserved: adapter.verifyReserved.bind(adapter) } : {})
    }));
  }

  registerDisabled(input: { id: string; version: number; reason: 'supervised_discovery_required' }): void {
    if (!input || typeof input !== 'object' || Object.keys(input).sort().join('\0') !==
        ['id', 'version', 'reason'].sort().join('\0')) throw new Error('Invalid disabled monitoring adapter');
    identifier(input.id, 'adapter');
    if (!Number.isSafeInteger(input.version) || input.version < 1 || input.reason !== 'supervised_discovery_required')
      throw new Error('Invalid disabled monitoring adapter');
    const key = this.#key(input.id, input.version);
    if (this.#adapters.has(key) || this.#disabled.has(key)) throw new Error('Monitoring adapter already registered');
    this.#disabled.set(key, Object.freeze({ ...input }));
  }

  resolve(id: string, version: number): MonitoredActionPolicyAdapter {
    identifier(id, 'adapter');
    if (!Number.isSafeInteger(version) || version < 1) throw new Error('Invalid adapter version');
    const adapter = this.#adapters.get(this.#key(id, version));
    if (!adapter) {
      if (this.#disabled.has(this.#key(id, version))) throw new Error('Monitoring adapter is disabled pending supervised discovery');
      throw new Error('Monitoring adapter version is not registered');
    }
    return adapter;
  }

  list(): { id: string; version: number }[] {
    return [...this.#adapters.values()].map(adapter => ({ id: adapter.id, version: adapter.version }))
      .sort((left, right) => left.id.localeCompare(right.id) || left.version - right.version);
  }

  listReadiness(): Array<{ id: string; version: number; status: 'registered' | 'disabled';
      reason?: 'supervised_discovery_required' }> {
    const values: Array<{ id: string; version: number; status: 'registered' | 'disabled';
      reason?: 'supervised_discovery_required' }> = [
      ...[...this.#adapters.values()].map(adapter => ({ id: adapter.id, version: adapter.version,
        status: 'registered' as const })),
      ...[...this.#disabled.values()].map(adapter => ({ ...adapter, status: 'disabled' as const }))
    ];
    return values
      .sort((left, right) => left.id.localeCompare(right.id) || left.version - right.version);
  }

  #key(id: string, version: number): string { return `${id}\u0000${version}`; }
}
