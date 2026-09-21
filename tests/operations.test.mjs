import { holdSqliteWriteLock } from './sqlite-lock-helper.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SqliteStore, Operator, OperationRegistry, OperationService, ServiceStorageError } from '../dist/index.js';

const NOW = '2026-09-09T12:00:00.000Z';
const EXPIRY = '2026-09-09T13:00:00.000Z';

function setup(options = {}) {
    const clock = options.clock ?? { value: NOW };
    const store = new SqliteStore(options.path ?? ':memory:');
    if (!options.existing) store.createWorkspace('personal', 'owner');
    const operator = new Operator(store, () => clock.value);
    if (!options.existing) operator.createWork('personal', 'owner', {
        id: 'work', title: 'Change a profile', goal: 'Observe the desired profile state', threadId: 'thread'
    });
    const remote = options.remote ?? new Map([
        ['subject-a/profile', { state: { city: 'Oldtown' }, version: 'v1' }],
        ['subject-a/preferences', { state: { theme: 'light' }, version: 'v1' }],
        ['subject-b/profile', { state: { city: 'Elsewhere' }, version: 'v1' }]
    ]);
    const controls = options.controls ?? { identifyCalls: 0, observeCalls: 0, executeCalls: 0, verifyCalls: 0 };
    const handler = {
        provider: 'synthetic-provider', id: 'profile.update', version: '1',
        validateArguments(value) {
            if (!value || typeof value !== 'object' || Array.isArray(value) ||
                Object.keys(value).length !== 1 || typeof value.city !== 'string') throw new Error('Invalid profile arguments');
            return { city: value.city };
        },
        async identify({ connection }) {
            controls.identifyCalls++;
            if (controls.onIdentify) await controls.onIdentify(connection);
            return controls.identity ?? connection.subject;
        },
        async observe({ connection, resourceId }) {
            controls.observeCalls++;
            if (controls.onObserve) await controls.onObserve(connection, resourceId);
            const row = remote.get(`${connection.subject}/${resourceId}`);
            if (!row) throw new Error('Synthetic resource not found');
            return {
                source: 'synthetic-api', observedAt: controls.observedAt ?? clock.value,
                state: structuredClone(row.state), providerVersion: controls.providerVersion ?? row.version,
                ...(controls.observedResourceId ? { resourceId: controls.observedResourceId } : {})
            };
        },
        prepare({ arguments: args, observation }) {
            return {
                arguments: args,
                affectedResourceIds: [observation.resourceId],
                expectedResult: { city: args.city }
            };
        },
        comparePrecondition({ expected, actual }) {
            return expected.providerVersion === actual.providerVersion &&
                JSON.stringify(expected.state) === JSON.stringify(actual.state);
        },
        async execute({ command, connection }) {
            controls.executeCalls++;
            if (controls.onExecute) return controls.onExecute(command, connection);
            const row = remote.get(`${connection.subject}/${command.resourceId}`);
            row.state = structuredClone(command.expectedResult);
            row.version = `v${Number(row.version.slice(1)) + 1}`;
            return { status: 'accepted', evidence: 'Synthetic provider accepted the operation.' };
        },
        verify({ command, observation }) {
            controls.verifyCalls++;
            if (controls.verdict !== undefined) return controls.verdict;
            return {
                status: JSON.stringify(command.expectedResult) === JSON.stringify(observation.state)
                    ? 'satisfied' : 'not_satisfied'
            };
        }
    };
    const registry = new OperationRegistry();
    registry.register(handler);
    const service = new OperationService(store, registry, () => clock.value);
    return { store, operator, registry, service, handler, remote, controls, clock };
}

function registerConnection(f, id = 'connection-a', subject = 'subject-a') {
    return f.service.registerConnection({ workspaceId: 'personal', ownerId: 'owner', connection: {
        id, provider: 'synthetic-provider', subject, label: id
    } });
}

async function prepare(f, extra = {}) {
    return f.service.prepare({
        workspaceId: 'personal', ownerId: 'owner', workId: 'work', key: 'profile-change',
        connectionId: 'connection-a', operationId: 'profile.update', operationVersion: '1',
        resourceId: 'profile', arguments: { city: 'Newtown' }, ...extra
    });
}

function approve(f, action, extra = {}) {
    return f.service.approveBatch({
        workspaceId: 'personal', ownerId: 'owner', expiresAt: EXPIRY,
        approvals: [{ actionId: action.id, digest: action.digest }], ...extra
    });
}

test('general operations expose a separate trusted runtime while preserving work ownership', () => {
    const store = new SqliteStore(':memory:');
    try {
        store.createWorkspace('personal', 'owner');
        const operator = new Operator(store);
        const registry = new OperationRegistry();
        const service = new OperationService(store, registry);
        assert.equal(typeof service.prepare, 'function');
        assert.equal(operator.createWork('personal', 'owner', {
            id: 'work', title: 'Change a profile', goal: 'Observe the desired profile state', threadId: 'thread'
        }).phase, 'open');
    } finally {
        store.close();
    }
});

