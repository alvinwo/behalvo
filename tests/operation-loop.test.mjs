import { holdSqliteWriteLock } from './sqlite-lock-helper.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { SqliteStore, Operator, OperationService, OperationRegistry, AgentService, ServiceStorageError } from '../dist/index.js';

const final = (reply = 'Finished reading.') => ({ reply, workProposals: [], factProposals: [] });
const tool = (name, args = {}) => ({ tool: { name, arguments: args } });
function fixture(responses, options = {}) {
    const store = new SqliteStore(options.dbPath ?? ':memory:');
    store.createWorkspace('ws', 'owner');
    const operator = new Operator(store);
    for (const id of ['work', 'other']) operator.createWork('ws', 'owner', { id, title: id, goal: 'Synthetic change', threadId: 'thread' });
    const registry = new OperationRegistry();
    let state = { email: 'old@example.test' }, version = 1, calls = 0;
    const handler = {
        provider: 'synthetic', id: 'contact.update', version: '1',
        catalog: { description: 'Synthetic contact update', connectionKind: 'synthetic account', resourceIds: ['profile'],
            argumentsSchema: { type: 'object', required: ['email'], additionalProperties: false, properties: { email: { type: 'string' } } },
            exampleArguments: { email: 'new@example.test' } },
        validateArguments(args) { if (Object.keys(args).join() !== 'email' || typeof args.email !== 'string') throw new Error('Invalid arguments'); return args; },
        async identify({ connection }) { return connection.subject; },
        async observe() { return { state, providerVersion: `v${version}`, source: 'synthetic', observedAt: new Date().toISOString() }; },
        prepare({ arguments: args, observation }) { return { arguments: args, affectedResourceIds: [observation.resourceId], expectedResult: args }; },
        comparePrecondition({ expected, actual }) { return expected.providerVersion === actual.providerVersion; },
        async execute({ command }) { calls++; if (options.effect) return options.effect(); state = command.expectedResult; version++; return { status: options.outcome ?? 'accepted', evidence: 'Synthetic effect' }; },
        verify() { return { status: options.verdict ?? 'satisfied' }; }
    };
    registry.register(handler);
    const operations = new OperationService(store, registry);
    operations.registerConnection({ workspaceId: 'ws', ownerId: 'owner', connection: { id: 'account', provider: 'synthetic', subject: 'subject', label: 'SYNTHETIC' } });
    const requests = [];
    const gateway = { async listModels() { return []; }, async complete(request) {
        requests.push(request);
        const response = responses.shift();
        if (typeof response === 'function') return response(request);
        return { text: typeof response === 'string' ? response : JSON.stringify(response ?? final()) };
    } };
    const agent = new AgentService(store, gateway, undefined, { service: operations, registry, ...options.loop });
    let serial = 0;
    const run = (workId = 'work', overrides = {}) => agent.runOwnerTurn({ workspaceId: 'ws', ownerId: 'owner', threadId: 'thread',
        externalId: `turn-${++serial}`, text: 'Please perform the synthetic operation.', model: { provider: 'fake', model: 'one' }, ...(workId ? { workId } : {}), ...overrides });
    return { store, operations, registry, run, requests, responses, calls: () => calls };
}
const args = { connectionId: 'account', operationId: 'contact.update', operationVersion: '1', resourceId: 'profile', arguments: { email: 'new@example.test' } };
async function prepared(f, workId = 'work') {
    return f.operations.prepare({ workspaceId: 'ws', ownerId: 'owner', workId, key: `prepare-${workId}`, ...args });
}
function approve(f, action) {
    f.operations.approveBatch({ workspaceId: 'ws', ownerId: 'owner', expiresAt: new Date(Date.now() + 600000).toISOString(), approvals: [{ actionId: action.id, digest: action.digest }] });
}

