import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MonitoringRegistry,
  US_VISA_CHINA_STATE_IDS,
  UsVisaChinaDiscoveryRecorder,
  createUsVisaChinaContractFixture,
  usVisaChinaDefaultReadiness,
  assessUsVisaChinaReadiness,
  registerDisabledUsVisaChinaAdapter,
  createUsVisaChinaFixtureAuthenticator
} from '../dist/index.js';

const digest = character => character.repeat(64);
const auth = () => createUsVisaChinaFixtureAuthenticator({ key: Buffer.alloc(32, 7), ownerId: 'owner-1',
  installationGeneration: 'install-1', sessionDigest: digest('a') });

function discoveryReport() {
  const recorder = new UsVisaChinaDiscoveryRecorder({
    allowedOrigin: 'https://synthetic-visa.example.test',
    locallyAuthenticatedSessionDigest: digest('a')
  });
  for (const stateId of US_VISA_CHINA_STATE_IDS) {
    recorder.record({ stateId, fields: stateId === 'calendar_coverage'
      ? { locationPresent: true, timeZonePresent: true, pagePresent: true, hasNextPresent: true,
          candidatesPresence: 'present_or_empty' }
      : { requiredFields: 'present' } });
  }
  return recorder.finish({
    coverageSemantics: { inclusiveDates: true, contiguousPagination: true, completeEmptyDistinguished: true },
    termsDigest: digest('b'), ownerDecision: 'allow_read_only_discovery',
    rosterDigest: digest('c'), identityDigest: digest('d')
  });
}

test('discovery records only fixed sanitized metadata and cannot record mutating or secret material', () => {
  const report = discoveryReport();
  assert.deepEqual(report.observedStateIds, US_VISA_CHINA_STATE_IDS);
  assert.equal(report.allowedOrigin, 'https://synthetic-visa.example.test');
  assert.equal(JSON.stringify(report).includes('selector'), false);
  const recorder = new UsVisaChinaDiscoveryRecorder({
    allowedOrigin: 'https://synthetic-visa.example.test', locallyAuthenticatedSessionDigest: digest('a')
  });
  for (const unsafe of [
    { stateId: 'login', fields: { rawDom: '<input>' } },
    { stateId: 'login', fields: { password: 'secret' } },
    { stateId: 'login', fields: { selector: '#submit' } },
    { stateId: 'login', fields: { click: 'submit' } },
    { stateId: 'login', fields: { arbitraryText: 'portal copy' } }
  ]) assert.throws(() => recorder.record(unsafe), /discovery|sanitized/i);
  assert.throws(() => recorder.record({ stateId: 'login',
    fields: { locationPresent: true } }), /discovery|sanitized/i);
});

test('contract fixture requires complete supervised discovery and explicit current owner terms decision', () => {
  const report = discoveryReport();
  const fixture = createUsVisaChinaContractFixture({ report,
    currentTermsDecision: 'allow_configured_monitoring', ownerReviewedOrigin: report.allowedOrigin,
    ownerReviewedRosterDigest: digest('c'), polling: { minimumIntervalMs: 60_000,
      maximumIntervalMs: 900_000, requestBudget: 4, requestWindowMs: 3_600_000 },
    authenticator: auth(), issuedAt: '2026-09-21T12:00:00.000Z', expiresAt: '2026-09-22T12:00:00.000Z' });
  assert.equal(fixture.source, 'supervised_local_discovery');
  assert.equal(fixture.allowedOrigin, report.allowedOrigin);
  assert.equal(fixture.termsDigest, digest('b'));
  assert.throws(() => createUsVisaChinaContractFixture({ report,
    currentTermsDecision: 'decline', ownerReviewedOrigin: report.allowedOrigin,
    ownerReviewedRosterDigest: digest('c'), polling: fixture.polling,
    authenticator: auth(), issuedAt: '2026-09-21T12:00:00.000Z', expiresAt: '2026-09-22T12:00:00.000Z' }), /terms|decision/i);
  assert.throws(() => createUsVisaChinaContractFixture({ report,
    currentTermsDecision: 'allow_configured_monitoring', ownerReviewedOrigin: 'https://other.example.test',
    ownerReviewedRosterDigest: digest('c'), polling: fixture.polling,
    authenticator: auth(), issuedAt: '2026-09-21T12:00:00.000Z', expiresAt: '2026-09-22T12:00:00.000Z' }), /origin|review/i);
  const { states: _states, ...incompleteReport } = report;
  assert.throws(() => createUsVisaChinaContractFixture({ report: incompleteReport,
    currentTermsDecision: 'allow_configured_monitoring', ownerReviewedOrigin: report.allowedOrigin,
    ownerReviewedRosterDigest: digest('c'), polling: fixture.polling,
    authenticator: auth(), issuedAt: '2026-09-21T12:00:00.000Z', expiresAt: '2026-09-22T12:00:00.000Z' }), /discovery|report|fixture/i);
});