test('prepare records an immutable concrete operation without executing it', async () => {
    const f = setup();
    try {
        registerConnection(f);
        const action = await prepare(f);
        assert.equal(f.controls.executeCalls, 0);
        assert.equal(action.status, 'proposed');
        assert.deepEqual(action.command, {
            kind: 'operation.execute', operationId: 'profile.update', operationVersion: '1',
            connectionId: 'connection-a', provider: 'synthetic-provider', subject: 'subject-a',
            connectionGeneration: 1, resourceId: 'profile', arguments: { city: 'Newtown' },
            affectedResourceIds: ['profile'],
            precondition: { state: { city: 'Oldtown' }, providerVersion: 'v1',
                source: 'synthetic-api', observedAt: NOW },
            expectedResult: { city: 'Newtown' }, subjectRevision: 0,
            requestFingerprint: action.command.requestFingerprint
        });
        assert.equal(f.store.state('personal').connections['connection-a'].status, 'active');
    } finally { f.store.close(); }
});

test('retrying an identical preparation key recovers the original action despite a later observation time', async () => {
    const f = setup();
    try {
        registerConnection(f);
        const original = await prepare(f);
        f.clock.value = '2026-09-09T12:02:00.000Z';
        const recovered = await prepare(f);
        assert.equal(recovered.id, original.id);
        assert.equal(recovered.digest, original.digest);
        assert.equal(f.controls.observeCalls, 1);
        await assert.rejects(prepare(f, { arguments: { city: 'Different' } }), /key|collision|request/i);
    } finally { f.store.close(); }
});

test('concurrent identical preparations recover one action despite different observation times', async () => {
    let milliseconds = Date.parse(NOW);
    const clock = { get value() { return new Date(milliseconds++).toISOString(); } };
    const f = setup({ clock });
    try {
        registerConnection(f);
        const [first, second] = await Promise.all([prepare(f), prepare(f)]);
        assert.equal(second.id, first.id);
        assert.equal(second.digest, first.digest);
        assert.equal(f.controls.observeCalls, 2);
        assert.equal(Object.keys(f.store.state('personal').actions).length, 1);
    } finally { f.store.close(); }
});

test('proposal append collisions recover only the identical prepared request', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'behalvo-operation-proposal-race-'));
    const path = join(dir, 'operations.db');
    const f = setup({ path });
    const secondStore = new SqliteStore(path);
    try {
        registerConnection(f);
        const originalAppend = f.store.append.bind(f.store);
        let injected = false;
        f.store.append = (workspaceId, expectedVersion, events, metadata) => {
            if (!injected && events.some(event => event.type === 'action.proposed')) {
                injected = true;
                secondStore.append(workspaceId, expectedVersion, events, metadata);
            }
            return originalAppend(workspaceId, expectedVersion, events, metadata);
        };
        const action = await prepare(f);
        assert.equal(action.status, 'proposed');
        assert.equal(Object.keys(f.store.state('personal').actions).length, 1);
    } finally {
        secondStore.close(); f.store.close(); rmSync(dir, { recursive: true, force: true });
    }
});

test('approval, execution and verification use the exact handler and leave WorkItem completion to Operator', async () => {
    const f = setup();
    try {
        registerConnection(f);
        const action = await prepare(f);
        approve(f, action);
        assert.equal((await f.service.execute({ workspaceId: 'personal', ownerId: 'owner', actionId: action.id })).status, 'accepted');
        const verified = await f.service.verify({ workspaceId: 'personal', ownerId: 'owner', actionId: action.id });
        assert.equal(verified.verification.status, 'satisfied');
        assert.equal(f.store.state('personal').works.work.phase, 'open');
        assert.equal(f.controls.executeCalls, 1);
    } finally { f.store.close(); }
});

test('known outcomes survive concurrent writes from another SQLite connection without redispatch', async t => {
    for (const status of ['accepted', 'failed', 'unknown']) {
        await t.test(status, async () => {
            const dir = mkdtempSync(join(tmpdir(), `behalvo-operation-outcome-${status}-`));
            const path = join(dir, 'operations.db');
            const f = setup({ path });
            const secondStore = new SqliteStore(path);
            try {
                registerConnection(f);
                const action = await prepare(f); approve(f, action);
                f.controls.onExecute = async () => ({ status, evidence: `Synthetic ${status} outcome.` });
                const secondOperator = new Operator(secondStore, () => NOW);
                let injected = false;
                const appendConcurrentWork = () => {
                    if (injected) return;
                    injected = true;
                    secondOperator.createWork('personal', 'owner', {
                        id: `concurrent-${status}`, title: 'Concurrent write',
                        goal: 'Advance the workspace from another connection', threadId: 'other-thread'
                    });
                };

                const originalFinish = f.store.finishActionAttempt?.bind(f.store);
                f.store.finishActionAttempt = (...args) => {
                    appendConcurrentWork();
                    return originalFinish(...args);
                };
                let artifactPersisted = false;
                const originalPutArtifact = f.store.putArtifact.bind(f.store);
                f.store.putArtifact = (...args) => {
                    const ref = originalPutArtifact(...args);
                    artifactPersisted = true;
                    return ref;
                };
                const originalState = f.store.state.bind(f.store);
                f.store.state = (...args) => {
                    const state = originalState(...args);
                    if (artifactPersisted) appendConcurrentWork();
                    return state;
                };

                const completed = await f.service.execute({
                    workspaceId: 'personal', ownerId: 'owner', actionId: action.id
                });
                assert.equal(completed.status, status);
                assert.equal(f.store.readArtifact('personal', completed.evidenceRef), `Synthetic ${status} outcome.`);
                assert.ok(f.store.state('personal').works[`concurrent-${status}`]);
                assert.equal((await f.service.execute({
                    workspaceId: 'personal', ownerId: 'owner', actionId: action.id
                })).status, status);
                assert.equal(f.controls.executeCalls, 1);
            } finally {
                secondStore.close(); f.store.close(); rmSync(dir, { recursive: true, force: true });
            }
        });
    }
});