test('catalog is usable; prepare stops durably for approval, later execution and verification share the effect boundary', async () => {
    const f = fixture([tool('catalog'), tool('prepare', args), final('must not run')]);
    try {
        const reply = await f.run();
        assert.match(reply.turn.reply, /approval|approve/i);
        assert.equal(f.requests.length, 2);
        assert.match(f.requests[1].prompt, /exampleArguments.*new@example.test/);
        assert.match(f.requests[1].prompt, /resourceIds.*profile/);
        assert.equal(f.store.inbox('ws').length, 0);
        const action = Object.values(f.store.state('ws').actions)[0];
        assert.equal(action.status, 'proposed'); assert.equal(f.calls(), 0);
        approve(f, action);
        f.responses.splice(0, 1, tool('execute', { actionId: action.id }), tool('verify', { actionId: action.id }), final());
        await f.run();
        assert.equal(f.calls(), 1);
        assert.equal(f.store.state('ws').actions[action.id].verification.status, 'satisfied');
        assert.equal(f.store.state('ws').works.work.phase, 'open');
    } finally { f.store.close(); }
});

for (const invalid of [tool('approve'), tool('shell'), { ...tool('catalog'), ...final() }, [tool('catalog')],
    { tool: { name: 'catalog' } }, tool('catalog', { ownerId: 'owner' }), tool('prepare', { ...args, workId: 'other' }),
    tool('prepare', { ...args, arguments: { email: 'x', credential: 'no' } }), tool('execute', { actionId: 'x', digest: 'x' })]) {
    test(`invalid protocol stops and completes inbox: ${JSON.stringify(invalid).slice(0, 85)}`, async () => {
        const f = fixture([invalid, final('must not run')]);
        try {
            const result = await f.run();
            assert.match(result.turn.reply, /stopped|invalid|rejected/i);
            assert.equal(f.requests.length, 1); assert.equal(f.calls(), 0);
            assert.equal(f.store.inbox('ws').length, 0);
        } finally { f.store.close(); }
    });
}
for (const name of ['inspect', 'execute', 'verify']) {
    test(`${name} rejects an action outside focused work and outside workspace`, async () => {
        const f = fixture([]);
        try {
            const action = await prepared(f, 'other'); approve(f, action);
            f.responses.push(tool(name, { actionId: action.id }));
            assert.match((await f.run()).turn.reply, /focused work/i);
            f.responses.push(tool(name, { actionId: 'foreign-workspace-action' }));
            assert.match((await f.run()).turn.reply, /not found/i);
            assert.equal(f.calls(), 0);
        } finally { f.store.close(); }
    });
}

test('without focused work catalog is available but action tools stop', async () => {
    const f = fixture([tool('catalog'), tool('prepare', args)]);
    try { assert.match((await f.run(null)).turn.reply, /focus.*work/i); assert.equal(f.calls(), 0); }
    finally { f.store.close(); }
});

test('every model completion counts toward eight, and stopping is durable', async () => {
    const f = fixture(Array.from({ length: 9 }, () => tool('catalog')));
    try { assert.match((await f.run()).turn.reply, /eight|8.*completion/i); assert.equal(f.requests.length, 8); assert.equal(f.store.inbox('ws').length, 0); }
    finally { f.store.close(); }
});

test('response and accumulated request size bounds stop before another model call', async () => {
    const f = fixture(['x'.repeat(65537)]);
    try { assert.match((await f.run()).turn.reply, /size|large|limit/i); assert.equal(f.requests.length, 1); }
    finally { f.store.close(); }
    const g = fixture(Array.from({ length: 9 }, () => tool('catalog')), { loop: { maxRequestBytes: 7000 } });
    try { assert.match((await g.run()).turn.reply, /size|large|limit/i); assert.ok(g.requests.length < 8); }
    finally { g.store.close(); }
});

