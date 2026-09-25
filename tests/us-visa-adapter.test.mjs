import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  US_VISA_CHINA_CONTRACT_VERSION,
  US_VISA_CHINA_STATE_IDS,
  SyntheticPortalState,
  executeSyntheticUsVisaBooking,
  recognizeUsVisaChinaPageState
} from '../dist/index.js';

const digest = character => character.repeat(64);
const rosterDigest = createHash('sha256').update('synthetic-group-roster').digest('hex');
const slot = { id: 'slot-2027-01-04-0900', date: '2027-01-04', time: '09:00',
  location: 'Beijing', timeZone: 'Asia/Shanghai', rosterDigest, evidenceDigest: digest('a') };

function states() {
  const common = { contractVersion: US_VISA_CHINA_CONTRACT_VERSION };
  const booking = { referenceDigest: digest('9'), status: 'booked', date: slot.date, time: slot.time,
    location: 'Beijing', timeZone: 'Asia/Shanghai', rosterDigest };
  return [
    { ...common, stateId: 'login', usernameFieldPresent: true, passwordFieldPresent: true, submitPresent: true },
    { ...common, stateId: 'security_question', answerFieldPresent: true, submitPresent: true },
    { ...common, stateId: 'identity', identityDigest: digest('1') },
    { ...common, stateId: 'group_roster', rosterDigest, memberCount: 3, complete: true },
    { ...common, stateId: 'appointment_absence', absent: true, complete: true },
    { ...common, stateId: 'terms', termsDigest: digest('3'), decisionRequired: true },
    { ...common, stateId: 'calendar_coverage', location: 'Beijing', timeZone: 'Asia/Shanghai',
      startDate: '2026-12-15', endDate: '2027-01-31', page: 2, hasNext: false, candidatesPresent: true },
    { ...common, stateId: 'candidate', candidate: slot },
    { ...common, stateId: 'pre_mutation_review', candidate: slot, rosterDigest,
      appointmentAbsent: true, bookingType: 'new_group_appointment' },
    { ...common, stateId: 'submitted', intentDigest: digest('8'), status: 'submitted' },
    { ...common, stateId: 'confirmation', booking },
    { ...common, stateId: 'authoritative_readback', complete: true, booking }
  ];
}

test('every versioned visa page contract accepts only its exact bounded field set', () => {
  const fixtures = states();
  assert.deepEqual(fixtures.map(value => recognizeUsVisaChinaPageState(value).state.stateId),
    US_VISA_CHINA_STATE_IDS);
  for (const value of fixtures) {
    assert.deepEqual(recognizeUsVisaChinaPageState({ ...value, unexpected: true }), { result: 'contract_changed' });
  }
  assert.deepEqual(recognizeUsVisaChinaPageState({ contractVersion: 2, stateId: 'login',
    usernameFieldPresent: true, passwordFieldPresent: true, submitPresent: true }), { result: 'contract_changed' });
  assert.deepEqual(recognizeUsVisaChinaPageState({ contractVersion: 1, stateId: 'login',
    usernameFieldPresent: true, passwordFieldPresent: false, submitPresent: true }),
  { result: 'contract_changed' });
  assert.deepEqual(recognizeUsVisaChinaPageState({ contractVersion: 1, stateId: 'security_question',
    answerFieldPresent: true, submitPresent: false }), { result: 'contract_changed' });
  assert.deepEqual(recognizeUsVisaChinaPageState({ contractVersion: 1, stateId: 'unknown' }),
    { result: 'contract_changed' });
});

function runningAction(overrides = {}) {
  return {
    id: 'action-visa', workId: 'work', key: 'monitor:grant:observation', digest: digest('d'),
    workRevision: 1, status: 'running', attemptId: 'attempt-visa',
    monitoredGrant: { id: 'grant-visa', digest: digest('6'), revision: 1 },
    command: {
      kind: 'operation.execute', operationId: 'us-visa-china', operationVersion: '1',
      connectionId: 'connection-visa', provider: 'visa-scheduling', subject: 'opaque-account',
      connectionGeneration: 1, resourceId: 'group-appointment',
      arguments: { bookingType: 'new_group_appointment', candidateId: slot.id, date: slot.date, time: slot.time,
        location: 'Beijing', timeZone: 'Asia/Shanghai', rosterDigest,
        identityDigest: digest('1'), termsDigest: digest('3'), evidenceDigest: digest('a') },
      affectedResourceIds: ['group-appointment'],
      precondition: { source: 'us-visa-china:synthetic', observedAt: '2026-12-01T12:00:00.000Z',
        state: { appointmentAbsent: true, identityDigest: digest('1'), rosterDigest,
          termsDigest: digest('3'), candidateEvidenceDigest: digest('a') } },
      expectedResult: { status: 'booked', date: slot.date, time: slot.time, location: 'Beijing',
        timeZone: 'Asia/Shanghai', rosterDigest }, subjectRevision: 0,
      requestFingerprint: digest('f')
    }, ...overrides
  };
}

function portalPort(portal) {
  return {
    inspect: () => portal.inspect(),
    recordDurableIntent: (intentId, slotId) => portal.recordDurableIntent(intentId, slotId),
    gesture(command) {
      const snapshot = portal.gesture(command);
      if (snapshot.state === 'booking_review') return { state: 'booking_review', candidate: slot,
        identityDigest: digest('1'), rosterDigest, termsDigest: digest('3'), appointmentAbsent: true,
        bookingType: 'new_group_appointment' };
      return snapshot.booking ? { ...snapshot,
        booking: { ...snapshot.booking, status: 'booked', timeZone: 'Asia/Shanghai' } } : snapshot;
    }
  };
}

