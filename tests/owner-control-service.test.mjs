import test from 'node:test';
import assert from 'node:assert/strict';
import { commandDigest, OperationRegistry, OperationService, Operator, SqliteStore } from '../dist/index.js';
import { openOwnerControl } from '../dist/control/local-app.js';
import { OwnerControlService } from '../dist/control/review-service.js';
import { OwnerControlSessions } from '../dist/control/session.js';
import { holdSqliteWriteLock } from './sqlite-lock-helper.mjs';
import { createOwnerControlFixture } from './owner-control-fixture.mjs';

const ORIGIN = 'http://127.0.0.1:44001';
function code(expected) { return error => error?.code === expected; }
function authenticate(app) {
    const bootstrap = app.sessions.issueBootstrap(ORIGIN);
    const ticket = app.sessions.exchangeBootstrap(bootstrap.token, bootstrap.origin);
    return { principal: app.sessions.authenticate(ticket.token), ticket };
}
function open(fixture, clock) {
    return openOwnerControl({ dbPath: fixture.dbPath, workspaceId: fixture.workspaceId, ...(clock ? { clock } : {}) });
}
function mutate(fixture, fn) {
    const store = new SqliteStore(fixture.dbPath);
    try { return fn(store); } finally { store.close(); }
}

test('authenticated review returns the full immutable command and approves once with the review-time expiry', async t => {
    const fixture = await createOwnerControlFixture(t);
    let now = Date.parse('2026-09-14T12:00:00.000Z');
    const app = open(fixture, () => now); t.after(() => app.close());
    const { principal } = authenticate(app);
    const page = app.service.list(principal);
    assert.equal(page.workspaceId, fixture.workspaceId);
    assert.equal(page.items.length, 2);
    assert.deepEqual(page.items.map(item => item.actionId), [...page.items.map(item => item.actionId)].sort());
    assert.equal(page.nextAfter, null);
    assert.ok(page.items.every(item => item.approvalExpiresAt === null && item.synthetic === true));

    const review = app.service.review(principal, fixture.approveActionId);
    assert.deepEqual(review.action, {
        actionId: fixture.approveActionId, workId: 'contact-work', workTitle: 'Update synthetic contact',
        workRevision: 1, currentWorkRevision: 1, phase: 'open', status: 'proposed',
        digest: review.action.digest, approvalExpiresAt: '2026-09-14T12:10:00.000Z', synthetic: true
    });
    assert.match(review.action.digest, /^[a-f0-9]{64}$/);
    assert.deepEqual(review.command, {
        kind: 'operation.execute', operationId: 'contact.update', operationVersion: '1',
        connectionId: 'synthetic-account', provider: 'synthetic-accounts', subject: 'synthetic-person',
        connectionGeneration: 1, resourceId: 'contact-profile', arguments: { email: 'owner-control@example.test' },
        affectedResourceIds: ['contact-profile'], precondition: review.command.precondition,
        expectedResult: { kind: 'contact-profile', email: 'owner-control@example.test', locale: 'en-US' },
        subjectRevision: 0, requestFingerprint: review.command.requestFingerprint
    });
    assert.deepEqual(Object.keys(review.command.precondition).sort(), ['observedAt', 'providerVersion', 'source', 'state']);
    assert.equal(review.command.precondition.providerVersion, 'contact:1');
    assert.equal(review.command.precondition.source, 'synthetic-contact-readback');
    assert.deepEqual(review.command.precondition.state, { kind: 'contact-profile', email: 'synthetic@example.test', locale: 'en-US' });
    assert.match(review.command.requestFingerprint, /^[a-f0-9]{64}$/);
    assert.deepEqual(review.connection, {
        id: 'synthetic-account', provider: 'synthetic-accounts', subject: 'synthetic-person',
        label: 'SYNTHETIC ONLY — simulated account, no real effects', generation: 1, status: 'active'
    });
    assert.equal(review.reviewExpiresAt, '2026-09-14T12:02:00.000Z');
    assert.equal(review.approvalExpiresAt, '2026-09-14T12:10:00.000Z');
    assert.equal(review.canApprove, true); assert.equal(review.canCancel, true);

    now += 30_000;
    const input = { reviewToken: review.reviewToken, digest: review.action.digest };
    const approved = app.service.approve(principal, fixture.approveActionId, input);
    assert.equal(approved.status, 'approved');
    assert.equal(approved.approvalExpiresAt, '2026-09-14T12:10:00.000Z');
    assert.throws(() => app.service.approve(principal, fixture.approveActionId, input), code('conflict'));
    const records = mutate(fixture, store => store.journal(fixture.workspaceId));
    assert.equal(records.filter(record => record.event.type === 'action.approved' && record.event.data.id === fixture.approveActionId).length, 1);
});