test('late model completion cannot write proposals or a second reply after deadline', async () => {
    let release;
    const f = fixture([() => new Promise(resolve => { release = resolve; })], { loop: { timeoutMs: 10 } });
    try {
        const result = await f.run();
        assert.match(result.turn.reply, /deadline.*dispatch|dispatch.*deadline/i);
        assert.equal(f.store.inbox('ws').length, 0);
        const before = f.store.journal('ws').length;
        release({ text: JSON.stringify({ ...final(), workProposals: [{ id: 'late', title: 'Late', goal: 'Late' }] }) });
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(f.store.journal('ws').length, before);
        assert.equal(f.store.state('ws').works.late, undefined);
    } finally { f.store.close(); }
});
for (const outcome of ['unknown', 'failed']) {
    test(`${outcome} stops immediately without a retry or replacement preparation`, async () => {
        const f = fixture([], { outcome });
        try {
            const action = await prepared(f); approve(f, action);
            f.responses.push(tool('execute', { actionId: action.id }), tool('prepare', args));
            assert.match((await f.run()).turn.reply, new RegExp(outcome));
            assert.equal(f.requests.length, 1); assert.equal(f.calls(), 1);
            assert.equal(Object.keys(f.store.state('ws').actions).length, 1);
        } finally { f.store.close(); }
    });
}
test('unsuccessful readback stops and acceptance never completes work', async () => {
    const f = fixture([], { verdict: 'not_satisfied' });
    try {
        const action = await prepared(f); approve(f, action);
        f.responses.push(tool('execute', { actionId: action.id }), tool('verify', { actionId: action.id }), final('must not run'));
        assert.match((await f.run()).turn.reply, /not_satisfied/);
        assert.equal(f.requests.length, 2); assert.equal(f.store.state('ws').works.work.phase, 'open');
    } finally { f.store.close(); }
});

test('provider and handler errors never copy secret-bearing exception text into durable replies', async () => {
    const sentinel = 'SECRET_SENTINEL_TOKEN_123';
    const f = fixture([() => { throw new Error(`gateway ${sentinel}`); }]);
    try {
        const result = await f.run();
        assert.equal(result.turn.reply.includes(sentinel), false);
        const record = f.store.journal('ws').find(record => record.id === result.assistantRecordId);
        assert.equal(f.store.readArtifact('ws', record.event.data.artifactId).includes(sentinel), false);
        f.operations.prepare = async () => { throw new Error(`handler ${sentinel}`); };
        f.responses.push(tool('prepare', args));
        assert.equal((await f.run()).turn.reply.includes(sentinel), false);
    } finally { f.store.close(); }
});

test('loop-enabled final proposal rejection finishes owner inbox with a safe durable reply', async () => {
    const f = fixture([{ ...final(), factProposals: [{ id: 'bad', subject: 'owner', predicate: 'city', value: 'X', validFrom: '2020-01-01T00:00:00Z' }] }]);
    try {
        assert.match((await f.run()).turn.reply, /stopped|invalid|rejected/i);
        assert.equal(f.store.inbox('ws').length, 0);
        assert.equal(f.store.state('ws').facts.bad, undefined);
    } finally { f.store.close(); }
});

test('direct operation loop rejects wrong owner before any inference or context disclosure', async () => {
    const { OperationLoop } = await import('../dist/runtime/operation-loop.js');
    const f = fixture([]);
    let calls = 0;
    try {
        const loop = new OperationLoop(f.store, { service: f.operations, registry: f.registry });
        await assert.rejects(loop.run({ async complete() { calls++; return { text: JSON.stringify(final()) }; } },
            { model: { provider: 'fake', model: 'one' }, system: 'private', prompt: 'private' },
            { workspaceId: 'ws', ownerId: 'intruder', ownerRecordId: 'record', workId: 'work' }), /owner/i);
        assert.equal(calls, 0);
    } finally { f.store.close(); }
});