test('pre-submit review is exact and bound to candidate identity roster terms and appointment absence', async () => {
  const validReview = { state: 'booking_review', candidate: slot, identityDigest: digest('1'), rosterDigest,
    termsDigest: digest('3'), appointmentAbsent: true, bookingType: 'new_group_appointment' };
  const changed = [
    (({ identityDigest: _value, ...rest }) => rest)(validReview),
    { ...validReview, unexpected: true },
    { ...validReview, candidate: { ...slot, id: 'slot-foreign' } },
    { ...validReview, candidate: { ...slot, date: '2027-01-05' } },
    { ...validReview, candidate: { ...slot, time: '10:00' } },
    { ...validReview, candidate: { ...slot, location: 'Shanghai' } },
    { ...validReview, candidate: { ...slot, rosterDigest: digest('9') } },
    { ...validReview, identityDigest: digest('9') },
    { ...validReview, rosterDigest: digest('9') },
    { ...validReview, termsDigest: digest('9') },
    { ...validReview, appointmentAbsent: false },
    { ...validReview, bookingType: 'reschedule' }
  ];
  for (const review of changed) {
    const portal = new SyntheticPortalState({ scenario: 'calendar_match' });
    portal.gesture({ kind: 'calendar.next_page' });
    const base = portalPort(portal);
    const result = await executeSyntheticUsVisaBooking({ action: runningAction(),
      portal: { ...base, gesture: command => command.kind === 'slot.select' ? review : base.gesture(command) },
      expected: { identityDigest: digest('1'), rosterDigest, termsDigest: digest('3') },
      async preflight() { return { appointmentAbsent: true, identityDigest: digest('1'), rosterDigest,
        termsDigest: digest('3'), candidate: slot }; },
      fence: { serviceGeneration: 'service', deadline: Date.now() + 10_000,
        signal: new AbortController().signal, async assertCurrent() {} } });
    assert.deepEqual(result, { status: 'failed', reason: 'contract_changed' });
    assert.equal(portal.mutationCount, 0);
  }
});

test('synthetic execution requires a reserved running action, rechecks the fence, and verifies exact readback', async () => {
  const portal = new SyntheticPortalState({ scenario: 'calendar_match' });
  portal.gesture({ kind: 'calendar.next_page' });
  let fenceChecks = 0;
  const result = await executeSyntheticUsVisaBooking({
    action: runningAction(), portal: portalPort(portal),
    expected: { identityDigest: digest('1'), rosterDigest, termsDigest: digest('3') },
    async preflight() { return { appointmentAbsent: true, identityDigest: digest('1'),
      rosterDigest, termsDigest: digest('3'), candidate: slot }; },
    fence: { serviceGeneration: 'service', deadline: Date.now() + 10_000,
      signal: new AbortController().signal, async assertCurrent() { fenceChecks++; } }
  });
  assert.equal(result.status, 'accepted');
  assert.equal(result.verification.status, 'satisfied');
  assert.equal(result.receipt.location, 'Beijing');
  assert.equal(result.receipt.rosterDigest, rosterDigest);
  assert.equal(portal.mutationCount, 1);
  assert.ok(fenceChecks >= 8);
});

test('synthetic execution refuses unreserved, existing-appointment, and drifted preflight states before mutation', async () => {
  const wrongExpected = runningAction();
  wrongExpected.command = { ...wrongExpected.command,
    expectedResult: { ...wrongExpected.command.expectedResult, location: 'Shanghai' } };
  for (const entry of [
    { action: runningAction({ status: 'approved', attemptId: undefined }), preflight: { appointmentAbsent: true,
      identityDigest: digest('1'), rosterDigest, termsDigest: digest('3'), candidate: slot } },
    { action: runningAction({ monitoredGrant: { id: 'grant-visa', digest: 'bad', revision: 1 } }),
      preflight: { appointmentAbsent: true, identityDigest: digest('1'), rosterDigest,
        termsDigest: digest('3'), candidate: slot } },
    { action: wrongExpected, preflight: { appointmentAbsent: true,
      identityDigest: digest('1'), rosterDigest, termsDigest: digest('3'), candidate: slot } },
    { action: runningAction(), preflight: { appointmentAbsent: false,
      identityDigest: digest('1'), rosterDigest, termsDigest: digest('3'), candidate: slot } },
    { action: runningAction(), preflight: { appointmentAbsent: true,
      identityDigest: digest('1'), rosterDigest: digest('9'), termsDigest: digest('3'), candidate: slot } }
  ]) {
    const portal = new SyntheticPortalState({ scenario: 'calendar_match' });
    portal.gesture({ kind: 'calendar.next_page' });
    await assert.rejects(executeSyntheticUsVisaBooking({ action: entry.action, portal: portalPort(portal),
      expected: { identityDigest: digest('1'), rosterDigest, termsDigest: digest('3') },
      async preflight() { return entry.preflight; },
      fence: { serviceGeneration: 'service', deadline: Date.now() + 10_000,
        signal: new AbortController().signal, async assertCurrent() {} } }), /reserved|preflight|appointment|drift/i);
    assert.equal(portal.mutationCount, 0);
  }
});
