import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OperationRegistry, OperationService, Operator, SqliteStore } from '../dist/index.js';
import { openSyntheticOperations } from '../dist/operations/local-synthetic.js';

export async function createOwnerControlFixture(t) {
    const directory = mkdtempSync(join(tmpdir(), 'behalvo-owner-control-'));
    const dbPath = join(directory, 'control.db');
    const workspaceId = 'owner-control-demo';
    const ownerId = 'owner';
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const store = new SqliteStore(dbPath);
    let provider;
    try {
        store.bindLocalMode('synthetic');
        store.createWorkspace(workspaceId, ownerId);
        const operator = new Operator(store);
        const registry = new OperationRegistry();
        const operations = new OperationService(store, registry, undefined, workspaceId);
        provider = openSyntheticOperations(store, registry, operations, { dbPath, workspaceId, ownerId });
        operator.createWork(workspaceId, ownerId, {
            id: 'contact-work', title: 'Update synthetic contact', goal: 'Set the synthetic email', threadId: 'contact-thread'
        });
        operator.createWork(workspaceId, ownerId, {
            id: 'subscription-work', title: 'Cancel synthetic subscription', goal: 'Cancel the synthetic plan', threadId: 'subscription-thread'
        });
        const approveAction = await operations.prepare({
            workspaceId, ownerId, workId: 'contact-work', key: 'owner-control-contact',
            connectionId: 'synthetic-account', operationId: 'contact.update', operationVersion: '1',
            resourceId: 'contact-profile', arguments: { email: 'owner-control@example.test' }
        });
        const cancelAction = await operations.prepare({
            workspaceId, ownerId, workId: 'subscription-work', key: 'owner-control-subscription',
            connectionId: 'synthetic-account', operationId: 'subscription.cancel', operationVersion: '1',
            resourceId: 'subscription', arguments: { reason: 'Synthetic owner-control demonstration' }
        });
        return { directory, dbPath, workspaceId, ownerId,
            approveActionId: approveAction.id, cancelActionId: cancelAction.id };
    } finally {
        provider?.close();
        store.close();
    }
}
