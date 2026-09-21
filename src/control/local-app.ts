import { OperationRegistry } from '../operations/registry.js';
import { OperationService } from '../operations/service.js';
import { Operator } from '../runtime/operator.js';
import { acquireLocalProcessLock } from '../storage/process-lock.js';
import { SqliteStore } from '../storage/sqlite-store.js';
import { OwnerControlService } from './review-service.js';
import { OwnerControlSessions } from './session.js';
import type { ServiceControlAdapter } from './types.js';

export interface OwnerControlApp {
  readonly sessions: OwnerControlSessions;
  readonly service: OwnerControlService;
  readonly serviceControl?: ServiceControlAdapter;
  close(): void;
}

export function openOwnerControl(options: {
  dbPath: string;
  workspaceId: string;
  clock?: () => number;
}): OwnerControlApp {
  const processLock = acquireLocalProcessLock(options.dbPath);
  let probe: SqliteStore | undefined;
  let store: SqliteStore | undefined;
  let service: OwnerControlService | undefined;
  try {
    probe = new SqliteStore(processLock.dbPath, { readOnly: true });
    if (probe.localMode() !== 'synthetic') throw new Error('Owner control requires an existing synthetic database.');
    const preflight = probe.state(options.workspaceId);
    const binding = { workspaceId: preflight.workspaceId, ownerId: preflight.ownerId };
    probe.close();
    probe = undefined;

    store = new SqliteStore(processLock.dbPath);
    if (store.localMode() !== 'synthetic') throw new Error('Owner control database mode changed during startup.');
    const current = store.state(options.workspaceId);
    if (current.workspaceId !== binding.workspaceId || current.ownerId !== binding.ownerId)
      throw new Error('Owner control workspace binding changed during startup.');
    const clock = options.clock ?? Date.now;
    const isoClock = (): string => new Date(clock()).toISOString();
    const sessions = new OwnerControlSessions(binding, clock);
    const operator = new Operator(store, isoClock);
    const operations = new OperationService(store, new OperationRegistry(), isoClock, binding.workspaceId);
    service = new OwnerControlService({ store, operator, operations, sessions, binding, clock });
    let closed = false;
    return {
      sessions,
      service,
      close(): void {
        if (closed) return;
        closed = true;
        try { service?.close(); } finally {
          try { store?.close(); } finally { processLock.release(); }
        }
      }
    };
  } catch (error) {
    try { service?.close(); } finally {
      try { probe?.close(); } finally {
        try { store?.close(); } finally { processLock.release(); }
      }
    }
    throw error;
  }
}