test('decision inputs and principals are exact, receipts are action-bound and replacement invalidates the old receipt', async t => {
    const fixture = await createOwnerControlFixture(t);
    const app = open(fixture); t.after(() => app.close());
    const { principal } = authenticate(app);
    assert.throws(() => app.service.list({ ...principal }), code('unauthenticated'));
    assert.throws(() => app.service.list({ ...principal, ownerId: 'other' }), code('unauthenticated'));
    const first = app.service.review(principal, fixture.approveActionId);
    const second = app.service.review(principal, fixture.approveActionId);
    assert.notEqual(second.reviewToken, first.reviewToken);
    assert.throws(() => app.service.approve(principal, fixture.approveActionId,
        { reviewToken: first.reviewToken, digest: first.action.digest }), code('conflict'));
    assert.throws(() => app.service.approve(principal, fixture.cancelActionId,
        { reviewToken: second.reviewToken, digest: second.action.digest }), code('conflict'));
    assert.throws(() => app.service.approve(principal, fixture.approveActionId,
        { reviewToken: second.reviewToken, digest: '0'.repeat(64) }), code('conflict'));
    assert.throws(() => app.service.approve(principal, fixture.approveActionId,
        { reviewToken: second.reviewToken, digest: second.action.digest, ownerId: 'owner' }), code('invalid_request'));
    assert.throws(() => app.service.review(principal, 'missing-action'), code('not_found'));
});

test('receipts expire, logout and close revoke authority, and authentication expiry wins over a stale decision', async t => {
    const fixture = await createOwnerControlFixture(t);
    let now = Date.parse('2026-09-14T12:00:00.000Z');
    const app = open(fixture, () => now); t.after(() => app.close());
    const { principal } = authenticate(app);
    const expired = app.service.review(principal, fixture.approveActionId);
    now += 2 * 60_000;
    assert.throws(() => app.service.approve(principal, fixture.approveActionId,
        { reviewToken: expired.reviewToken, digest: expired.action.digest }), code('conflict'));
    const live = app.service.review(principal, fixture.approveActionId);
    app.service.logout(principal);
    assert.throws(() => app.service.approve(principal, fixture.approveActionId,
        { reviewToken: live.reviewToken, digest: live.action.digest }), code('unauthenticated'));

    const fixture2 = await createOwnerControlFixture(t);
    const closed = open(fixture2);
    const authenticated = authenticate(closed);
    const review = closed.service.review(authenticated.principal, fixture2.approveActionId);
    closed.close(); closed.close();
    assert.throws(() => closed.service.approve(authenticated.principal, fixture2.approveActionId,
        { reviewToken: review.reviewToken, digest: review.action.digest }), code('unavailable'));
});

test('approval rejects stale work and changed connections while cancellation still revokes the immutable pending action', async t => {
    for (const change of ['work', 'connection']) {
        await t.test(change, async t => {
            const fixture = await createOwnerControlFixture(t);
            const app = open(fixture); t.after(() => app.close());
            const { principal } = authenticate(app);
            const review = app.service.review(principal, fixture.approveActionId);
            mutate(fixture, store => {
                if (change === 'work') new Operator(store).setWorkPhase(fixture.workspaceId, fixture.ownerId, 'contact-work', 'waiting_external');
                else new OperationService(store, new OperationRegistry()).revokeConnection({
                    workspaceId: fixture.workspaceId, ownerId: fixture.ownerId, connectionId: 'synthetic-account'
                });
            });
            assert.throws(() => app.service.approve(principal, fixture.approveActionId,
                { reviewToken: review.reviewToken, digest: review.action.digest }), code('conflict'));
            const cancellable = app.service.review(principal, fixture.approveActionId);
            assert.equal(cancellable.canApprove, false); assert.equal(cancellable.canCancel, true);
            const cancelled = app.service.cancel(principal, fixture.approveActionId,
                { reviewToken: cancellable.reviewToken, digest: cancellable.action.digest });
            assert.equal(cancelled.status, 'cancelled');
            const record = mutate(fixture, store => store.journal(fixture.workspaceId).at(-1));
            assert.deepEqual(record.event, { type: 'action.cancelled', data: {
                id: fixture.approveActionId, reason: 'Cancelled through authenticated local owner control.'
            } });
        });
    }
});

