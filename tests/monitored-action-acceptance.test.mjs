import assert from 'node:assert/strict';
import test from 'node:test';

import { SyntheticPortalState } from '../dist/index.js';

test('synthetic human and provider fixture controls preserve evidence and expose distinct candidates monotonically', () => {
  const portal = new SyntheticPortalState({ scenario: 'calendar_empty' });

  portal.beginHumanChallenge();
  assert.equal(portal.inspect().state, 'challenge');
  portal.completeHumanChallenge();
  assert.equal(portal.inspect().state, 'calendar');
  assert.equal(portal.mutationCount, 0);

  portal.publishCandidateBeforeReservation();
  portal.gesture({ kind: 'calendar.next_page' });
  const first = portal.inspect();
  assert.equal(first.state, 'calendar');
  assert.equal(first.candidates.length, 1);
  const firstCandidate = first.candidates[0];

  portal.withdrawCandidateBeforeReservation();
  assert.equal(portal.inspect().state, 'calendar');
  assert.equal(portal.mutationCount, 0);
  portal.publishLaterCandidate();
  portal.gesture({ kind: 'calendar.next_page' });
  const later = portal.inspect();
  assert.equal(later.state, 'calendar');
  assert.equal(later.candidates.length, 1);
  assert.notEqual(later.candidates[0].id, firstCandidate.id);

  const intentId = 'acceptance-intent';
  portal.gesture({ kind: 'booking.intent', slotId: later.candidates[0].id, intentId });
  portal.gesture({ kind: 'slot.select', slotId: later.candidates[0].id });
  portal.gesture({ kind: 'booking.submit', slotId: later.candidates[0].id, intentId });
  assert.equal(portal.mutationCount, 1);
  assert.equal(portal.authoritativeReadback().state, 'appointment');
  assert.throws(() => portal.beginHumanChallenge(), /booking|terminal|state/i);
  assert.equal(portal.mutationCount, 1);
  assert.equal(portal.authoritativeReadback().state, 'appointment');
});
