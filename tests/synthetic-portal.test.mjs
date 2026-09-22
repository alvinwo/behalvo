import test from 'node:test';
import assert from 'node:assert/strict';
import { SyntheticPortalState, startSyntheticPortal } from '../dist/index.js';

test('synthetic portal exposes every required page/result class without private data', () => {
  const portal = new SyntheticPortalState();
  const cases = [
    ['login', 'login'], ['security_question', 'security_question'], ['group_roster', 'group_roster'],
    ['calendar_empty', 'calendar'], ['calendar_match', 'calendar'], ['slot_race', 'calendar'],
    ['booking_review', 'booking_review'],
    ['challenge', 'challenge'], ['session_expired', 'session_expired'], ['forbidden', 'forbidden'],
    ['rate_limited', 'rate_limited'], ['terms_changed', 'terms_changed'], ['unknown', 'unknown'],
    ['confirmation', 'confirmation'], ['ambiguous_submission', 'ambiguous_submission'],
    ['appointment', 'appointment']
  ];
  for (const [scenario, expected] of cases) {
    portal.setScenario(scenario);
    const snapshot = portal.inspect();
    assert.equal(snapshot.state, expected);
    assert.equal(/password|securityAnswer|cookie|token|html/.test(JSON.stringify(snapshot)), false);
  }
});

test('calendar pagination, slot race, confirmation, ambiguity, and authoritative readback are deterministic', () => {
  const portal = new SyntheticPortalState({ scenario: 'calendar_match' });
  assert.equal(portal.inspect().page, 1);
  portal.gesture({ kind: 'calendar.next_page' });
  const slot = portal.inspect().candidates[0];
  portal.recordDurableIntent('intent-1', slot.id);
  portal.gesture({ kind: 'slot.select', slotId: slot.id });
  portal.gesture({ kind: 'booking.submit', slotId: slot.id, intentId: 'intent-1' });
  assert.equal(portal.inspect().state, 'confirmation');
  assert.equal(portal.mutationCount, 1);
  assert.equal(portal.authoritativeReadback().state, 'appointment');

  const raced = new SyntheticPortalState({ scenario: 'slot_race' });
  const racedSlot = raced.inspect().candidates[0];
  raced.recordDurableIntent('intent-race', racedSlot.id);
  raced.gesture({ kind: 'slot.select', slotId: racedSlot.id });
  assert.equal(raced.inspect().candidates.length, 0);
  assert.equal(raced.mutationCount, 0);

  const ambiguous = new SyntheticPortalState({ scenario: 'calendar_match', ambiguousSubmission: true });
  ambiguous.gesture({ kind: 'calendar.next_page' });
  const ambiguousSlot = ambiguous.inspect().candidates[0];
  ambiguous.recordDurableIntent('intent-2', ambiguousSlot.id);
  ambiguous.gesture({ kind: 'slot.select', slotId: ambiguousSlot.id });
  ambiguous.gesture({ kind: 'booking.submit', slotId: ambiguousSlot.id, intentId: 'intent-2' });
  assert.equal(ambiguous.inspect().state, 'ambiguous_submission');
  assert.equal(ambiguous.authoritativeReadback().state, 'appointment');
});

test('synthetic portal server binds loopback, checks origin, and maps 403/429 states', async t => {
  const state = new SyntheticPortalState({ scenario: 'calendar_empty' });
  const server = await startSyntheticPortal({ state, port: 0 });
  t.after(() => server.close());
  assert.match(server.origin, /^http:\/\/127\.0\.0\.1:/);
  const response = await fetch(`${server.origin}/api/state`);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).state, 'calendar');
  const rejected = await fetch(`${server.origin}/api/gesture`, { method: 'POST',
    headers: { origin: 'https://example.test', 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'calendar.next_page' }) });
  assert.equal(rejected.status, 403);
  state.setScenario('forbidden');
  assert.equal((await fetch(`${server.origin}/`)).status, 403);
  state.setScenario('rate_limited');
  assert.equal((await fetch(`${server.origin}/`)).status, 429);
});

test('served portal HTML mirrors authoritative state and its fixed form controls complete the workflow', async t => {
  const state = new SyntheticPortalState({ scenario: 'calendar_match', ambiguousSubmission: true });
  const server = await startSyntheticPortal({ state, port: 0 });
  t.after(() => server.close());
  const page = async () => (await fetch(`${server.origin}/`)).text();
  const gesture = async fields => fetch(`${server.origin}/gesture`, { method: 'POST', redirect: 'manual',
    headers: { origin: server.origin, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields) });

  let html = await page();
  assert.match(html, /data-behalvo-page="1"/);
  assert.match(html, /data-behalvo-has-next="true"/);
  assert.doesNotMatch(html, /data-behalvo-slot-id=/);
  assert.equal((await gesture({ kind: 'calendar.next_page' })).status, 303);
  html = await page();
  assert.match(html, /data-behalvo-page="2"/);
  assert.match(html, /data-behalvo-slot-id="slot-2027-01-04-0900"/);
  const invalidIntent = await fetch(`${server.origin}/api/intent`, { method: 'POST',
    headers: { origin: server.origin, 'content-type': 'application/json' },
    body: JSON.stringify({ intentId: 7, slotId: 'slot-2027-01-04-0900' }) });
  assert.equal(invalidIntent.status, 400);
  const intent = await fetch(`${server.origin}/api/intent`, { method: 'POST',
    headers: { origin: server.origin, 'content-type': 'application/json' },
    body: JSON.stringify({ intentId: 'intent-http', slotId: 'slot-2027-01-04-0900' }) });
  assert.equal(intent.status, 200);
  assert.equal((await gesture({ kind: 'slot.select', slotId: 'slot-2027-01-04-0900' })).status, 303);
  assert.equal(state.inspect().state, 'booking_review');
  html = await page();
  assert.match(html, /data-behalvo-gesture="booking.submit"/);
  assert.match(html, /data-behalvo-intent-id="intent-http"/);
  assert.equal((await gesture({ kind: 'booking.submit', slotId: 'slot-2027-01-04-0900',
    intentId: 'wrong-intent' })).status, 400);
  assert.equal(state.mutationCount, 0);
  assert.equal((await gesture({ kind: 'booking.submit', slotId: 'slot-2027-01-04-0900',
    intentId: 'intent-http' })).status, 303);
  assert.equal(state.inspect().state, 'ambiguous_submission');
  assert.equal(state.mutationCount, 1);
  assert.match(await page(), /data-behalvo-gesture="appointment.readback"/);
  assert.equal((await gesture({ kind: 'appointment.readback' })).status, 303);
  assert.equal(state.inspect().state, 'appointment');

  state.setScenario('slot_race');
  assert.match(await page(), /data-behalvo-slot-id="slot-2027-01-04-0900"/);
  assert.equal((await gesture({ kind: 'slot.select', slotId: 'slot-2027-01-04-0900' })).status, 303);
  assert.doesNotMatch(await page(), /data-behalvo-slot-id=/);
});