test('cancellation is one-use and cannot change a running or already-cancelled action', async t => {
    const fixture = await createOwnerControlFixture(t);
    const app = open(fixture); t.after(() => app.close());
    const { principal } = authenticate(app);
    const cancelReview = app.service.review(principal, fixture.cancelActionId);
    const input = { reviewToken: cancelReview.reviewToken, digest: cancelReview.action.digest };
    assert.equal(app.service.cancel(principal, fixture.cancelActionId, input).status, 'cancelled');
    assert.throws(() => app.service.cancel(principal, fixture.cancelActionId, input), code('conflict'));

    const approval = app.service.review(principal, fixture.approveActionId);
    app.service.approve(principal, fixture.approveActionId,
        { reviewToken: approval.reviewToken, digest: approval.action.digest });
    mutate(fixture, store => {
        const state = store.state(fixture.workspaceId);
        store.append(fixture.workspaceId, state.version,
            [{ type: 'action.started', data: { id: fixture.approveActionId, attemptId: 'owner-control-running' } }]);
    });
    const running = app.service.review(principal, fixture.approveActionId);
    assert.equal(running.canCancel, false);
    const before = mutate(fixture, store => store.journal(fixture.workspaceId).length);
    assert.throws(() => app.service.cancel(principal, fixture.approveActionId,
        { reviewToken: running.reviewToken, digest: running.action.digest }), code('conflict'));
    assert.equal(mutate(fixture, store => store.journal(fixture.workspaceId).length), before);
});

test('list paginates only the allowlisted synthetic operation surface and review receipts are bounded to 100', async t => {
    const fixture = await createOwnerControlFixture(t);
    mutate(fixture, store => {
        const state = store.state(fixture.workspaceId);
        const original = state.actions[fixture.approveActionId];
        const events = [];
        for (let index = 0; index < 101; index++) {
            const id = index === 1 ? 'bulk_001' : `bulk-${String(index).padStart(3, '0')}`;
            const command = structuredClone(original.command);
            events.push({ type: 'action.proposed', data: { action: {
                id, workId: original.workId, key: `${fixture.workspaceId}:bulk-${index}`,
                command, digest: commandDigest(fixture.workspaceId, original.workId, original.workRevision, command),
                workRevision: original.workRevision, status: 'proposed'
            } } });
        }
        const unsupportedCommand = { ...structuredClone(original.command), provider: 'other-provider' };
        events.push({ type: 'action.proposed', data: { action: {
            id: 'unsupported-action', workId: original.workId, key: `${fixture.workspaceId}:unsupported`,
            command: unsupportedCommand,
            digest: commandDigest(fixture.workspaceId, original.workId, original.workRevision, unsupportedCommand),
            workRevision: original.workRevision, status: 'proposed'
        } } });
        store.append(fixture.workspaceId, state.version, events);
    });
    const app = open(fixture); t.after(() => app.close());
    const { principal } = authenticate(app);
    const first = app.service.list(principal);
    assert.equal(first.items.length, 100);
    assert.equal(first.nextAfter, first.items.at(-1).actionId);
    const second = app.service.list(principal, first.nextAfter);
    assert.equal(second.items.length, 3);
    assert.equal(second.nextAfter, null);
    const all = [...first.items, ...second.items];
    assert.ok(all.every(item => item.actionId !== 'unsupported-action'));
    assert.deepEqual(all.map(item => item.actionId), all.map(item => item.actionId).sort());
    assert.throws(() => app.service.review(principal, 'unsupported-action'), code('not_found'));
    assert.throws(() => app.service.list(principal, 'bad cursor with spaces'), code('invalid_request'));

    for (const item of all.slice(0, 100)) app.service.review(principal, item.actionId);
    assert.throws(() => app.service.review(principal, all[100].actionId), code('rate_limited'));
});

