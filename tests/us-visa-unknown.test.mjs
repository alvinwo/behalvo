import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  LIVE_US_VISA_NATIVE_HOST_REGISTRATION,
  SyntheticPortalState,
  executeSyntheticUsVisaBooking,
  verifySyntheticUsVisaBooking
} from '../dist/index.js';

const digest = character => character.repeat(64);
const rosterDigest = createHash('sha256').update('synthetic-group-roster').digest('hex');
const slot = { id: 'slot-2027-01-04-0900', date: '2027-01-04', time: '09:00',
  location: 'Beijing', timeZone: 'Asia/Shanghai', rosterDigest, evidenceDigest: digest('a') };

function action(status = 'running') {
  return { id: 'action', status, attemptId: 'attempt', monitoredGrant: { id: 'grant', digest: digest('6'), revision: 1 },
    command: { operationId: 'us-visa-china', operationVersion: '1',
      arguments: { bookingType: 'new_group_appointment', candidateId: slot.id,
      date: slot.date, time: slot.time, location: 'Beijing', timeZone: 'Asia/Shanghai',
      rosterDigest, identityDigest: digest('1'), termsDigest: digest('3'), evidenceDigest: digest('a') },
      expectedResult: { status: 'booked', date: slot.date, time: slot.time, location: 'Beijing',
        timeZone: 'Asia/Shanghai', rosterDigest } } };
}

function portalPort(portal, overrides = {}) {
  return { inspect: () => portal.inspect(),
    recordDurableIntent: (intentId, slotId) => portal.recordDurableIntent(intentId, slotId),
    gesture: command => {
      if (command.kind === 'appointment.readback' && overrides.readback) return overrides.readback();
      const snapshot = withExactBooking(portal.gesture(command));
      return snapshot.state === 'booking_review' ? { state: 'booking_review', candidate: slot,
        identityDigest: digest('1'), rosterDigest, termsDigest: digest('3'), appointmentAbsent: true,
        bookingType: 'new_group_appointment' } : snapshot;
    } };
}

function withExactBooking(snapshot) {
  return snapshot.booking ? { ...snapshot,
    booking: { ...snapshot.booking, status: 'booked', timeZone: 'Asia/Shanghai' } } : snapshot;
}

const fence = () => ({ serviceGeneration: 'service', deadline: Date.now() + 10_000,
  signal: new AbortController().signal, async assertCurrent() {} });
const expected = { identityDigest: digest('1'), rosterDigest, termsDigest: digest('3') };
const preflight = async () => ({ appointmentAbsent: true, ...expected, candidate: slot });

test('ambiguous submission is unknown and verification-only; the executor never submits twice', async () => {
  const portal = new SyntheticPortalState({ scenario: 'calendar_match', ambiguousSubmission: true });
  portal.gesture({ kind: 'calendar.next_page' });
  const result = await executeSyntheticUsVisaBooking({ action: action(), portal: portalPort(portal),
    expected, preflight, fence: fence() });
  assert.equal(result.status, 'unknown');
  assert.equal(result.verificationOnly, true);
  assert.equal(portal.mutationCount, 1);
  await assert.rejects(executeSyntheticUsVisaBooking({ action: action('unknown'), portal: portalPort(portal),
    expected, preflight, fence: fence() }), /verification-only|reserved|running/i);
  assert.equal(portal.mutationCount, 1);
  const verified = await verifySyntheticUsVisaBooking({ action: action('unknown'), portal: portalPort(portal),
    fence: fence() });
  assert.equal(verified.status, 'satisfied');
  assert.equal(verified.receipt.referenceDigest.length, 64);
});

test('verification requires exact reference status Beijing date time and complete roster', async () => {
  const portal = new SyntheticPortalState({ scenario: 'appointment' });
  const base = withExactBooking(portal.authoritativeReadback()).booking;
  for (const booking of [
    (({ status: _status, ...rest }) => rest)(base),
    (({ timeZone: _timeZone, ...rest }) => rest)(base),
    { ...base, unexpected: true },
    { ...base, referenceDigest: 'bad' },
    { ...base, status: 'pending' },
    { ...base, location: 'Shanghai' },
    { ...base, date: '2027-01-05' },
    { ...base, time: '10:00' },
    { ...base, rosterDigest: digest('9') }
  ]) {
    const result = await verifySyntheticUsVisaBooking({ action: action('unknown'),
      portal: portalPort(portal, { readback: () => ({ state: 'appointment', booking }) }), fence: fence() });
    assert.equal(result.status, 'unknown');
    assert.equal(result.receipt, undefined);
  }
});

test('verification-only recovery requires the exact retained adapter and grant binding', async () => {
  const portal = new SyntheticPortalState({ scenario: 'appointment' });
  const wrongVersion = action('unknown');
  wrongVersion.command = { ...wrongVersion.command, operationVersion: '2' };
  const wrongGrant = action('unknown');
  wrongGrant.monitoredGrant = { ...wrongGrant.monitoredGrant, digest: 'bad' };
  for (const value of [wrongVersion, wrongGrant]) {
    const result = await verifySyntheticUsVisaBooking({ action: value, portal: portalPort(portal), fence: fence() });
    assert.deepEqual(result, { status: 'unknown' });
  }
});

test('confirmation and authoritative appointment readback are distinct and retain one reference', async () => {
  const portal = new SyntheticPortalState({ scenario: 'calendar_match' });
  portal.gesture({ kind: 'calendar.next_page' });
  const base = portalPort(portal);
  const result = await executeSyntheticUsVisaBooking({ action: action(), portal: {
    ...base,
    gesture: async command => {
      const snapshot = await base.gesture(command);
      if (command.kind === 'appointment.readback' && snapshot.state === 'appointment') return {
        ...snapshot, booking: { ...snapshot.booking, referenceDigest: digest('7') } };
      return snapshot;
    }
  }, expected, preflight, fence: fence() });
  assert.deepEqual(result, { status: 'unknown', verificationOnly: true });
  assert.equal(portal.mutationCount, 1);

  const confirmationOnly = await verifySyntheticUsVisaBooking({ action: action('unknown'), portal: {
    ...portalPort(new SyntheticPortalState({ scenario: 'appointment' })),
    gesture: () => ({ state: 'confirmation', booking: {
      referenceDigest: digest('9'), status: 'booked', date: slot.date, time: slot.time,
      location: 'Beijing', timeZone: 'Asia/Shanghai', rosterDigest } })
  }, fence: fence() });
  assert.deepEqual(confirmationOnly, { status: 'unknown' });
});

test('a thrown transport error after submit is fixed unknown and never exposes or retries it', async () => {
  const portal = new SyntheticPortalState({ scenario: 'calendar_match' });
  portal.gesture({ kind: 'calendar.next_page' });
  const base = portalPort(portal);
  let submits = 0;
  const result = await executeSyntheticUsVisaBooking({ action: action(), portal: { ...base,
    gesture: command => {
      const snapshot = base.gesture(command);
      if (command.kind === 'booking.submit') { submits++; throw new Error('RAW_PROVIDER_SECRET'); }
      return snapshot;
    }
  }, expected, preflight, fence: fence() });
  assert.deepEqual(result, { status: 'unknown', verificationOnly: true });
  assert.equal(submits, 1);
  assert.equal(portal.mutationCount, 1);
});

test('repository ships no live native-host registration', () => {
  assert.equal(LIVE_US_VISA_NATIVE_HOST_REGISTRATION, null);
});