test('finishing a stale attempt preserves a legitimately settled outcome and evidence', async () => {
    const f = setup();
    try {
        registerConnection(f);
        const action = await prepare(f); approve(f, action);
        f.controls.onExecute = async () => ({ status: 'failed', evidence: 'Original rejected outcome.' });
        const completed = await f.service.execute({ workspaceId: 'personal', ownerId: 'owner', actionId: action.id });
        const before = structuredClone(completed);
        assert.equal(f.store.finishActionAttempt('personal', action.id, 'stale-attempt', 'unknown',
            'Stale worker outcome.', { recordedAt: NOW }), false);
        const after = f.store.state('personal').actions[action.id];
        assert.equal(after.status, 'failed');
        assert.equal(after.attemptId, before.attemptId);
        assert.equal(after.evidenceRef, before.evidenceRef);
        assert.equal(f.store.readArtifact('personal', after.evidenceRef), 'Original rejected outcome.');
    } finally { f.store.close(); }
});

test('connections isolate subjects while aliases of one subject share a conflict scope', async () => {
    const f = setup();
    try {
        registerConnection(f);
        registerConnection(f, 'connection-b', 'subject-b');
        registerConnection(f, 'connection-alias', 'subject-a');
        const first = await prepare(f);
        const distinct = await prepare(f, { key: 'other-subject', connectionId: 'connection-b' });
        approve(f, first); approve(f, distinct);
        await f.service.execute({ workspaceId: 'personal', ownerId: 'owner', actionId: first.id });
        await f.service.execute({ workspaceId: 'personal', ownerId: 'owner', actionId: distinct.id });
        await assert.rejects(prepare(f, {
            key: 'alias-change', connectionId: 'connection-alias', arguments: { city: 'Again' }
        }), /barrier|verification|scope/i);
    } finally { f.store.close(); }
});

test('remote identity changes and connection changes during asynchronous preflight prevent proposal or dispatch', async () => {
    const f = setup();
    try {
        registerConnection(f);
        f.controls.identity = 'switched-subject';
        await assert.rejects(prepare(f), /identity|subject/i);
        f.controls.identity = undefined;
        f.controls.onObserve = async () => {
            f.controls.onObserve = undefined;
            f.service.registerConnection({ workspaceId: 'personal', ownerId: 'owner', connection: {
                id: 'connection-a', provider: 'synthetic-provider', subject: 'subject-a', label: 'rebound label'
            } });
        };
        await assert.rejects(prepare(f, { key: 'changed-binding' }), /generation|connection|binding/i);
    } finally { f.store.close(); }
});

test('registry rejects duplicates and unavailable exact versions before dispatch', async () => {
    const f = setup();
    try {
        assert.throws(() => f.registry.register(f.handler), /duplicate|registered/i);
        registerConnection(f);
        await assert.rejects(prepare(f, { operationVersion: '2' }), /handler|version|registered/i);
        assert.equal(f.controls.executeCalls, 0);
    } finally { f.store.close(); }
});

test('registry discovery returns sorted workspace-neutral metadata without exposing handlers', () => {
    const f = setup();
    try {
        assert.deepEqual(f.registry.list(), [{ provider: 'synthetic-provider', id: 'profile.update', version: '1' }]);
        assert.deepEqual(f.registry.list({ provider: 'other-provider' }), []);
        assert.equal('execute' in f.registry.list()[0], false);
    } finally { f.store.close(); }
});

test('batch approval is atomic and binds every exact digest and expiry', async () => {
    const f = setup();
    try {
        registerConnection(f);
        registerConnection(f, 'connection-b', 'subject-b');
        const a = await prepare(f);
        const b = await prepare(f, { key: 'other', connectionId: 'connection-b' });
        assert.throws(() => f.service.approveBatch({
            workspaceId: 'personal', ownerId: 'owner', expiresAt: EXPIRY,
            approvals: [{ actionId: a.id, digest: a.digest }, { actionId: b.id, digest: 'wrong' }]
        }), /digest/i);
        assert.equal(f.store.state('personal').actions[a.id].status, 'proposed');
        f.clock.value = EXPIRY;
        assert.throws(() => approve(f, a), /expired/i);
    } finally { f.store.close(); }
});

test('stale preconditions stop execution before the trusted handler mutates state', async () => {
    const f = setup();
    try {
        registerConnection(f);
        const a = await prepare(f); approve(f, a);
        f.remote.get('subject-a/profile').state = { city: 'External change' };
        f.remote.get('subject-a/profile').version = 'v2';
        await assert.rejects(f.service.execute({ workspaceId: 'personal', ownerId: 'owner', actionId: a.id }), /precondition|stale/i);
        assert.equal(f.controls.executeCalls, 0);
    } finally { f.store.close(); }
});