test('trusted storage integrity faults escape the broad model and tool stop boundary', async () => {
    const { OperationLoop } = await import('../dist/runtime/operation-loop.js');
    const f = fixture([]);
    const originalState = f.store.state.bind(f.store);
    let reads = 0;
    f.store.state = (...args) => {
        reads++;
        if (reads === 2) throw new ServiceStorageError('integrity', 'Fixed synthetic storage fault');
        return originalState(...args);
    };
    try {
        const loop = new OperationLoop(f.store, { service: f.operations, registry: f.registry });
        await assert.rejects(loop.run({ async complete() { return { text: JSON.stringify(tool('catalog')) }; } },
            { model: { provider: 'fake', model: 'one' }, system: 'private', prompt: 'private' },
            { workspaceId: 'ws', ownerId: 'owner', ownerRecordId: 'record', workId: 'work' }),
            error => error.code === 'integrity');
    } finally { f.store.close(); }
});

test('caller context budget caps full accumulated loop requests even below configured hard cap', async () => {
    const f = fixture(Array.from({ length: 9 }, () => tool('catalog')));
    try {
        const result = await f.run('work', { windowTokens: 8500, outputReserve: 1500 });
        assert.match(result.turn.reply, /size.*limit/i);
        assert.ok(f.requests.length > 0 && f.requests.length < 8);
        assert.ok(f.requests.every(request => Buffer.byteLength(JSON.stringify(request)) <= 7000));
    } finally { f.store.close(); }
});

test('in-flight loop deadline settles the action before durable reply and discards late effect success after close', async () => {
    let resolveLate;
    const f = fixture([], { loop: { timeoutMs: 10 }, effect: () => new Promise(resolve => { resolveLate = resolve; }) });
    const action = await prepared(f); approve(f, action);
    f.responses.push(tool('execute', { actionId: action.id }));
    const result = await f.run();
    assert.match(result.turn.reply, /deadline after dispatch started/i);
    assert.equal(f.store.state('ws').actions[action.id].status, 'unknown');
    assert.equal(f.store.inbox('ws').length, 0);
    f.store.close();
    resolveLate({ status: 'accepted', evidence: 'Late synthetic effect' });
    await new Promise(resolve => setImmediate(resolve));
});

test('tool and final envelopes require every documented field', async () => {
    for (const response of [{ reply: 'missing arrays' }, { tool: { arguments: {} } }, tool('prepare', { ...args, arguments: undefined })]) {
        const f = fixture([response]);
        try { assert.match((await f.run()).turn.reply, /stopped/i); assert.equal(f.store.inbox('ws').length, 0); }
        finally { f.store.close(); }
    }
});

test('reducer-only proposal errors produce a durable safe stop without partial work or facts', async () => {
    const f = fixture([{ ...final(), workProposals: [{ id: 'discard', title: 'Discard', goal: 'No partial commit' }],
        factProposals: [{ id: 'bad-range', subject: 'owner', predicate: 'city', value: 'X', validFrom: '2021-01-01T00:00:00Z', validTo: '2020-01-01T00:00:00Z' }] }]);
    try {
        const result = await f.run('work', { text: '2021-01-01T00:00:00Z to 2020-01-01T00:00:00Z' });
        assert.match(result.turn.reply, /stopped/i);
        assert.equal(f.store.inbox('ws').length, 0);
        assert.equal(f.store.state('ws').facts['bad-range'], undefined);
        assert.equal(f.store.state('ws').works.discard, undefined);
    } finally { f.store.close(); }
});

