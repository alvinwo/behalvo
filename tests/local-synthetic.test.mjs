import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openLocalAgent } from '../dist/index.js';
import { parseCliArgs } from '../dist/cli/main.js';

const input = { workId: 'work', key: 'update', connectionId: 'synthetic-account', operationId: 'contact.update', operationVersion: '1', resourceId: 'contact-profile', arguments: { email: 'new@example.test' } };
function options(dir, workspaceId = 'ws', syntheticOperations = true) { return { dbPath: join(dir, 'agent.db'), workspaceId, ownerId: 'owner', gateways: [{ async listModels() { return []; }, async complete() { throw new Error('unused'); } }], syntheticOperations }; }
function work(app, workspaceId = 'ws') { app.operator.createWork(workspaceId, 'owner', { id: 'work', title: 'Synthetic work', goal: 'Change synthetic account', threadId: 'thread' }); }
async function prepare(app, workspaceId = 'ws') { return app.operations.prepare({ workspaceId, ownerId: 'owner', ...input }); }
function approve(app, action, workspaceId = 'ws') { app.operations.approveBatch({ workspaceId, ownerId: 'owner', expiresAt: new Date(Date.now() + 600000).toISOString(), approvals: [{ actionId: action.id, digest: action.digest }] }); }

test('synthetic flag has an isolated default database and explicit db remains supported', () => {
    const before = { BEHALVO_DB: process.env.BEHALVO_DB, OPERATOR_DB: process.env.OPERATOR_DB };
    process.env.BEHALVO_DB = '/tmp/ordinary-user.db';
    try {
        const args = parseCliArgs(['--synthetic-operations']);
        assert.equal(args.syntheticOperations, true);
        assert.match(args.dbPath, /synthetic-agent\.db$/);
        assert.equal(parseCliArgs(['--synthetic-operations', '--db', '/tmp/explicit.db']).dbPath, '/tmp/explicit.db');
    } finally {
        for (const [key, value] of Object.entries(before)) value === undefined ? delete process.env[key] : process.env[key] = value;
    }
});