test('repository defaults remain disabled and discovery readiness is sanitized without activating live authority', () => {
  const disabled = usVisaChinaDefaultReadiness();
  assert.deepEqual(disabled, {
    adapterId: 'us-visa-china', adapterVersion: 1, liveRegistration: 'disabled',
    discovery: 'not_started', blockers: ['authenticated_contract_fixture', 'current_terms_decision',
      'reviewed_origin', 'reviewed_roster', 'polling_limits', 'private_connection', 'active_grant'], report: null
  });
  const fixture = createUsVisaChinaContractFixture({ report: discoveryReport(),
    currentTermsDecision: 'allow_configured_monitoring', ownerReviewedOrigin: 'https://synthetic-visa.example.test',
    ownerReviewedRosterDigest: digest('c'), polling: { minimumIntervalMs: 60_000,
      maximumIntervalMs: 900_000, requestBudget: 4, requestWindowMs: 3_600_000 },
    authenticator: auth(), issuedAt: '2026-09-21T12:00:00.000Z', expiresAt: '2026-09-22T12:00:00.000Z' });
  const readiness = assessUsVisaChinaReadiness({ fixture, authenticator: auth(),
    now: '2026-09-21T13:00:00.000Z', privateConnection: false, activeGrant: false });
  assert.equal(readiness.liveRegistration, 'disabled');
  assert.equal(readiness.discovery, 'ready_for_owner_review');
  assert.deepEqual(readiness.blockers, ['private_connection', 'active_grant']);
  assert.throws(() => assessUsVisaChinaReadiness({ fixture: { ...fixture,
    allowedOrigin: 'https://tampered.example.test' }, authenticator: auth(), now: '2026-09-21T13:00:00.000Z',
    privateConnection: true, activeGrant: true }),
  /fixture|discovery|invalid/i);
});

test('authenticated fixture rejects re-signing by checksum, wrong owner/session/key, replay and expiry', () => {
  const fixture = createUsVisaChinaContractFixture({ report: discoveryReport(),
    currentTermsDecision: 'allow_configured_monitoring', ownerReviewedOrigin: 'https://synthetic-visa.example.test',
    ownerReviewedRosterDigest: digest('c'), polling: { minimumIntervalMs: 60_000,
      maximumIntervalMs: 900_000, requestBudget: 4, requestWindowMs: 3_600_000 }, authenticator: auth(),
    issuedAt: '2026-09-21T12:00:00.000Z', expiresAt: '2026-09-22T12:00:00.000Z' });
  for (const [candidate, authenticator] of [
    [{ ...fixture, allowedOrigin: 'https://tampered.example.test', authenticationTag: digest('e') }, auth()],
    [{ ...fixture, termsDigest: digest('f') }, auth()],
    [{ ...fixture, rosterDigest: digest('f') }, auth()],
    [{ ...fixture, polling: { ...fixture.polling, requestBudget: 5 } }, auth()],
    [{ ...fixture, discoveryDecision: 'decline' }, auth()],
    [{ ...fixture, termsDecision: 'decline' }, auth()],
    [fixture, createUsVisaChinaFixtureAuthenticator({ key: Buffer.alloc(32, 8), ownerId: 'owner-1',
      installationGeneration: 'install-1', sessionDigest: digest('a') })],
    [fixture, createUsVisaChinaFixtureAuthenticator({ key: Buffer.alloc(32, 7), ownerId: 'owner-2',
      installationGeneration: 'install-1', sessionDigest: digest('a') })],
    [fixture, createUsVisaChinaFixtureAuthenticator({ key: Buffer.alloc(32, 7), ownerId: 'owner-1',
      installationGeneration: 'install-2', sessionDigest: digest('a') })]
  ]) {
    assert.throws(() => assessUsVisaChinaReadiness({ fixture: candidate, authenticator,
      now: '2026-09-21T13:00:00.000Z', privateConnection: true, activeGrant: true }), /fixture|auth/i);
  }
  const wrongSession = createUsVisaChinaFixtureAuthenticator({ key: Buffer.alloc(32, 7), ownerId: 'owner-1',
    installationGeneration: 'install-1', sessionDigest: digest('9') });
  assert.throws(() => assessUsVisaChinaReadiness({ fixture, authenticator: wrongSession,
    now: '2026-09-21T13:00:00.000Z', privateConnection: true, activeGrant: true }), /fixture|auth|session/i);
  assert.throws(() => assessUsVisaChinaReadiness({ fixture, authenticator: auth(),
    now: '2026-09-23T13:00:00.000Z', privateConnection: true, activeGrant: true }), /expired|fixture/i);
});

test('generic monitoring registry exposes the visa adapter only as disabled', () => {
  const registry = new MonitoringRegistry();
  registerDisabledUsVisaChinaAdapter(registry);
  assert.deepEqual(registry.list(), []);
  assert.deepEqual(registry.listReadiness(), [{ id: 'us-visa-china', version: 1,
    status: 'disabled', reason: 'supervised_discovery_required' }]);
  assert.throws(() => registry.resolve('us-visa-china', 1), /disabled.*supervised discovery/i);
});