test('long history trims against the full escaped request while preserving current input and room for tools', async () => {
    for (const priorText of ['x'.repeat(2000), 'quote:" slash:\\ newline:\n'.repeat(90)]) {
        const f = fixture([tool('catalog'), final('History trimmed; turn handled.')]);
        try {
            for (let i = 0; i < 40; i++) f.store.ingest('ws', { source: 'owner:local', externalId: `prior-${i}`, threadId: 'thread',
                senderId: 'owner', senderRole: 'owner', text: priorText });
            const current = 'CURRENT_UNIQUE_INPUT "quoted" \\ with newline\nPlease list operations.';
            const result = await f.run('work', { text: current });
            assert.equal(f.requests.length, 2);
            assert.equal(result.turn.reply, 'History trimmed; turn handled.');
            assert.ok(result.context.omittedMessageCount > 0);
            assert.ok(result.context.includedRecordIds.includes(result.ownerRecordId));
            for (const request of f.requests) {
                assert.ok(Buffer.byteLength(JSON.stringify(request)) <= 56000);
                assert.ok(request.prompt.includes(JSON.stringify(current)));
            }
        } finally { f.store.close(); }
    }
});

test('deadline crossing during assistant artifact persistence cannot commit final proposals or model reply', async () => {
    const originalNow = Date.now;
    let now = originalNow();
    Date.now = () => now;
    const f = fixture([{ ...final('LATE_MODEL_REPLY'), workProposals: [{ id: 'late-at-commit', title: 'Late', goal: 'Must not commit' }] }]);
    try {
        const originalPut = f.store.putArtifact.bind(f.store);
        f.store.putArtifact = (...args) => {
            const id = originalPut(...args);
            if (args[1] === 'LATE_MODEL_REPLY') now += 120001;
            return id;
        };
        const result = await f.run();
        assert.match(result.turn.reply, /deadline/i);
        assert.notEqual(result.turn.reply, 'LATE_MODEL_REPLY');
        assert.equal(f.store.state('ws').works['late-at-commit'], undefined);
        assert.equal(f.store.inbox('ws').length, 0);
        const replies = f.store.journal('ws').filter(record => record.event.type === 'message.received' && record.event.data.senderRole === 'agent');
        assert.equal(replies.length, 1);
        assert.equal(f.store.readArtifact('ws', replies[0].event.data.artifactId), result.turn.reply);
    } finally { f.store.close(); Date.now = originalNow; }
});

test('application deadline timer is classified as timeout even before the wall clock reaches its threshold', async () => {
    const originalNow = Date.now;
    const frozenNow = originalNow();
    Date.now = () => frozenNow;
    const f = fixture([() => new Promise(() => {})], { loop: { timeoutMs: 10 } });
    try {
        const result = await f.run();
        assert.match(result.turn.reply, /deadline before any new dispatch/i);
        assert.equal(f.requests.length, 1);
        assert.equal(f.store.inbox('ws').length, 0);
    } finally { f.store.close(); Date.now = originalNow; }
});

test('final inbox deadline is rechecked inside the acquired SQLite transaction', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'behalvo-final-lock-'));
    const path = join(dir, 'journal.db');
    const f = fixture([{ ...final('MODEL_FINAL_AFTER_LOCK'), workProposals: [{ id: 'late-lock', title: 'Late', goal: 'Must not commit' }] }],
        { dbPath: path, loop: { timeoutMs: 1000 } });
    let lockFinished;
    try {
        const originalComplete = f.store.completeInbox.bind(f.store);
        f.store.completeInbox = (...args) => {
            if (!lockFinished) lockFinished = holdSqliteWriteLock(path, 1200);
            return originalComplete(...args);
        };
        const result = await f.run();
        assert.ok(lockFinished);
        assert.match(result.turn.reply, /deadline/i);
        assert.notEqual(result.turn.reply, 'MODEL_FINAL_AFTER_LOCK');
        assert.equal(f.store.state('ws').works['late-lock'], undefined);
        assert.equal(f.store.inbox('ws').length, 0);
        const replies = f.store.journal('ws').filter(record => record.event.type === 'message.received' && record.event.data.senderRole === 'agent');
        assert.equal(replies.length, 1);
        assert.equal(replies[0].event.data.source, 'agent:application');
    } finally { f.store.close(); if (lockFinished) await lockFinished; rmSync(dir, { recursive: true, force: true }); }
});
