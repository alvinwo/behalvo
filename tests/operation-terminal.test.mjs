import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openLocalAgent, runRepl } from '../dist/index.js';

const model = { provider: 'fake', model: 'one' };
const final = { reply: 'Synthetic readback verified; work remains open.', workProposals: [], factProposals: [] };
const args = { connectionId: 'synthetic-account', operationId: 'contact.update', operationVersion: '1', resourceId: 'contact-profile', arguments: { email: 'new@example.test' } };
const tool = (name, arguments_ = {}) => ({ tool: { name, arguments: arguments_ } });
async function repl(app, lines, extra = {}) {
    const output = [];
    await app.registry.select('fake', 'one');
    await runRepl({ store: app.store, registry: app.registry, service: app.service, operations: app.operations,
        workspaceId: 'ws', ownerId: 'owner', initialThreadId: 'thread',
        io: { async readLine() { const line = lines.shift(); return typeof line === 'function' ? line(output) : line ?? null; }, write(line) { output.push(line); } }, ...extra });
    return output;
}
function fixture(responses = []) {
    const dir = mkdtempSync(join(tmpdir(), 'behalvo-terminal-'));
    const gateway = { async listModels() { return [model]; }, async complete() {
        const next = responses.shift() ?? final;
        return { text: JSON.stringify(typeof next === 'function' ? next() : next) };
    } };
    const opts = { dbPath: join(dir, 'synthetic.db'), workspaceId: 'ws', ownerId: 'owner', gateways: [gateway], syntheticOperations: true };
    const app = openLocalAgent(opts);
    return { app, opts, dir, close() { app.close(); rmSync(dir, { recursive: true, force: true }); } };
}
async function prepared(f) {
    f.app.operator.createWork('ws', 'owner', { id: 'work', title: 'Synthetic\u001b[31m work', goal: 'Test', threadId: 'thread' });
    return f.app.operations.prepare({ workspaceId: 'ws', ownerId: 'owner', workId: 'work', key: 'prepare', ...args });
}

test('approval requires exact arity, full digest and literal current-session actions display; TTL is ten minutes', async () => {
    const f = fixture();
    try {
        const action = await prepared(f);
        const cmd = `/approve ${action.id} ${action.digest}`;
        const now = new Date().toISOString();
        const output = await repl(f.app, ['/work work', cmd, '/actions extra', cmd, '/actions',
            `${cmd} extra`, `/approve ${action.id} wrong`, cmd, '/quit'], { clock: () => now });
        assert.ok(output.filter(line => /Run \/actions.*review/i.test(line)).length >= 2);
        assert.ok(output.some(line => /Usage: \/approve/.test(line)));
        assert.ok(output.some(line => line.includes(action.digest) && line.includes('precondition') && line.includes('expectedResult') && line.includes('synthetic-person')));
        assert.ok(output.some(line => line.includes('SYNTHETIC') && line.includes('\\u001b')));
        assert.ok(output.some(line => /new owner turn/i.test(line)));
        assert.equal(f.app.store.state('ws').actions[action.id].approval.expiresAt, new Date(Date.parse(now) + 600000).toISOString());
        assert.equal(f.app.store.state('ws').actions[action.id].status, 'approved');
    } finally { f.close(); }
});

test('review display is scoped to focused work and resets between terminal sessions', async () => {
    const f = fixture();
    try {
        const action = await prepared(f);
        await repl(f.app, ['/work work', '/actions', '/quit']);
        const output = await repl(f.app, ['/work work', `/approve ${action.id} ${action.digest}`, '/quit']);
        assert.ok(output.some(line => /Run \/actions.*review/i.test(line)));
        assert.equal(f.app.store.state('ws').actions[action.id].status, 'proposed');
        f.app.operator.createWork('ws', 'owner', { id: 'other', title: 'Other', goal: 'Other', threadId: 'thread' });
        const other = await repl(f.app, ['/work other', '/actions', `/approve ${action.id} ${action.digest}`, '/quit']);
        assert.ok(other.some(line => /focused work/i.test(line)));
    } finally { f.close(); }
});

test('terminal prepare, display, approve, new owner turn execute/verify and restart readback', async () => {
    const responses = [{ reply: 'Created synthetic work.', workProposals: [{ id: 'work', title: 'Synthetic work', goal: 'Change synthetic contact' }], factProposals: [] }, tool('prepare', args)];
    const f = fixture(responses);
    try {
        let action;
        const output = await repl(f.app, ['Create work', 'Prepare synthetic contact update', '/actions', () => {
            action = Object.values(f.app.store.state('ws').actions)[0];
            responses.push(tool('execute', { actionId: action.id }), tool('verify', { actionId: action.id }), final);
            return `/approve ${action.id} ${action.digest}`;
        }, 'Execute approved action and verify it', '/actions', '/quit']);
        assert.ok(output.some(line => /Owner approval/.test(line)));
        assert.equal(f.app.store.state('ws').actions[action.id].verification.status, 'satisfied');
        f.app.close();
        const reopened = openLocalAgent(f.opts);
        try {
            responses.push(tool('inspect', { actionId: action.id }), tool('verify', { actionId: action.id }), final);
            await repl(reopened, ['/work work', 'Inspect and verify the action after restart', '/quit']);
            assert.equal(reopened.store.state('ws').actions[action.id].verification.observation.providerVersion, 'contact:2');
            assert.equal(reopened.store.journal('ws').filter(record => record.event.type === 'action.started').length, 1);
        } finally { reopened.close(); }
    } finally { f.close(); }
});

for (const preapproved of [false, true]) {
    test(`fresh terminal resumes ${preapproved ? 'approved' : 'proposed'} action without invalidating work revision`, async () => {
        const responses = [];
        const f = fixture(responses);
        try {
            const action = await prepared(f);
            await repl(f.app, ['/work work', '/actions', ...(preapproved ? [`/approve ${action.id} ${action.digest}`] : []), '/quit']);
            const revision = f.app.store.state('ws').works.work.revision;
            f.app.close();
            const reopened = openLocalAgent(f.opts);
            try {
                responses.push(tool('execute', { actionId: action.id }), tool('verify', { actionId: action.id }), final);
                const output = await repl(reopened, ['/work work', '/actions',
                    ...(!preapproved ? [`/approve ${action.id} ${action.digest}`] : []), 'Execute approved action and verify', '/quit'], { initialThreadId: undefined });
                assert.equal(reopened.store.state('ws').works.work.revision, revision);
                assert.equal(reopened.store.state('ws').actions[action.id].verification.status, 'satisfied');
                assert.ok(output.some(line => /Resumed.*thread.*thread/i.test(line)));
                assert.equal(reopened.store.journal('ws').filter(record => record.event.type === 'action.started').length, 1);
            } finally { reopened.close(); }
        } finally { f.close(); }
    });
}
