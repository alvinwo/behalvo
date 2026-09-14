import test from 'node:test';
import assert from 'node:assert/strict';
import { OwnerControlSessions } from '../dist/control/session.js';

const origin = 'http://127.0.0.1:44001';
function authority() {
    let now = Date.parse('2026-09-14T12:00:00.000Z');
    const sessions = new OwnerControlSessions({ workspaceId: 'owner-control-demo', ownerId: 'owner' }, () => now);
    return { sessions, get now() { return now; }, set now(value) { now = value; } };
}
function code(expected) { return error => error?.code === expected; }

test('bootstrap is issued once, bound to the exact origin, expires at five minutes, and is single use', () => {
    const f = authority();
    const bootstrap = f.sessions.issueBootstrap(origin);
    assert.deepEqual(Object.keys(bootstrap).sort(), ['expiresAt', 'origin', 'token', 'version']);
    assert.equal(bootstrap.version, 1);
    assert.equal(bootstrap.origin, origin);
    assert.match(bootstrap.token, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(bootstrap.expiresAt, '2026-09-14T12:05:00.000Z');
    assert.throws(() => f.sessions.issueBootstrap(origin), code('conflict'));
    assert.throws(() => f.sessions.exchangeBootstrap(bootstrap.token, 'http://127.0.0.1:44002'), code('forbidden'));
    const session = f.sessions.exchangeBootstrap(bootstrap.token, origin);
    assert.match(session.token, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(session.expiresAt, '2026-09-14T13:00:00.000Z');
    assert.equal(session.idleExpiresAt, '2026-09-14T12:15:00.000Z');
    assert.throws(() => f.sessions.exchangeBootstrap(bootstrap.token, origin), code('unauthenticated'));

    const expired = authority();
    const old = expired.sessions.issueBootstrap(origin);
    expired.now += 5 * 60_000;
    assert.throws(() => expired.sessions.exchangeBootstrap(old.token, origin), code('unauthenticated'));
});

test('ten failed well-formed bootstrap credentials exhaust the bounded attempt allowance', () => {
    const f = authority();
    f.sessions.issueBootstrap(origin);
    for (let index = 0; index < 10; index++)
        assert.throws(() => f.sessions.exchangeBootstrap(`${'A'.repeat(42)}${index % 10}`, origin), code('unauthenticated'));
    assert.throws(() => f.sessions.exchangeBootstrap('B'.repeat(43), origin), code('rate_limited'));
});

test('sessions enforce principal identity, idle and absolute expiry without assertActive extension', () => {
    const f = authority();
    const bootstrap = f.sessions.issueBootstrap(origin);
    const ticket = f.sessions.exchangeBootstrap(bootstrap.token, origin);
    const principal = f.sessions.authenticate(ticket.token);
    assert.deepEqual(principal, { workspaceId: 'owner-control-demo', ownerId: 'owner',
        instanceId: f.sessions.instanceId, sessionId: principal.sessionId });
    assert.throws(() => f.sessions.assertActive({ ...principal }), code('unauthenticated'));
    f.now += 14 * 60_000;
    f.sessions.assertActive(principal);
    f.now += 60_000;
    assert.throws(() => f.sessions.authenticate(ticket.token), code('unauthenticated'));

    const absolute = authority();
    const b = absolute.sessions.issueBootstrap(origin);
    const s = absolute.sessions.exchangeBootstrap(b.token, origin);
    const p = absolute.sessions.authenticate(s.token);
    for (let index = 0; index < 4; index++) {
        absolute.now += 14 * 60_000;
        assert.equal(absolute.sessions.authenticate(s.token), p);
    }
    absolute.now = Date.parse(s.expiresAt) - 1;
    assert.equal(absolute.sessions.authenticate(s.token), p);
    absolute.now = Date.parse(s.expiresAt);
    assert.throws(() => absolute.sessions.authenticate(s.token), code('unauthenticated'));
});

test('logout and close revoke bearer and principal authority and close is idempotent', () => {
    const f = authority();
    const bootstrap = f.sessions.issueBootstrap(origin);
    const ticket = f.sessions.exchangeBootstrap(bootstrap.token, origin);
    const principal = f.sessions.authenticate(ticket.token);
    f.sessions.logout(principal);
    assert.throws(() => f.sessions.authenticate(ticket.token), code('unauthenticated'));
    assert.throws(() => f.sessions.assertActive(principal), code('unauthenticated'));
    const closed = authority();
    const boot = closed.sessions.issueBootstrap(origin);
    const session = closed.sessions.exchangeBootstrap(boot.token, origin);
    const issued = closed.sessions.authenticate(session.token);
    closed.sessions.close(); closed.sessions.close();
    assert.throws(() => closed.sessions.assertActive(issued), code('unavailable'));
    assert.throws(() => closed.sessions.authenticate(session.token), code('unavailable'));
});
