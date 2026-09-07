import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, createWork, propose, approve } from './helpers.mjs';
function fakeDriver(counter, result = { status: 'accepted', evidence: 'Synthetic provider accepted request.' }) {
    return { channel: 'mock-email', execute: async (request) => {
            counter.calls += 1;
            counter.last = request;
            return result;
        } };
}
test('external effects cannot execute before approval', async (t) => {
    const f = await fixture(t);
    createWork(f);
    const a = propose(f);
    const c = { calls: 0 };
    await assert.rejects(f.operator.runEffect('personal', a.id, fakeDriver(c)), /approval/i);
    assert.equal(c.calls, 0);
});
test('only the configured owner can grant approval', async (t) => {
    const f = await fixture(t);
    createWork(f);
    const a = propose(f);
    assert.throws(() => f.operator.approve('personal', 'attacker', a.id, a.digest, '2026-09-07T13:00:00.000Z'), /owner|denied/i);
    assert.equal(f.store.state('personal').actions[a.id].status, 'proposed');
});
test('approval binds to the exact command digest', async (t) => {
    const f = await fixture(t);
    createWork(f);
    const a = propose(f);
    assert.throws(() => f.operator.approve('personal', 'owner', a.id, 'wrong-digest', '2026-09-07T13:00:00.000Z'), /digest/i);
});
test('normal redispatch of an accepted action does not send again', async (t) => {
    const f = await fixture(t);
    createWork(f);
    const a = propose(f);
    approve(f, a);
    const c = { calls: 0 };
    const d = fakeDriver(c);
    await f.operator.runEffect('personal', a.id, d);
    await f.operator.runEffect('personal', a.id, d);
    assert.equal(c.calls, 1);
    assert.equal(c.last.idempotencyKey, a.key);
    assert.equal(f.store.state('personal').actions[a.id].status, 'accepted');
});
test('provider acceptance does not complete the WorkItem', async (t) => {
    const f = await fixture(t);
    createWork(f);
    const a = propose(f);
    approve(f, a);
    await f.operator.runEffect('personal', a.id, fakeDriver({ calls: 0 }));
    assert.equal(f.store.state('personal').works.w.phase, 'open');
});
test('an idempotency key cannot be reused for different command content', async (t) => {
    const f = await fixture(t);
    createWork(f);
    const a = propose(f);
    assert.equal(propose(f).id, a.id);
    assert.throws(() => propose(f, { command: { kind: 'message.send', channel: 'mock-email', to: 'other@example.test', body: 'Different' } }), /key|collision|conflict/i);
});
test('expired approval is rechecked before the side effect', async (t) => {
    const f = await fixture(t);
    createWork(f);
    const a = propose(f);
    approve(f, a);
    f.clock.value = '2026-09-07T14:00:00.000Z';
    const c = { calls: 0 };
    await assert.rejects(f.operator.runEffect('personal', a.id, fakeDriver(c)), /expired/i);
    assert.equal(c.calls, 0);
});
test('changing work invalidates an older action authorization', async (t) => {
    const f = await fixture(t);
    createWork(f);
    const a = propose(f);
    approve(f, a);
    f.operator.setWorkPhase('personal', 'owner', 'w', 'cancelled');
    const c = { calls: 0 };
    await assert.rejects(f.operator.runEffect('personal', a.id, fakeDriver(c)), /stale|closed|cancel/i);
    assert.equal(c.calls, 0);
});
test('an unknown channel and undeclared command cannot enter the effect queue', async (t) => {
    const f = await fixture(t);
    createWork(f);
    assert.throws(() => propose(f, { command: { kind: 'message.send', channel: 'shell', to: 'x', body: 'x' } }), /channel|denied/i);
    assert.throws(() => propose(f, { command: { kind: 'transfer.money', channel: 'mock-email', to: 'x', body: 'x' } }), /command|denied/i);
});
test('a mismatched driver cannot execute an approved action', async (t) => {
    const f = await fixture(t);
    createWork(f);
    const a = propose(f);
    approve(f, a);
    const c = { calls: 0 };
    const d = fakeDriver(c);
    d.channel = 'mock-im';
    await assert.rejects(f.operator.runEffect('personal', a.id, d), /channel|driver/i);
    assert.equal(c.calls, 0);
});
test('ambiguous provider failure is recorded as unknown and never automatically retried', async (t) => {
    const f = await fixture(t);
    createWork(f);
    const a = propose(f);
    approve(f, a);
    let calls = 0;
    const d = { channel: 'mock-email', execute: async () => { calls++; throw new Error('Response lost after send.'); } };
    await f.operator.runEffect('personal', a.id, d);
    await f.operator.runEffect('personal', a.id, d);
    assert.equal(f.store.state('personal').actions[a.id].status, 'unknown');
    assert.equal(calls, 1);
});
test('restart recovery quarantines an interrupted effect instead of retrying it', async (t) => {
    const f = await fixture(t);
    createWork(f);
    const a = propose(f);
    approve(f, a);
    f.operator.startEffect('personal', a.id, 'mock-email');
    f.restart();
    assert.throws(() => f.operator.recoverInterrupted('personal', false), /exclusive/i);
    assert.equal(f.operator.recoverInterrupted('personal', true), 1);
    const c = { calls: 0 };
    await f.operator.runEffect('personal', a.id, fakeDriver(c));
    assert.equal(c.calls, 0);
    assert.equal(f.store.state('personal').actions[a.id].status, 'unknown');
});
test('reconciliation appends evidence and cannot silently resend the original action', async (t) => {
    const f = await fixture(t);
    createWork(f);
    const a = propose(f);
    approve(f, a);
    f.operator.startEffect('personal', a.id, 'mock-email');
    f.operator.recoverInterrupted('personal', true);
    f.operator.reconcile('personal', 'owner', a.id, 'accepted', 'Owner checked provider sent folder (synthetic).');
    assert.equal(f.store.state('personal').actions[a.id].status, 'accepted');
    assert.equal(f.store.journal('personal').at(-1).event.type, 'action.reconciled');
});
test('timer persists across restart and fires once into the durable inbox', async (t) => {
    const f = await fixture(t);
    createWork(f);
    f.operator.schedule('personal', 'owner', { id: 'timer1', workId: 'w', dueAt: '2026-09-08T12:00:00.000Z' });
    f.restart();
    assert.equal(f.operator.fireDue('personal'), 0);
    f.clock.value = '2026-09-09T12:00:00.000Z';
    assert.equal(f.operator.fireDue('personal'), 1);
    assert.equal(f.operator.fireDue('personal'), 0);
    assert.equal(f.store.inbox('personal').length, 1);
    assert.equal(f.store.inbox('personal')[0].event.type, 'timer.fired');
});
test('closed or changed work prevents a stale scheduled follow-up', async (t) => {
    const f = await fixture(t);
    createWork(f);
    f.operator.schedule('personal', 'owner', { id: 'timer1', workId: 'w', dueAt: '2026-09-08T12:00:00.000Z' });
    f.operator.setWorkPhase('personal', 'owner', 'w', 'cancelled');
    f.clock.value = '2026-09-09T12:00:00.000Z';
    assert.equal(f.operator.fireDue('personal'), 0);
    assert.equal(f.store.state('personal').timers.timer1.status, 'cancelled');
    assert.equal(f.store.inbox('personal').length, 0);
});
