import test from 'node:test';
import assert from 'node:assert/strict';
import {
  US_VISA_CHINA_ADAPTER_ID,
  US_VISA_CHINA_ADAPTER_VERSION,
  createUsVisaChinaPolicyAdapter
} from '../dist/index.js';

const digest = character => character.repeat(64);
const scope = (overrides = {}) => ({
  bookingType: 'new_group_appointment',
  location: 'Beijing',
  timeZone: 'Asia/Shanghai',
  startDate: '2026-12-15',
  endDate: '2027-01-31',
  eligibleTimes: 'any_offered_working_time',
  selection: 'earliest',
  maximumEffects: 1,
  provider: 'visa-scheduling',
  providerSubject: 'opaque-account',
  resourceId: 'group-appointment',
  identityDigest: digest('1'),
  rosterDigest: digest('2'),
  termsDigest: digest('3'),
  ...overrides
});

const grant = scopeValue => ({
  id: 'grant-visa', workspaceId: 'workspace', ownerId: 'owner',
  adapter: US_VISA_CHINA_ADAPTER_ID, adapterVersion: US_VISA_CHINA_ADAPTER_VERSION,
  connectionId: 'connection-visa', connectionGeneration: 3, browserProfileId: 'profile-visa',
  subjectDigest: digest('4'), scope: scopeValue, maximumEffects: 1,
  expiresAt: '2027-01-31T15:59:59.999Z', createdAt: '2026-09-21T12:00:00.000Z',
  revision: 1, digest: digest('5'), status: 'active', activatedAt: '2026-09-21T12:01:00.000Z',
  installationGeneration: 'installation-visa'
});

const coverage = (overrides = {}) => ({
  contractVersion: 1,
  location: 'Beijing', timeZone: 'Asia/Shanghai',
  startDate: '2026-12-15', endDate: '2027-01-31',
  firstPage: 1, lastPage: 3, inspectedPages: [1, 2, 3],
  paginationComplete: true, appointmentAbsent: true,
  identityDigest: digest('1'), rosterDigest: digest('2'), termsDigest: digest('3'),
  ...overrides
});

const candidate = (id, date, time, overrides = {}) => ({
  id, date, time, location: 'Beijing', timeZone: 'Asia/Shanghai',
  rosterDigest: digest('2'), evidenceDigest: digest(id === 'slot-a' ? 'a' : id === 'slot-b' ? 'b' : 'c'),
  ...overrides
});

function observation(candidates, coverageValue = coverage()) {
  return { observedAt: '2026-12-01T12:00:00.000Z', complete: true,
    coverage: coverageValue, candidates, result: 'complete' };
}

test('visa scope is one exact new Beijing group appointment and rejects prohibited changes', () => {
  const adapter = createUsVisaChinaPolicyAdapter();
  assert.deepEqual(adapter.validateScope(scope()), scope());
  for (const changed of [
    scope({ bookingType: 'reschedule' }), scope({ location: 'Shanghai' }),
    scope({ timeZone: 'UTC' }), scope({ startDate: '2026-12-14' }),
    scope({ endDate: '2027-02-01' }), scope({ maximumEffects: 2 }),
    scope({ paymentAllowed: true }), scope({ rosterChangesAllowed: true })
  ]) assert.throws(() => adapter.validateScope(changed), /visa scope/i);
});

test('visa coverage must be complete, contiguous, fresh-bound, and match identity roster terms and absence', () => {
  const adapter = createUsVisaChinaPolicyAdapter();
  const normalized = adapter.validateScope(scope());
  assert.equal(adapter.coverageSufficient(normalized, coverage()), true);
  for (const changed of [
    coverage({ inspectedPages: [1, 3] }), coverage({ paginationComplete: false }),
    coverage({ appointmentAbsent: false }), coverage({ location: 'Shanghai' }),
    coverage({ timeZone: 'UTC' }), coverage({ startDate: '2026-12-16' }),
    coverage({ rosterDigest: digest('9') }), coverage({ identityDigest: digest('8') }),
    coverage({ termsDigest: digest('7') }), coverage({ contractVersion: 2 })
  ]) assert.equal(adapter.coverageSufficient(normalized, changed), false);
});

test('visa policy accepts inclusive boundary dates and deterministically selects earliest time with stable tie-break', () => {
  const adapter = createUsVisaChinaPolicyAdapter();
  const normalized = adapter.validateScope(scope());
  const candidates = [
    candidate('slot-z', '2027-01-31', '17:30'),
    candidate('slot-b', '2026-12-15', '09:00'),
    candidate('slot-a', '2026-12-15', '09:00')
  ];
  const command = adapter.selectCommand({ grant: grant(normalized), scope: normalized,
    observation: observation(candidates) });
  assert.equal(command.operationId, US_VISA_CHINA_ADAPTER_ID);
  assert.equal(command.operationVersion, String(US_VISA_CHINA_ADAPTER_VERSION));
  assert.deepEqual(command.arguments, {
    bookingType: 'new_group_appointment', candidateId: 'slot-a', date: '2026-12-15', time: '09:00',
    location: 'Beijing', timeZone: 'Asia/Shanghai', rosterDigest: digest('2'),
    identityDigest: digest('1'), termsDigest: digest('3'), evidenceDigest: digest('a')
  });
  assert.deepEqual(command.expectedResult, {
    status: 'booked', date: '2026-12-15', time: '09:00', location: 'Beijing',
    timeZone: 'Asia/Shanghai', rosterDigest: digest('2')
  });
});

test('visa policy rejects wrong date location timezone roster and non-unique evidence', () => {
  const adapter = createUsVisaChinaPolicyAdapter();
  const normalized = adapter.validateScope(scope());
  for (const item of [
    candidate('slot-before', '2026-12-14', '09:00'),
    candidate('slot-after', '2027-02-01', '09:00'),
    candidate('slot-city', '2026-12-15', '09:00', { location: 'Shanghai' }),
    candidate('slot-zone', '2026-12-15', '09:00', { timeZone: 'UTC' }),
    candidate('slot-roster', '2026-12-15', '09:00', { rosterDigest: digest('9') })
  ]) assert.throws(() => adapter.selectCommand({ grant: grant(normalized), scope: normalized,
    observation: observation([item]) }), /candidate|visa/i);

  const duplicateId = [candidate('slot-a', '2026-12-15', '09:00'),
    candidate('slot-a', '2026-12-16', '09:00')];
  assert.throws(() => adapter.selectCommand({ grant: grant(normalized), scope: normalized,
    observation: observation(duplicateId) }), /unique|candidate evidence/i);
  const duplicateEvidence = [candidate('slot-a', '2026-12-15', '09:00'),
    candidate('slot-b', '2026-12-16', '09:00', { evidenceDigest: digest('a') })];
  assert.throws(() => adapter.selectCommand({ grant: grant(normalized), scope: normalized,
    observation: observation(duplicateEvidence) }), /unique|candidate evidence/i);
});
