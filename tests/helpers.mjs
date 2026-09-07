import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
export async function api() {
    const implementation = await import('../dist/index.js').catch(error => {
        if (error.code === 'ERR_MODULE_NOT_FOUND')
            return null;
        throw error;
    });
    assert.ok(implementation, 'The kernel implementation is missing; implement the tested contract.');
    return implementation;
}
export async function fixture(t) {
    const lib = await api();
    const dir = mkdtempSync(join(tmpdir(), 'operator-test-'));
    const path = join(dir, 'agent.db');
    const clock = { value: '2026-09-07T12:00:00.000Z' };
    const f = { ...lib, path, clock, store: new lib.SqliteStore(path) };
    f.store.createWorkspace('personal', 'owner');
    f.operator = new lib.Operator(f.store, () => clock.value);
    f.restart = () => {
        f.store.close();
        f.store = new lib.SqliteStore(path);
        f.operator = new lib.Operator(f.store, () => clock.value);
    };
    t.after(() => { f.store.close(); rmSync(dir, { recursive: true, force: true }); });
    return f;
}
export function message(externalId, extra = {}) {
    return { source: 'relay:account-a', externalId, threadId: 'im',
        senderId: 'owner', senderRole: 'owner', text: `Message ${externalId}`, ...extra };
}
export function createWork(f, id = 'w') {
    return f.operator.createWork('personal', 'owner', {
        id, title: 'A synthetic refund follow-up', goal: 'Owner confirms resolution', threadId: 'im'
    });
}
export function propose(f, extra = {}) {
    return f.operator.propose('personal', { workId: 'w', key: 'followup-1', command: {
            kind: 'message.send', channel: 'mock-email', to: 'vendor@example.test', body: 'Please confirm.'
        }, ...extra });
}
export function approve(f, action) {
    return f.operator.approve('personal', 'owner', action.id, action.digest, '2026-09-07T13:00:00.000Z');
}