test('synthetic provider truth and versions persist through actual close/reopen with approval generation unchanged', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'behalvo-synthetic-'));
    let app = openLocalAgent(options(dir));
    try {
        assert.ok(app.operations, 'local app exposes operation service');
        work(app);
        const action = await prepare(app); approve(app, action);
        const generation = app.store.state('ws').connections['synthetic-account'].generation;
        app.close(); app = openLocalAgent(options(dir));
        assert.equal(app.store.state('ws').connections['synthetic-account'].generation, generation);
        assert.equal((await app.operations.execute({ workspaceId: 'ws', ownerId: 'owner', actionId: action.id })).status, 'accepted');
        app.close(); app = openLocalAgent(options(dir));
        const readback = await app.operations.verify({ workspaceId: 'ws', ownerId: 'owner', actionId: action.id });
        assert.equal(readback.verification.status, 'satisfied');
        assert.equal(readback.verification.observation.state.email, 'new@example.test');
        assert.equal(readback.verification.observation.providerVersion, 'contact:2');
        const before = app.store.journal('ws').length;
        await app.operations.execute({ workspaceId: 'ws', ownerId: 'owner', actionId: action.id });
        assert.equal(app.store.journal('ws').length, before);
        app.store.rebuild('ws');
        const next = await app.operations.prepare({ workspaceId: 'ws', ownerId: 'owner', ...input, key: 'next', arguments: { email: 'next@example.test' } });
        assert.equal(next.command.precondition.providerVersion, 'contact:2');
    } finally { app.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('one persistent synthetic sidecar isolates equal subjects/resources in different workspaces', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'behalvo-synthetic-scopes-'));
    const first = openLocalAgent(options(dir, 'first'));
    const second = openLocalAgent(options(dir, 'second'));
    try {
        assert.ok(first.operations); work(first, 'first'); work(second, 'second');
        const a = await prepare(first, 'first'); approve(first, a, 'first');
        await first.operations.execute({ workspaceId: 'first', ownerId: 'owner', actionId: a.id });
        const b = await prepare(second, 'second');
        assert.equal(b.command.precondition.state.email, 'synthetic@example.test');
        assert.equal(b.command.precondition.providerVersion, 'contact:1');
    } finally { first.close(); second.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('normal and synthetic databases cannot silently switch mode, including existing normal work', () => {
    const dir = mkdtempSync(join(tmpdir(), 'behalvo-synthetic-mode-'));
    try {
        const normal = openLocalAgent(options(dir, 'ws', false)); work(normal); normal.close();
        assert.throws(() => openLocalAgent(options(dir)), /mode|synthetic|ordinary/i);
        const syntheticOptions = { ...options(dir), dbPath: join(dir, 'synthetic.db') };
        openLocalAgent(syntheticOptions).close();
        assert.throws(() => openLocalAgent({ ...syntheticOptions, syntheticOperations: false }), /mode|synthetic/i);
        const reopened = openLocalAgent(options(dir, 'ws', false));
        assert.equal(reopened.operationRegistry.list().length, 0); reopened.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('missing or corrupt provider truth fails closed rather than reseeding', async () => {
    for (const corrupt of [false, true]) {
        const dir = mkdtempSync(join(tmpdir(), 'behalvo-synthetic-corrupt-'));
        const opts = options(dir);
        const app = openLocalAgent(opts);
        try {
            assert.ok(app.operations); work(app); await prepare(app); app.close();
            const sidecar = `${opts.dbPath}.synthetic.sqlite`;
            if (corrupt) {
                const db = new DatabaseSync(sidecar);
                db.prepare('UPDATE resources SET state_json=?').run('{broken'); db.close();
            } else rmSync(sidecar);
            assert.throws(() => openLocalAgent(opts), /synthetic|state|resource|JSON|unavailable/i);
        } finally { app.close(); rmSync(dir, { recursive: true, force: true }); }
    }
});

test('reopening never reactivates revoked bindings or recovers running actions automatically', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'behalvo-synthetic-barrier-'));
    const opts = options(dir);
    let app = openLocalAgent(opts);
    try {
        assert.ok(app.operations); work(app);
        const action = await prepare(app); approve(app, action);
        const state = app.store.state('ws');
        app.store.append('ws', state.version, [{ type: 'action.started', data: { id: action.id, attemptId: 'interrupted' } }]);
        app.close(); app = openLocalAgent(opts);
        assert.equal(app.store.state('ws').actions[action.id].status, 'running');
        assert.equal((await app.operations.execute({ workspaceId: 'ws', ownerId: 'owner', actionId: action.id })).status, 'running');
        app.operations.revokeConnection({ workspaceId: 'ws', ownerId: 'owner', connectionId: 'synthetic-account' });
        app.close(); app = openLocalAgent(opts);
        assert.equal(app.store.state('ws').connections['synthetic-account'].status, 'revoked');
    } finally { app.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('local services reject another workspace before provider access or owner-turn ingestion', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'behalvo-local-binding-'));
    let modelCalls = 0;
    const gateway = { async listModels() { return []; }, async complete() { modelCalls++; return { text: '{"reply":"unexpected","workProposals":[],"factProposals":[]}' }; } };
    const first = openLocalAgent({ ...options(dir, 'first'), ownerId: 'alice', gateways: [gateway] });
    const second = openLocalAgent({ ...options(dir, 'second'), ownerId: 'bob', gateways: [gateway] });
    try {
        first.operator.createWork('first', 'alice', { id: 'work', title: 'Alice', goal: 'Synthetic contact', threadId: 'thread' });
        second.operator.createWork('second', 'bob', { id: 'work', title: 'Bob', goal: 'Synthetic contact', threadId: 'thread' });
        const alice = await first.operations.prepare({ workspaceId: 'first', ownerId: 'alice', ...input, arguments: { email: 'alice@example.test' } });
        first.operations.approveBatch({ workspaceId: 'first', ownerId: 'alice', expiresAt: new Date(Date.now() + 600000).toISOString(), approvals: [{ actionId: alice.id, digest: alice.digest }] });
        await first.operations.execute({ workspaceId: 'first', ownerId: 'alice', actionId: alice.id });
        await assert.rejects(first.operations.prepare({ workspaceId: 'second', ownerId: 'bob', ...input }), /workspace.*binding|bound.*workspace/i);
        const bob = await second.operations.prepare({ workspaceId: 'second', ownerId: 'bob', ...input });
        assert.equal(bob.command.precondition.state.email, 'synthetic@example.test');
        second.operations.approveBatch({ workspaceId: 'second', ownerId: 'bob', expiresAt: new Date(Date.now() + 600000).toISOString(), approvals: [{ actionId: bob.id, digest: bob.digest }] });
        await assert.rejects(first.operations.execute({ workspaceId: 'second', ownerId: 'bob', actionId: bob.id }), /workspace.*binding|bound.*workspace/i);
        await assert.rejects(first.operations.verify({ workspaceId: 'second', ownerId: 'bob', actionId: bob.id }), /workspace.*binding|bound.*workspace/i);
        const before = second.store.journal('second').length;
        for (const mutation of [
            () => first.operations.registerConnection({ workspaceId: 'second', ownerId: 'bob', connection: { id: 'extra', provider: 'synthetic-accounts', subject: 'synthetic-person', label: 'Synthetic' } }),
            () => first.operations.revokeConnection({ workspaceId: 'second', ownerId: 'bob', connectionId: 'synthetic-account' }),
            () => first.operations.approveBatch({ workspaceId: 'second', ownerId: 'bob', expiresAt: new Date(Date.now() + 600000).toISOString(), approvals: [{ actionId: bob.id, digest: bob.digest }] }),
            () => first.operations.reconcile({ workspaceId: 'second', ownerId: 'bob', actionId: bob.id, status: 'accepted', evidence: 'Must not be written' }),
            () => first.operations.recoverInterrupted({ workspaceId: 'second', exclusiveMaintenance: true })
        ]) assert.throws(mutation, /workspace.*binding|bound.*workspace/i);
        await assert.rejects(first.service.runOwnerTurn({ workspaceId: 'second', ownerId: 'bob', threadId: 'thread', externalId: 'cross-app',
            text: 'Do not ingest into another app workspace.', model: { provider: 'fake', model: 'one' }, workId: 'work' }), /workspace.*binding|bound.*workspace/i);
        assert.equal(second.store.journal('second').length, before);
        assert.equal(modelCalls, 0);
        assert.equal(second.store.state('second').actions[bob.id].status, 'approved');
    } finally { first.close(); second.close(); rmSync(dir, { recursive: true, force: true }); }
});