test('approval expiry and dispatch-time connection revocation are rechecked after approval', async () => {
    const expired = setup();
    try {
        registerConnection(expired);
        const a = await prepare(expired); approve(expired, a);
        expired.clock.value = EXPIRY;
        await assert.rejects(expired.service.execute({ workspaceId: 'personal', ownerId: 'owner', actionId: a.id }), /expired/i);
        assert.equal(expired.controls.executeCalls, 0);
    } finally { expired.store.close(); }

    const revoked = setup();
    try {
        registerConnection(revoked);
        const a = await prepare(revoked); approve(revoked, a);
        revoked.controls.onObserve = async () => {
            revoked.controls.onObserve = undefined;
            revoked.service.revokeConnection({ workspaceId: 'personal', ownerId: 'owner', connectionId: 'connection-a' });
        };
        await assert.rejects(revoked.service.execute({ workspaceId: 'personal', ownerId: 'owner', actionId: a.id }), /revoked|connection|generation/i);
        assert.equal(revoked.controls.executeCalls, 0);
    } finally { revoked.store.close(); }

    const rebound = setup();
    try {
        registerConnection(rebound);
        const a = await prepare(rebound); approve(rebound, a);
        rebound.controls.onIdentify = async () => {
            rebound.controls.onIdentify = undefined;
            rebound.service.registerConnection({ workspaceId: 'personal', ownerId: 'owner', connection: {
                id: 'connection-a', provider: 'synthetic-provider', subject: 'subject-a', label: 'new binding generation'
            } });
        };
        await assert.rejects(rebound.service.execute({ workspaceId: 'personal', ownerId: 'owner', actionId: a.id }), /connection|generation|binding/i);
        assert.equal(rebound.controls.executeCalls, 0);
    } finally { rebound.store.close(); }
});

test('two runtime instances serialize attempts through the shared SQLite subject barrier', async () => {
    const f = setup();
    try {
        registerConnection(f);
        f.operator.createWork('personal', 'owner', {
            id: 'other-work', title: 'Concurrent profile change', goal: 'Observe another desired state', threadId: 'thread'
        });
        const a = await prepare(f);
        const b = await prepare(f, { workId: 'other-work', key: 'concurrent', arguments: { city: 'Concurrent' } });
        f.service.approveBatch({ workspaceId: 'personal', ownerId: 'owner', expiresAt: EXPIRY,
            approvals: [{ actionId: a.id, digest: a.digest }, { actionId: b.id, digest: b.digest }] });
        let release;
        const dispatched = new Promise(resolve => { release = resolve; });
        const outcome = new Promise(resolve => {
            f.controls.onExecute = async () => { release(); return new Promise(resolveOutcome => { f.controls.resolveOutcome = resolveOutcome; }); };
            resolve();
        });
        await outcome;
        const secondService = new OperationService(f.store, f.registry, () => f.clock.value);
        const firstRun = f.service.execute({ workspaceId: 'personal', ownerId: 'owner', actionId: a.id });
        await dispatched;
        await assert.rejects(secondService.execute({ workspaceId: 'personal', ownerId: 'owner', actionId: b.id }), /barrier|scope|revision/i);
        f.controls.resolveOutcome({ status: 'accepted', evidence: 'Synthetic completion.' });
        await firstRun;
        assert.equal(f.controls.executeCalls, 1);
    } finally { f.store.close(); }
});

test('preparation rejects an intervening settled attempt in the same subject scope', async () => {
    const f = setup();
    try {
        registerConnection(f);
        const first = await prepare(f); approve(f, first);
        let releaseObservation;
        let signalObservation;
        const observationStarted = new Promise(resolve => { signalObservation = resolve; });
        const observationRelease = new Promise(resolve => { releaseObservation = resolve; });
        f.controls.onObserve = async (_connection, resourceId) => {
            if (resourceId === 'preferences') {
                signalObservation();
                await observationRelease;
            }
        };
        const pendingPreparation = prepare(f, {
            key: 'preferences-change', resourceId: 'preferences', arguments: { city: 'Unrelated' }
        });
        let timeout;
        try {
            await Promise.race([observationStarted, new Promise((_, reject) => {
                timeout = setTimeout(() => reject(new Error('preparation observation did not start')), 1000);
            })]);
        } finally { clearTimeout(timeout); }
        await f.service.execute({ workspaceId: 'personal', ownerId: 'owner', actionId: first.id });
        await f.service.verify({ workspaceId: 'personal', ownerId: 'owner', actionId: first.id });
        releaseObservation();
        await assert.rejects(pendingPreparation, /scope|revision|changed|fresh/i);
    } finally { f.store.close(); }
});

test('preparation is blocked during unresolved subject outcomes and succeeds only after settlement', async () => {
    const f = setup();
    try {
        registerConnection(f);
        f.controls.onExecute = async () => { throw new Error('lost response'); };
        const first = await prepare(f); approve(f, first);
        await f.service.execute({ workspaceId: 'personal', ownerId: 'owner', actionId: first.id });
        await assert.rejects(prepare(f, {
            key: 'during-unknown', resourceId: 'preferences', arguments: { city: 'Blocked' }
        }), /barrier|unresolved|scope/i);
        f.service.reconcile({ workspaceId: 'personal', ownerId: 'owner', actionId: first.id,
            status: 'failed', evidence: 'Owner confirmed no synthetic change.' });
        assert.equal((await prepare(f, {
            key: 'after-settlement', resourceId: 'preferences', arguments: { city: 'Allowed' }
        })).command.subjectRevision, 1);
    } finally { f.store.close(); }
});