test('the append guard rejects receipt expiry during a real SQLite writer-lock wait with no decision event', async t => {
    const fixture = await createOwnerControlFixture(t);
    const started = Date.now();
    const base = Date.parse('2026-09-14T12:00:00.000Z');
    const app = open(fixture, () => base + (Date.now() - started) * 1_000); t.after(() => app.close());
    const { principal } = authenticate(app);
    const held = holdSqliteWriteLock(fixture.dbPath, 350);
    const review = app.service.review(principal, fixture.approveActionId);
    const before = mutate(fixture, store => store.journal(fixture.workspaceId).length);
    assert.throws(() => app.service.approve(principal, fixture.approveActionId,
        { reviewToken: review.reviewToken, digest: review.action.digest }), code('conflict'));
    await held;
    const records = mutate(fixture, store => store.journal(fixture.workspaceId));
    assert.equal(records.length, before);
    assert.equal(records.some(record => record.event.type === 'action.approved' && record.event.data.id === fixture.approveActionId), false);
});

test('an unexpected post-commit fault stays internal, consumes its receipt, and cannot approve twice', async t => {
    const fixture = await createOwnerControlFixture(t);
    const now = Date.parse('2026-09-14T12:00:00.000Z');
    const isoClock = () => new Date(now).toISOString();
    const store = new SqliteStore(fixture.dbPath);
    const sessions = new OwnerControlSessions({ workspaceId: fixture.workspaceId, ownerId: fixture.ownerId }, () => now);
    const operator = new Operator(store, isoClock);
    const underlying = new OperationService(store, new OperationRegistry(), isoClock, fixture.workspaceId);
    const unexpected = new Error('synthetic unexpected post-commit fault');
    const approveBatch = underlying.approveBatch.bind(underlying);
    underlying.approveBatch = (input, beforeAppend) => {
        approveBatch(input, beforeAppend);
        throw unexpected;
    };
    const service = new OwnerControlService({ store, operator, operations: underlying, sessions,
        binding: { workspaceId: fixture.workspaceId, ownerId: fixture.ownerId }, clock: () => now });
    t.after(() => { service.close(); store.close(); });
    const bootstrap = sessions.issueBootstrap(ORIGIN);
    const ticket = sessions.exchangeBootstrap(bootstrap.token, bootstrap.origin);
    const principal = sessions.authenticate(ticket.token);
    const review = service.review(principal, fixture.approveActionId);
    const input = { reviewToken: review.reviewToken, digest: review.action.digest };

    let failure;
    try { service.approve(principal, fixture.approveActionId, input); }
    catch (error) { failure = error; }
    assert.equal(failure, unexpected);
    assert.equal(store.journal(fixture.workspaceId)
        .filter(record => record.event.type === 'action.approved' && record.event.data.id === fixture.approveActionId).length, 1);
    assert.throws(() => service.approve(principal, fixture.approveActionId, input), code('conflict'));
    assert.equal(store.journal(fixture.workspaceId)
        .filter(record => record.event.type === 'action.approved' && record.event.data.id === fixture.approveActionId).length, 1);
});

test('a recognized mutation race remains a conflict and still consumes its receipt', async t => {
    const fixture = await createOwnerControlFixture(t);
    const now = Date.parse('2026-09-14T12:00:00.000Z');
    const isoClock = () => new Date(now).toISOString();
    const store = new SqliteStore(fixture.dbPath);
    const sessions = new OwnerControlSessions({ workspaceId: fixture.workspaceId, ownerId: fixture.ownerId }, () => now);
    const operator = new Operator(store, isoClock);
    const operations = new OperationService(store, new OperationRegistry(), isoClock, fixture.workspaceId);
    operations.approveBatch = () => { throw new Error('Stream version conflict'); };
    const service = new OwnerControlService({ store, operator, operations, sessions,
        binding: { workspaceId: fixture.workspaceId, ownerId: fixture.ownerId }, clock: () => now });
    t.after(() => { service.close(); store.close(); });
    const bootstrap = sessions.issueBootstrap(ORIGIN);
    const ticket = sessions.exchangeBootstrap(bootstrap.token, bootstrap.origin);
    const principal = sessions.authenticate(ticket.token);
    const review = service.review(principal, fixture.approveActionId);
    const input = { reviewToken: review.reviewToken, digest: review.action.digest };

    assert.throws(() => service.approve(principal, fixture.approveActionId, input), code('conflict'));
    assert.throws(() => service.approve(principal, fixture.approveActionId, input), code('conflict'));
    assert.equal(store.state(fixture.workspaceId).actions[fixture.approveActionId].status, 'proposed');
});
