import { lstatSync } from 'node:fs';
import { OperationRegistry } from '../operations/registry.js';
import { OperationService } from '../operations/service.js';
import { openSyntheticOperations } from '../operations/local-synthetic.js';
import { Operator } from '../runtime/operator.js';
import { acquireLocalProcessLock } from '../storage/process-lock.js';
import { SqliteStore } from '../storage/sqlite-store.js';

export const OWNER_CONTROL_DEMO_WORKSPACE = 'owner-control-demo';
const OWNER_ID = 'owner';

export interface OwnerControlDemoFixture {
  dbPath: string;
  workspaceId: string;
  ownerId: string;
  approveActionId: string;
  cancelActionId: string;
}

function fixturePaths(dbPath: string): string[] {
  const synthetic = `${dbPath}.synthetic.sqlite`;
  return [
    dbPath,
    `${dbPath}-wal`,
    `${dbPath}-shm`,
    `${dbPath}-journal`,
    synthetic,
    `${synthetic}-wal`,
    `${synthetic}-shm`,
    `${synthetic}-journal`
  ];
}

function existsWithoutFollowing(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export async function initializeOwnerControlDemo(
  dbPath: string
): Promise<OwnerControlDemoFixture> {
  if (dbPath === ':memory:') throw new Error('A durable database path is required.');
  const lock = acquireLocalProcessLock(dbPath);
  let store: SqliteStore | undefined;
  let provider: ReturnType<typeof openSyntheticOperations> | undefined;

  try {
    if (fixturePaths(lock.dbPath).some(existsWithoutFollowing)) {
      throw new Error('Owner-control demo fixture already exists or is incomplete.');
    }

    store = new SqliteStore(lock.dbPath);
    store.bindLocalMode('synthetic');
    store.createWorkspace(OWNER_CONTROL_DEMO_WORKSPACE, OWNER_ID);
    const operator = new Operator(store);
    const registry = new OperationRegistry();
    const operations = new OperationService(
      store,
      registry,
      undefined,
      OWNER_CONTROL_DEMO_WORKSPACE
    );
    provider = openSyntheticOperations(store, registry, operations, {
      dbPath: lock.dbPath,
      workspaceId: OWNER_CONTROL_DEMO_WORKSPACE,
      ownerId: OWNER_ID
    });

    operator.createWork(OWNER_CONTROL_DEMO_WORKSPACE, OWNER_ID, {
      id: 'contact-work',
      title: 'Update synthetic contact',
      goal: 'Set the synthetic email',
      threadId: 'owner-control-contact'
    });
    operator.createWork(OWNER_CONTROL_DEMO_WORKSPACE, OWNER_ID, {
      id: 'subscription-work',
      title: 'Cancel synthetic subscription',
      goal: 'Cancel the synthetic plan',
      threadId: 'owner-control-subscription'
    });

    const contact = await operations.prepare({
      workspaceId: OWNER_CONTROL_DEMO_WORKSPACE,
      ownerId: OWNER_ID,
      workId: 'contact-work',
      key: 'owner-control-contact',
      connectionId: 'synthetic-account',
      operationId: 'contact.update',
      operationVersion: '1',
      resourceId: 'contact-profile',
      arguments: { email: 'owner-control@example.test' }
    });
    const subscription = await operations.prepare({
      workspaceId: OWNER_CONTROL_DEMO_WORKSPACE,
      ownerId: OWNER_ID,
      workId: 'subscription-work',
      key: 'owner-control-subscription',
      connectionId: 'synthetic-account',
      operationId: 'subscription.cancel',
      operationVersion: '1',
      resourceId: 'subscription',
      arguments: { reason: 'Synthetic owner-control demonstration' }
    });

    return {
      dbPath: lock.dbPath,
      workspaceId: OWNER_CONTROL_DEMO_WORKSPACE,
      ownerId: OWNER_ID,
      approveActionId: contact.id,
      cancelActionId: subscription.id
    };
  } finally {
    provider?.close();
    store?.close();
    lock.release();
  }
}
