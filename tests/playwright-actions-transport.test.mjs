import test from 'node:test';
import assert from 'node:assert/strict';
import { actionsFixture } from './helpers/playwright-actions-fixture.mjs';

for (const [field, value] of [['profileId', 'other'], ['connectionGeneration', 2], ['serviceGeneration', 'other'],
  ['tabId', 2], ['origin', 'http://127.0.0.1:43118'], ['epoch', 'f'.repeat(64)], ['sequence', 1]])
  test(`action transport rejects ${field} mismatch before dispatch`, async t => {
    const f = await actionsFixture(); t.after(() => f.transport.close());
    await assert.rejects(f.transport.inspect({ ...f.request(), [field]: value }));
    assert.deepEqual(f.posts, []); await assert.rejects(f.transport.inspect(f.request()));
  });
test('action response retains source document while next inspection observes destination', async t => {
  const f = await actionsFixture(); t.after(() => f.transport.close());
  const before = await f.transport.inspect(f.request());
  const gesture = await f.gesture(); const after = await f.transport.inspect(f.request());
  assert.equal(gesture.documentId, before.documentId); assert.notEqual(after.documentId, before.documentId);
  assert.deepEqual(f.posts, ['calendar.first_page']);
});
for (const body of [value => value + '&extra=x', value => value + '&kind=calendar.first_page',
  value => value.replace(/_behalvo_dispatch=[^&]+/, '_behalvo_dispatch=invalid'),
  value => value.replace('calendar.first_page', 'booking.submit')])
  test('altered form body cannot consume a dispatch permit', async t => {
    const f = await actionsFixture({ body }); t.after(() => f.transport.close());
    await assert.rejects(f.gesture()); assert.deepEqual(f.posts, []);
  });
test('guard failure invalidates the permit before a delayed duplicate callback', async t => {
  const f = await actionsFixture(); t.after(() => f.transport.close()); let calls = 0;
  await assert.rejects(f.gesture(undefined, async () => () => { calls++; throw new Error('CANARY-GUARD'); }));
  await f.handler()(f.routes.at(-1));
  assert.equal(calls, 1); assert.deepEqual(f.posts, []);
});
test('duplicate fulfilled POST never dispatches twice', async t => {
  const f = await actionsFixture(); t.after(() => f.transport.close());
  await f.gesture(); await f.handler()(f.routes.at(-1));
  assert.deepEqual(f.posts, ['calendar.first_page']);
  await assert.rejects(f.transport.inspect(f.request()));
});
test('source document change during authorization prevents dispatch', async t => {
  const f = await actionsFixture(); t.after(() => f.transport.close());
  await assert.rejects(f.gesture(undefined, async () => { f.page.emit('framenavigated', f.frame); return () => {}; }));
  assert.deepEqual(f.posts, []);
});
test('deadline after async authorization blocks dispatch', async t => {
  const f = await actionsFixture(); t.after(() => f.transport.close());
  await assert.rejects(f.gesture(undefined, async () => { await new Promise(r => setTimeout(r, 20)); return () => {}; },
    { deadline: Date.now() + 5 }));
  assert.deepEqual(f.posts, []);
});
test('a lost response after dispatch is terminal and cannot retry', async t => {
  const f = await actionsFixture({ afterDispatch: async () => { throw new Error('CANARY-UPSTREAM'); } });
  t.after(() => f.transport.close());
  await assert.rejects(f.gesture(), error => !error.message.includes('CANARY'));
  await assert.rejects(f.gesture()); assert.deepEqual(f.posts, ['calendar.first_page']);
});
test('an old token cannot consume a later identical command permit', async t => {
  let prior;
  const f = await actionsFixture({ body: value => { if (prior) return prior; prior = value; return value; } });
  t.after(() => f.transport.close());
  await f.gesture(); await assert.rejects(f.gesture());
  assert.deepEqual(f.posts, ['calendar.first_page']);
});
for (const [name, options] of [['redirect', { status: 303, headers: { location: 'http://127.0.0.1:43118/' } }],
  ['content-type', { headers: { 'content-type': 'application/json' } }], ['oversized body', { html: 'x'.repeat(262145) }]])
  test(`unexpected ${name} never becomes a trusted document`, async () => {
    await assert.rejects(actionsFixture(options));
  });
