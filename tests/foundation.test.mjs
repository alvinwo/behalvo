import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { fixture, message, createWork } from './helpers.mjs';
test('journal records work creation and derives the current work state', async (t) => {
    const f = await fixture(t);
    createWork(f);
    const state = f.store.state('personal');
    assert.equal(state.works.w.phase, 'open');
    assert.equal(state.version, f.store.journal('personal').length);
    assert.equal(f.store.journal('personal').at(-1).event.type, 'work.created');
});
test('journal SQL UPDATE and DELETE are rejected', async (t) => {
    const f = await fixture(t);
    const db = new DatabaseSync(f.path);
    try {
        assert.throws(() => db.exec("UPDATE journal SET actor_id='forged'"), /append.only/i);
        assert.throws(() => db.exec('DELETE FROM journal'), /append.only/i);
    }
    finally {
        db.close();
    }
    assert.equal(f.store.journal('personal').length, 1);
});
test('a failed multi-event append rolls back journal and projection together', async (t) => {
    const f = await fixture(t);
    const before = f.store.state('personal');
    const event = { type: 'work.created', data: { id: 'w', title: 'Refund', goal: 'Receipt confirmed', threadId: 'im' } };
    assert.throws(() => f.store.append('personal', before.version, [event, event]), /exists|duplicate/i);
    assert.deepEqual(f.store.state('personal'), before);
    assert.equal(f.store.journal('personal').length, 1);
});
test('stale stream revisions cannot overwrite newer state', async (t) => {
    const f = await fixture(t);
    const old = f.store.state('personal').version;
    createWork(f);
    assert.throws(() => f.store.append('personal', old, []), /conflict|version/i);
});
test('duplicate delivery returns the original immutable message and one inbox item', async (t) => {
    const f = await fixture(t);
    const one = f.store.ingest('personal', message('m1'));
    const two = f.store.ingest('personal', message('m1'));
    assert.equal(one.id, two.id);
    assert.equal(f.store.inbox('personal').length, 1);
    assert.equal(f.store.threadMessages('personal', 'im').length, 1);
});
test('same delivery key with altered content is rejected', async (t) => {
    const f = await fixture(t);
    f.store.ingest('personal', message('m1'));
    assert.throws(() => f.store.ingest('personal', message('m1', { text: 'Changed content' })), /collision|conflict/i);
});
test('source bindings and workspaces scope delivery deduplication', async (t) => {
    const f = await fixture(t);
    f.store.createWorkspace('business', 'owner');
    f.store.ingest('personal', message('m1'));
    f.store.ingest('personal', message('m1', { source: 'relay:account-b' }));
    f.store.ingest('business', message('m1'));
    assert.equal(f.store.inbox('personal').length, 2);
    assert.equal(f.store.inbox('business').length, 1);
});
test('workspace-scoped state and artifacts do not leak to another workspace', async (t) => {
    const f = await fixture(t);
    f.store.createWorkspace('business', 'owner');
    createWork(f);
    const event = f.store.ingest('personal', message('m1', { text: 'Private synthetic note' }));
    assert.equal(Object.keys(f.store.state('business').works).length, 0);
    assert.throws(() => f.store.readArtifact('business', event.event.data.artifactId), /not found/i);
    assert.throws(() => f.store.state('missing'), /workspace/i);
});
test('fresh process connection restores current state and raw history', async (t) => {
    const f = await fixture(t);
    createWork(f);
    const event = f.store.ingest('personal', message('m1'));
    const before = f.store.state('personal');
    f.restart();
    assert.deepEqual(f.store.state('personal'), before);
    assert.equal(f.store.readArtifact('personal', event.event.data.artifactId), 'Message m1');
});
test('rebuild yields identical state without replaying external effects', async (t) => {
    const f = await fixture(t);
    createWork(f);
    f.operator.linkThread('personal', 'owner', 'w', 'email');
    const before = f.store.state('personal');
    const history = f.store.journal('personal');
    f.store.rebuild('personal');
    assert.deepEqual(f.store.state('personal'), before);
    assert.deepEqual(f.store.journal('personal'), history);
});
test('inbox acknowledgement is atomic with resulting domain events', async (t) => {
    const f = await fixture(t);
    const incoming = f.store.ingest('personal', message('m1'));
    const v = f.store.state('personal').version;
    assert.throws(() => f.store.completeInbox('personal', incoming.id, v, [
        { type: 'work.phase_changed', data: { id: 'missing', phase: 'done', evidenceRef: 'missing' } }
    ]));
    assert.equal(f.store.inbox('personal').length, 1);
    f.store.completeInbox('personal', incoming.id, v, []);
    assert.equal(f.store.inbox('personal').length, 0);
    assert.throws(() => f.store.completeInbox('personal', incoming.id, f.store.state('personal').version, []), /handled|processed/i);
});
test('unknown event schema and invalid event payload fail without a state mutation', async (t) => {
    const f = await fixture(t);
    const before = f.store.state('personal');
    assert.throws(() => f.store.append('personal', before.version, [{ type: 'unrecognized', data: {} }]), /unknown|unsupported/i);
    assert.throws(() => f.store.append('personal', before.version, [{ type: 'work.created', data: { id: 'w' } }]));
    assert.deepEqual(f.store.state('personal'), before);
});
test('historical stateAt reconstructs an earlier revision without changing current state', async (t) => {
    const f = await fixture(t);
    createWork(f);
    const revision = f.store.state('personal').version;
    f.operator.setWorkPhase('personal', 'owner', 'w', 'waiting_external');
    assert.equal(typeof f.store.stateAt, 'function', 'Historical stateAt is not implemented.');
    const old = f.store.stateAt('personal', revision);
    assert.equal(old.works.w.phase, 'open');
    assert.equal(f.store.state('personal').works.w.phase, 'waiting_external');
    assert.throws(() => f.store.stateAt('personal', 999999), /revision|range/i);
});