test('unknown and accepted-but-unverified attempts retain the subject conflict barrier', async () => {
    const f = setup();
    try {
        registerConnection(f);
        f.controls.onExecute = async () => { throw new Error('response lost'); };
        const a = await prepare(f); approve(f, a);
        assert.equal((await f.service.execute({ workspaceId: 'personal', ownerId: 'owner', actionId: a.id })).status, 'unknown');
        await assert.rejects(prepare(f, {
            key: 'replacement', arguments: { city: 'Replacement' }
        }), /barrier|unknown|scope/i);
        assert.equal(f.controls.executeCalls, 1);
    } finally { f.store.close(); }

    const accepted = setup();
    try {
        registerConnection(accepted);
        const a = await prepare(accepted); approve(accepted, a);
        await accepted.service.execute({ workspaceId: 'personal', ownerId: 'owner', actionId: a.id });
        await assert.rejects(prepare(accepted, {
            key: 'replacement', arguments: { city: 'Replacement' }
        }), /barrier|verification|scope/i);
    } finally { accepted.store.close(); }
});

test('verification requires fresh scoped evidence and a strict trusted verdict', async () => {
    const f = setup();
    try {
        registerConnection(f);
        const a = await prepare(f); approve(f, a);
        await f.service.execute({ workspaceId: 'personal', ownerId: 'owner', actionId: a.id });
        f.controls.verdict = { status: true };
        await assert.rejects(f.service.verify({ workspaceId: 'personal', ownerId: 'owner', actionId: a.id }), /verdict|status|invalid/i);
        f.controls.verdict = { status: 'satisfied' };
        f.controls.observedAt = '2026-09-09T10:00:00.000Z';
        await assert.rejects(f.service.verify({ workspaceId: 'personal', ownerId: 'owner', actionId: a.id }), /stale|observation/i);
        f.controls.observedAt = undefined;
        f.controls.observedResourceId = 'other';
        await assert.rejects(f.service.verify({ workspaceId: 'personal', ownerId: 'owner', actionId: a.id }), /resource|scope/i);
    } finally { f.store.close(); }
});

test('unavailable readback cannot mark an action satisfied', async () => {
    const f = setup();
    try {
        registerConnection(f);
        const a = await prepare(f); approve(f, a);
        await f.service.execute({ workspaceId: 'personal', ownerId: 'owner', actionId: a.id });
        f.remote.delete('subject-a/profile');
        await assert.rejects(f.service.verify({ workspaceId: 'personal', ownerId: 'owner', actionId: a.id }), /not found|unavailable/i);
        assert.equal(f.store.state('personal').actions[a.id].verification, undefined);
    } finally { f.store.close(); }
});

test('oversized observation metadata cannot be persisted as verification evidence', async () => {
    const f = setup();
    try {
        registerConnection(f);
        const a = await prepare(f); approve(f, a);
        await f.service.execute({ workspaceId: 'personal', ownerId: 'owner', actionId: a.id });
        f.controls.providerVersion = 'x'.repeat(300000);
        const before = f.store.journal('personal').length;
        await assert.rejects(f.service.verify({ workspaceId: 'personal', ownerId: 'owner', actionId: a.id }), /observation|provider version|size|large|limit/i);
        assert.equal(f.store.journal('personal').length, before);
        assert.equal(f.store.state('personal').actions[a.id].verification, undefined);
    } finally { f.store.close(); }
});

test('a nonterminal verification verdict can be replaced by later fresh satisfied readback', async () => {
    const f = setup();
    try {
        registerConnection(f);
        const a = await prepare(f); approve(f, a);
        await f.service.execute({ workspaceId: 'personal', ownerId: 'owner', actionId: a.id });
        f.controls.verdict = { status: 'not_satisfied' };
        assert.equal((await f.service.verify({ workspaceId: 'personal', ownerId: 'owner', actionId: a.id })).verification.status, 'not_satisfied');
        f.controls.verdict = { status: 'satisfied' };
        assert.equal((await f.service.verify({ workspaceId: 'personal', ownerId: 'owner', actionId: a.id })).verification.status, 'satisfied');
    } finally { f.store.close(); }
});

test('observations predating the current read request are rejected even inside the freshness window', async () => {
    const f = setup();
    try {
        registerConnection(f);
        f.controls.observedAt = '2026-09-09T11:59:00.000Z';
        await assert.rejects(prepare(f), /stale|request|observation/i);
    } finally { f.store.close(); }
});

test('satisfied readback settles unknown without resubmission and owner attestation is separately labeled', async () => {
    const f = setup();
    try {
        registerConnection(f);
        f.controls.onExecute = async (command, connection) => {
            const row = f.remote.get(`${connection.subject}/${command.resourceId}`);
            row.state = structuredClone(command.expectedResult); row.version = 'v2';
            throw new Error('accepted response lost');
        };
        const a = await prepare(f); approve(f, a);
        await f.service.execute({ workspaceId: 'personal', ownerId: 'owner', actionId: a.id });
        const settled = await f.service.verify({ workspaceId: 'personal', ownerId: 'owner', actionId: a.id });
        assert.equal(settled.status, 'accepted');
        assert.equal(settled.verification.status, 'satisfied');
        assert.equal(f.controls.executeCalls, 1);

        const second = await prepare(f, { key: 'second', arguments: { city: 'Second' } }); approve(f, second);
        f.controls.onExecute = async () => { throw new Error('lost'); };
        await f.service.execute({ workspaceId: 'personal', ownerId: 'owner', actionId: second.id });
        f.service.reconcile({ workspaceId: 'personal', ownerId: 'owner', actionId: second.id,
            status: 'failed', evidence: 'Owner confirmed the synthetic provider recorded no change.' });
        const reconciled = f.store.state('personal').actions[second.id];
        assert.equal(reconciled.status, 'failed');
        assert.equal(reconciled.verification.status, 'owner_attested');
        assert.equal(reconciled.verification.resolution, 'failed');
        assert.deepEqual(f.store.journal('personal').slice(-2).map(x => x.event.type),
            ['action.reconciled', 'action.verification_recorded']);
    } finally { f.store.close(); }
});

