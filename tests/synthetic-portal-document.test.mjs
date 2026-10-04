import test from 'node:test';
import assert from 'node:assert/strict';
import { startSyntheticPortal } from '../dist/synthetic-portal/server.js';
import { SyntheticPortalState } from '../dist/synthetic-portal/state.js';

async function fixture(t, formResponse) {
  const state = new SyntheticPortalState({ scenario: 'calendar_match' });
  const portal = await startSyntheticPortal({ port: 0, state, ...(formResponse ? { formResponse } : {}) });
  t.after(() => portal.close());
  return { state, post: body => fetch(`${portal.origin}/gesture`, {
    method: 'POST', redirect: 'manual', headers: { origin: portal.origin,
      'content-type': 'application/x-www-form-urlencoded' }, body }) };
}
test('document mode returns actual destination HTML without a redirect', async t => {
  const f = await fixture(t, 'document');
  const response = await f.post(`kind=calendar.next_page&_behalvo_dispatch=${'a'.repeat(64)}`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('location'), null);
  assert.match(response.headers.get('content-type'), /^text\/html/);
  const html = await response.text();
  assert.match(html, /data-behalvo-page-state="calendar"/);
  assert.match(html, /data-behalvo-page="2"/);
  assert.match(html, /slot-2027-01-04-0900/);
  assert.equal(f.state.inspect().page, 2);
});
for (const [name, suffix] of [
  ['missing', ''], ['malformed', '&_behalvo_dispatch=bad'],
  ['duplicate', `&_behalvo_dispatch=${'a'.repeat(64)}&_behalvo_dispatch=${'a'.repeat(64)}`],
  ['extra', `&_behalvo_dispatch=${'a'.repeat(64)}&extra=value`]
]) test(`document mode rejects ${name} dispatch fields without state change`, async t => {
  const f = await fixture(t, 'document');
  assert.equal((await f.post(`kind=calendar.next_page${suffix}`)).status, 400);
  assert.equal(f.state.inspect().page, 1);
});
test('default form contract still redirects and rejects dispatch metadata', async t => {
  const f = await fixture(t);
  assert.equal((await f.post(`kind=calendar.next_page&_behalvo_dispatch=${'a'.repeat(64)}`)).status, 400);
  const response = await f.post('kind=calendar.next_page');
  assert.equal(response.status, 303);
  assert.equal(response.headers.get('location'), '/');
});
test('unknown form response mode is rejected before binding', async () => {
  await assert.rejects(async () => {
    const unexpected = await startSyntheticPortal({ port: 0, formResponse: 'unexpected' });
    await unexpected.close();
  });
});