test('owner can explicitly attest an accepted but unverified action to release its barrier', async () => {
    const f = setup();
    try {
        registerConnection(f);
        const a = await prepare(f); approve(f, a);
        await f.service.execute({ workspaceId: 'personal', ownerId: 'owner', actionId: a.id });
        const settled = f.service.reconcile({ workspaceId: 'personal', ownerId: 'owner', actionId: a.id,
            status: 'accepted', evidence: 'Owner confirmed the synthetic desired state outside readback.' });
        assert.equal(settled.verification.status, 'owner_attested');
        const next = await prepare(f, { key: 'after-attestation', arguments: { city: 'After' } }); approve(f, next);
        assert.equal((await f.service.execute({ workspaceId: 'personal', ownerId: 'owner', actionId: next.id })).status, 'accepted');
    } finally { f.store.close(); }
});

test('operation recovery and replay never call handlers or redispatch effects', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'behalvo-operation-restart-'));
    const path = join(dir, 'operations.db');
    const f = setup({ path });
    try {
        registerConnection(f);
        const a = await prepare(f); approve(f, a);
        let signalDispatch;
        const dispatched = new Promise(resolve => { signalDispatch = resolve; });
        f.controls.onExecute = async () => { signalDispatch(); return new Promise(() => {}); };
        const pending = f.service.execute({ workspaceId: 'personal', ownerId: 'owner', actionId: a.id });
        let timeout;
        try {
            await Promise.race([dispatched, new Promise((_, reject) => {
                timeout = setTimeout(() => reject(new Error('dispatch did not start')), 1000);
            })]);
        } finally { clearTimeout(timeout); }
        f.store.close();
        const restartedStore = new SqliteStore(path);
        const restarted = new OperationService(restartedStore, f.registry, () => f.clock.value);
        assert.throws(() => restarted.recoverInterrupted({ workspaceId: 'personal', exclusiveMaintenance: false }), /exclusive/i);
        assert.equal(restarted.recoverInterrupted({ workspaceId: 'personal', exclusiveMaintenance: true }), 1);
        const calls = { ...f.controls };
        const before = restartedStore.state('personal');
        restartedStore.rebuild('personal');
        assert.deepEqual(restartedStore.state('personal'), before);
        assert.equal(f.controls.identifyCalls, calls.identifyCalls);
        assert.equal(f.controls.observeCalls, calls.observeCalls);
        assert.equal(f.controls.executeCalls, calls.executeCalls);
        restartedStore.close();
        void pending;
    } finally { f.store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('cached schema-v1 projections without connections load with an additive empty default', () => {
    const dir = mkdtempSync(join(tmpdir(), 'behalvo-old-projection-'));
    const path = join(dir, 'old.db');
    const store = new SqliteStore(path);
    try {
        store.createWorkspace('personal', 'owner');
        store.close();
        const db = new DatabaseSync(path);
        const row = db.prepare('SELECT state_json FROM projections WHERE workspace_id=?').get('personal');
        const oldState = JSON.parse(String(row.state_json));
        delete oldState.connections;
        db.prepare('UPDATE projections SET state_json=? WHERE workspace_id=?').run(JSON.stringify(oldState), 'personal');
        db.close();
        const reopened = new SqliteStore(path);
        assert.deepEqual(reopened.state('personal').connections, {});
        const before = reopened.state('personal');
        reopened.rebuild('personal');
        assert.deepEqual(reopened.state('personal'), before);
        reopened.close();
    } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('runtime rejects unsupported JSON and legacy Operator cannot dispatch or reconcile operation commands', async () => {
    const f = setup();
    try {
        registerConnection(f);
        await assert.rejects(prepare(f, { arguments: { city: 'X', __proto__: { polluted: true } } }), /argument|json|field|unsafe/i);
        await assert.rejects(prepare(f, { arguments: { city: 'X', extra: undefined } }), /json|undefined|argument/i);
        const a = await prepare(f);
        assert.throws(() => f.operator.propose('personal', { workId: 'work', key: 'legacy-bypass', command: a.command }), /unsupported|operation/i);
        approve(f, a);
        f.controls.onExecute = async () => { throw new Error('lost'); };
        await f.service.execute({ workspaceId: 'personal', ownerId: 'owner', actionId: a.id });
        assert.throws(() => f.operator.reconcile('personal', 'owner', a.id, 'accepted', 'bypass'), /operation|runtime/i);
    } finally { f.store.close(); }
});

test('legacy accepted message reconciliation remains terminal and preserves its evidence', async () => {
    const f = setup();
    try {
        const action = f.operator.propose('personal', { workId: 'work', key: 'legacy-message', command: {
            kind: 'message.send', channel: 'mock-email', to: 'synthetic@example.test', body: 'Synthetic message.'
        } });
        f.operator.approve('personal', 'owner', action.id, action.digest, EXPIRY);
        await f.operator.runEffect('personal', action.id, { channel: 'mock-email', execute: async () => ({
            status: 'accepted', evidence: 'Original synthetic acceptance.'
        }) });
        const before = f.store.state('personal').actions[action.id];
        assert.throws(() => f.operator.reconcile('personal', 'owner', action.id, 'accepted', 'replacement evidence'), /unknown|reconcile/i);
        assert.equal(f.store.state('personal').actions[action.id].evidenceRef, before.evidenceRef);
    } finally { f.store.close(); }
});

for (const stage of ['identify', 'observe']) {
    test(`execution deadline during ${stage} preflight never dispatches late`, async () => {
        const f = setup();
        try {
            registerConnection(f);
            const action = await prepare(f); approve(f, action);
            let release;
            let entered;
            const started = new Promise(resolve => { entered = resolve; });
            f.controls[stage === 'identify' ? 'onIdentify' : 'onObserve'] = async () => {
                entered(); await new Promise(resolve => { release = resolve; });
            };
            const control = new AbortController();
            const pending = f.service.execute({ workspaceId: 'personal', ownerId: 'owner', actionId: action.id },
                { signal: control.signal, deadline: Date.now() + 1000 });
            await started;
            control.abort();
            release();
            await assert.rejects(pending, /deadline|abort|stop/i);
            assert.equal(f.controls.executeCalls, 0);
            assert.equal(f.store.state('personal').actions[action.id].status, 'approved');
        } finally { f.store.close(); }
    });
}

test('in-flight cancellation records unknown and ignores late success or rejection after store close', async () => {
    for (const rejectLate of [false, true]) {
        const f = setup();
        registerConnection(f);
        const action = await prepare(f); approve(f, action);
        let entered, resolveEffect, rejectEffect;
        const started = new Promise(resolve => { entered = resolve; });
        f.controls.onExecute = () => { entered(); return new Promise((resolve, reject) => { resolveEffect = resolve; rejectEffect = reject; }); };
        const control = new AbortController();
        const pending = f.service.execute({ workspaceId: 'personal', ownerId: 'owner', actionId: action.id },
            { signal: control.signal, deadline: Date.now() + 1000 });
        await started; control.abort();
        const settled = await pending;
        assert.equal(settled.status, 'unknown');
        assert.equal((await f.service.execute({ workspaceId: 'personal', ownerId: 'owner', actionId: action.id })).status, 'unknown');
        assert.equal(f.controls.executeCalls, 1);
        const before = f.store.journal('personal').length;
        if (rejectLate) rejectEffect(new Error('late rejection'));
        else resolveEffect({ status: 'accepted', evidence: 'late success' });
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(f.store.journal('personal').length, before);
        f.store.close();
    }
});

test('trusted storage faults after action start escape the provider catch without claiming an outcome', async () => {
    const f = setup();
    try {
        registerConnection(f);
        const action = await prepare(f); approve(f, action);
        const context = { deadline: Date.now() + 10000, async assertCurrent() {
            if (f.store.state('personal').actions[action.id].status === 'running')
                throw new ServiceStorageError('integrity', 'Fixed synthetic storage fault');
        } };
        await assert.rejects(
            f.service.execute({ workspaceId: 'personal', ownerId: 'owner', actionId: action.id }, context),
            error => error.code === 'integrity'
        );
        assert.equal(f.controls.executeCalls, 0);
        assert.equal(f.store.state('personal').actions[action.id].status, 'running');
    } finally { f.store.close(); }
});

test('elapsed deadline without fired abort timer blocks dispatch and late prepare/verify writes', async () => {
    const f = setup();
    try {
        registerConnection(f);
        await assert.rejects(f.service.prepare({ workspaceId: 'personal', ownerId: 'owner', workId: 'work', key: 'expired',
            connectionId: 'connection-a', operationId: 'profile.update', operationVersion: '1', resourceId: 'profile', arguments: { city: 'X' } },
            { deadline: Date.now() - 1 }), /deadline/i);
        assert.equal(f.controls.identifyCalls, 0);
        const action = await prepare(f); approve(f, action);
        const context = { deadline: Date.now() + 10000 };
        f.controls.onObserve = async () => { context.deadline = Date.now() - 1; };
        await assert.rejects(f.service.execute({ workspaceId: 'personal', ownerId: 'owner', actionId: action.id }, context), /deadline/i);
        assert.equal(f.controls.executeCalls, 0);
        delete f.controls.onObserve;
        await f.service.execute({ workspaceId: 'personal', ownerId: 'owner', actionId: action.id });
        context.deadline = Date.now() + 10000;
        f.controls.onObserve = async () => { context.deadline = Date.now() - 1; };
        await assert.rejects(f.service.verify({ workspaceId: 'personal', ownerId: 'owner', actionId: action.id }, context), /deadline/i);
        assert.equal(f.store.state('personal').actions[action.id].verification, undefined);
    } finally { f.store.close(); }
});

for (const stage of ['prepare', 'verify']) {
    test(`deadline abandons deferred ${stage} readback without any late journal access`, async () => {
        const f = setup();
        registerConnection(f);
        let action;
        if (stage === 'verify') { action = await prepare(f); approve(f, action); await f.service.execute({ workspaceId: 'personal', ownerId: 'owner', actionId: action.id }); }
        let release;
        f.controls.onObserve = () => new Promise(resolve => { release = resolve; });
        const context = { deadline: Date.now() + 10 };
        const pending = stage === 'prepare'
            ? f.service.prepare({ workspaceId: 'personal', ownerId: 'owner', workId: 'work', key: 'late', connectionId: 'connection-a',
                operationId: 'profile.update', operationVersion: '1', resourceId: 'profile', arguments: { city: 'X' } }, context)
            : f.service.verify({ workspaceId: 'personal', ownerId: 'owner', actionId: action.id }, context);
        await assert.rejects(pending, /deadline/i);
        if (action) assert.equal(f.store.state('personal').actions[action.id].verification, undefined);
        else assert.equal(Object.keys(f.store.state('personal').actions).length, 0);
        f.store.close(); release();
        await new Promise(resolve => setImmediate(resolve));
    });
}

test('never-settling effect times out inside the service and late rejection after close is consumed', async () => {
    const f = setup(); registerConnection(f);
    const action = await prepare(f); approve(f, action);
    let rejectLate;
    f.controls.onExecute = () => new Promise((_, reject) => { rejectLate = reject; });
    const result = await f.service.execute({ workspaceId: 'personal', ownerId: 'owner', actionId: action.id }, { deadline: Date.now() + 10 });
    assert.equal(result.status, 'unknown');
    assert.equal(f.controls.executeCalls, 1);
    f.store.close(); rejectLate(new Error('Late provider rejection'));
    await new Promise(resolve => setImmediate(resolve));
});

test('approval expiry during SQLite lock wait prevents action start and provider dispatch', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'behalvo-approval-lock-'));
    const path = join(dir, 'journal.db');
    const f = setup({ path, clock: { get value() { return new Date().toISOString(); } } });
    let lockFinished;
    try {
        registerConnection(f);
        const action = await prepare(f);
        f.service.approveBatch({ workspaceId: 'personal', ownerId: 'owner',
            expiresAt: new Date(Date.now() + 500).toISOString(), approvals: [{ actionId: action.id, digest: action.digest }] });
        const originalAppend = f.store.append.bind(f.store);
        f.store.append = (...args) => {
            if (!lockFinished && args[2].some(event => event.type === 'action.started'))
                lockFinished = holdSqliteWriteLock(path, 750);
            return originalAppend(...args);
        };
        const before = f.store.journal('personal').length;
        await assert.rejects(f.service.execute({ workspaceId: 'personal', ownerId: 'owner', actionId: action.id },
            { deadline: Date.now() + 10000 }), /Approval expired/i);
        assert.ok(lockFinished);
        assert.equal(f.store.journal('personal').length, before);
        assert.equal(f.store.state('personal').actions[action.id].status, 'approved');
        assert.equal(f.controls.executeCalls, 0);
    } finally { f.store.close(); if (lockFinished) await lockFinished; rmSync(dir, { recursive: true, force: true }); }
});

test('approval expiry during durable start prevents dispatch and leaves an unknown attempt', async () => {
    const clock = { value: NOW };
    const f = setup({ clock });
    try {
        registerConnection(f);
        const action = await prepare(f); approve(f, action);
        const originalAppend = f.store.append.bind(f.store);
        f.store.append = (...args) => {
            const result = originalAppend(...args);
            if (args[2].some(event => event.type === 'action.started')) clock.value = EXPIRY;
            return result;
        };
        const result = await f.service.execute({ workspaceId: 'personal', ownerId: 'owner', actionId: action.id });
        assert.equal(result.status, 'unknown');
        assert.equal(f.controls.executeCalls, 0);
        assert.ok(result.attemptId);
    } finally { f.store.close(); }
});

for (const stage of ['prepare', 'execute', 'verify']) {
    test(`${stage} deadline is rechecked after SQLite writer lock acquisition before journal mutation`, async () => {
        const dir = mkdtempSync(join(tmpdir(), 'behalvo-operation-lock-'));
        const path = join(dir, 'journal.db');
        const f = setup({ path });
        let lockFinished;
        try {
            registerConnection(f);
            let action;
            if (stage !== 'prepare') { action = await prepare(f); approve(f, action); }
            if (stage === 'verify') await f.service.execute({ workspaceId: 'personal', ownerId: 'owner', actionId: action.id });
            const context = { deadline: Date.now() + 10000 };
            const eventType = { prepare: 'action.proposed', execute: 'action.started', verify: 'action.verification_recorded' }[stage];
            const writerName = stage === 'verify' ? 'recordActionVerification' : 'append';
            const eventIndex = stage === 'verify' ? 3 : 2;
            const originalWriter = f.store[writerName].bind(f.store);
            f.store[writerName] = (...args) => {
                if (!lockFinished && args[eventIndex].some(event => event.type === eventType)) {
                    lockFinished = holdSqliteWriteLock(path, 150);
                    context.deadline = Date.now() + 20;
                }
                return originalWriter(...args);
            };
            const before = f.store.journal('personal').length;
            const pending = stage === 'prepare'
                ? f.service.prepare({ workspaceId: 'personal', ownerId: 'owner', workId: 'work', key: 'locked', connectionId: 'connection-a',
                    operationId: 'profile.update', operationVersion: '1', resourceId: 'profile', arguments: { city: 'X' } }, context)
                : f.service[stage]({ workspaceId: 'personal', ownerId: 'owner', actionId: action.id }, context);
            await assert.rejects(pending, /deadline/i);
            assert.ok(lockFinished);
            assert.equal(f.store.journal('personal').length, before);
            assert.equal(f.controls.executeCalls, stage === 'verify' ? 1 : 0);
            if (stage === 'execute') assert.equal(f.store.state('personal').actions[action.id].status, 'approved');
        } finally { f.store.close(); if (lockFinished) await lockFinished; rmSync(dir, { recursive: true, force: true }); }
    });
}
