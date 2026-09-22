import { createHmac, timingSafeEqual } from 'node:crypto';
import { canonicalJson, exactObject, jsonValue } from '../../operations/validation.js';
import {
  US_VISA_CHINA_ADAPTER_ID, US_VISA_CHINA_ADAPTER_VERSION,
  US_VISA_CHINA_STATE_IDS, type UsVisaChinaReadiness, type UsVisaChinaStateId
} from './types.js';

const DIGEST = /^[a-f0-9]{64}$/;
const BLOCKERS: UsVisaChinaReadiness['blockers'] = ['authenticated_contract_fixture', 'current_terms_decision',
  'reviewed_origin', 'reviewed_roster', 'polling_limits', 'private_connection', 'active_grant'];

interface DiscoveryRecord { stateId: UsVisaChinaStateId; fields: Record<string, boolean | string> }
export interface UsVisaChinaDiscoveryReport {
  adapterId: typeof US_VISA_CHINA_ADAPTER_ID;
  adapterVersion: 1;
  contractVersion: 1;
  allowedOrigin: string;
  locallyAuthenticatedSessionDigest: string;
  observedStateIds: UsVisaChinaStateId[];
  states: DiscoveryRecord[];
  coverageSemantics: { inclusiveDates: true; contiguousPagination: true; completeEmptyDistinguished: true };
  termsDigest: string;
  ownerDecision: 'allow_read_only_discovery';
  rosterDigest: string;
  identityDigest: string;
}

export interface UsVisaChinaContractFixture {
  source: 'supervised_local_discovery';
  adapterId: typeof US_VISA_CHINA_ADAPTER_ID;
  adapterVersion: 1;
  contractVersion: 1;
  allowedOrigin: string;
  termsDigest: string;
  rosterDigest: string;
  identityDigest: string;
  discoveryDecision: 'allow_read_only_discovery';
  termsDecision: 'allow_configured_monitoring';
  observedStateIds: UsVisaChinaStateId[];
  polling: { minimumIntervalMs: number; maximumIntervalMs: number; requestBudget: number; requestWindowMs: number };
  ownerId: string;
  installationGeneration: string;
  sessionDigest: string;
  issuedAt: string;
  expiresAt: string;
  authenticationTag: string;
}

export class UsVisaChinaFixtureAuthenticator {
  readonly #key: Buffer;
  constructor(key: Uint8Array, readonly ownerId: string, readonly installationGeneration: string,
      readonly sessionDigest: string) {
    if (!(key instanceof Uint8Array) || key.byteLength < 32 || !/^[A-Za-z0-9._:-]{1,128}$/.test(ownerId) ||
        !/^[A-Za-z0-9._:-]{1,128}$/.test(installationGeneration) || !DIGEST.test(sessionDigest))
      throw new Error('Invalid visa fixture authenticator.');
    this.#key = Buffer.from(key);
  }
  authenticate(value: unknown): string {
    return createHmac('sha256', this.#key).update(canonicalJson(jsonValue(value, 'visa fixture'))).digest('hex');
  }
  verify(value: unknown, tag: string): boolean {
    if (!DIGEST.test(tag)) return false;
    const expected = Buffer.from(this.authenticate(value), 'hex');
    return timingSafeEqual(expected, Buffer.from(tag, 'hex'));
  }
}

export function createUsVisaChinaFixtureAuthenticator(input: { key: Uint8Array; ownerId: string;
    installationGeneration: string; sessionDigest: string }): UsVisaChinaFixtureAuthenticator {
  exactObject(input, ['key', 'ownerId', 'installationGeneration', 'sessionDigest'], 'visa fixture authenticator');
  return new UsVisaChinaFixtureAuthenticator(input.key, input.ownerId, input.installationGeneration, input.sessionDigest);
}

function digest(value: unknown): string {
  if (typeof value !== 'string' || !DIGEST.test(value)) throw new Error('Invalid supervised visa discovery.');
  return value;
}

function origin(value: unknown): string {
  if (typeof value !== 'string' || value.length > 256) throw new Error('Invalid supervised visa discovery.');
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new Error('Invalid supervised visa discovery.'); }
  if (parsed.origin !== value || parsed.protocol !== 'https:' || parsed.username || parsed.password ||
      parsed.pathname !== '/' || parsed.search || parsed.hash) throw new Error('Invalid supervised visa discovery.');
  return value;
}

function requiredObject(value: unknown, keys: readonly string[], label: string): asserts value is Record<string, unknown> {
  exactObject(value, keys, label);
  if (keys.some(key => !Object.hasOwn(value, key))) throw new Error(`Invalid ${label}.`);
}

function safeFields(stateId: UsVisaChinaStateId, value: unknown): Record<string, boolean | string> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype)
    throw new Error('Invalid sanitized visa discovery fields.');
  if (stateId === 'calendar_coverage') {
    requiredObject(value, ['locationPresent', 'timeZonePresent', 'pagePresent', 'hasNextPresent',
      'candidatesPresence'], 'sanitized visa discovery fields');
    if (value.locationPresent !== true || value.timeZonePresent !== true || value.pagePresent !== true ||
        value.hasNextPresent !== true || value.candidatesPresence !== 'present_or_empty')
      throw new Error('Invalid sanitized visa discovery fields.');
    return { locationPresent: true, timeZonePresent: true, pagePresent: true, hasNextPresent: true,
      candidatesPresence: 'present_or_empty' };
  }
  requiredObject(value, ['requiredFields'], 'sanitized visa discovery fields');
  if (value.requiredFields !== 'present') throw new Error('Invalid sanitized visa discovery fields.');
  return { requiredFields: 'present' };
}

function validateDiscoveryReport(value: unknown): UsVisaChinaDiscoveryReport {
  requiredObject(value, ['adapterId', 'adapterVersion', 'contractVersion', 'allowedOrigin',
    'locallyAuthenticatedSessionDigest', 'observedStateIds', 'states', 'coverageSemantics', 'termsDigest',
    'ownerDecision', 'rosterDigest', 'identityDigest'], 'supervised visa discovery report');
  const observedStateIds = value.observedStateIds;
  const stateValues = value.states;
  if (value.adapterId !== US_VISA_CHINA_ADAPTER_ID || value.adapterVersion !== 1 || value.contractVersion !== 1 ||
      value.ownerDecision !== 'allow_read_only_discovery' || !Array.isArray(observedStateIds) ||
      observedStateIds.length !== US_VISA_CHINA_STATE_IDS.length ||
      US_VISA_CHINA_STATE_IDS.some((id, index) => observedStateIds[index] !== id) ||
      !Array.isArray(stateValues) || stateValues.length !== US_VISA_CHINA_STATE_IDS.length)
    throw new Error('Invalid supervised visa discovery report.');
  requiredObject(value.coverageSemantics,
    ['inclusiveDates', 'contiguousPagination', 'completeEmptyDistinguished'], 'visa coverage semantics');
  if (value.coverageSemantics.inclusiveDates !== true || value.coverageSemantics.contiguousPagination !== true ||
      value.coverageSemantics.completeEmptyDistinguished !== true)
    throw new Error('Invalid supervised visa discovery report.');
  const states = stateValues.map((record, index) => {
    requiredObject(record, ['stateId', 'fields'], 'supervised visa discovery state');
    const stateId = US_VISA_CHINA_STATE_IDS[index]!;
    if (record.stateId !== stateId) throw new Error('Invalid supervised visa discovery report.');
    return { stateId, fields: safeFields(stateId, record.fields) };
  });
  return { adapterId: US_VISA_CHINA_ADAPTER_ID, adapterVersion: 1, contractVersion: 1,
    allowedOrigin: origin(value.allowedOrigin), locallyAuthenticatedSessionDigest: digest(value.locallyAuthenticatedSessionDigest),
    observedStateIds: [...US_VISA_CHINA_STATE_IDS], states,
    coverageSemantics: { inclusiveDates: true, contiguousPagination: true, completeEmptyDistinguished: true },
    termsDigest: digest(value.termsDigest), ownerDecision: 'allow_read_only_discovery',
    rosterDigest: digest(value.rosterDigest), identityDigest: digest(value.identityDigest) };
}

export class UsVisaChinaDiscoveryRecorder {
  readonly #allowedOrigin: string;
  readonly #sessionDigest: string;
  readonly #records = new Map<UsVisaChinaStateId, DiscoveryRecord>();

  constructor(input: { allowedOrigin: string; locallyAuthenticatedSessionDigest: string }) {
    exactObject(input, ['allowedOrigin', 'locallyAuthenticatedSessionDigest'], 'visa discovery setup');
    this.#allowedOrigin = origin(input.allowedOrigin);
    this.#sessionDigest = digest(input.locallyAuthenticatedSessionDigest);
  }

  record(input: { stateId: UsVisaChinaStateId; fields: unknown }): void {
    exactObject(input, ['stateId', 'fields'], 'visa discovery record');
    if (!US_VISA_CHINA_STATE_IDS.includes(input.stateId)) throw new Error('Invalid supervised visa discovery.');
    if (this.#records.has(input.stateId)) throw new Error('Invalid supervised visa discovery.');
    this.#records.set(input.stateId, { stateId: input.stateId, fields: safeFields(input.stateId, input.fields) });
  }

  finish(input: { coverageSemantics: { inclusiveDates: true; contiguousPagination: true;
      completeEmptyDistinguished: true }; termsDigest: string; ownerDecision: 'allow_read_only_discovery';
      rosterDigest: string; identityDigest: string }): UsVisaChinaDiscoveryReport {
    exactObject(input, ['coverageSemantics', 'termsDigest', 'ownerDecision', 'rosterDigest', 'identityDigest'],
      'visa discovery completion');
    exactObject(input.coverageSemantics, ['inclusiveDates', 'contiguousPagination', 'completeEmptyDistinguished'],
      'visa coverage semantics');
    if (input.coverageSemantics.inclusiveDates !== true || input.coverageSemantics.contiguousPagination !== true ||
        input.coverageSemantics.completeEmptyDistinguished !== true || input.ownerDecision !== 'allow_read_only_discovery' ||
        this.#records.size !== US_VISA_CHINA_STATE_IDS.length) throw new Error('Invalid supervised visa discovery.');
    const observedStateIds = US_VISA_CHINA_STATE_IDS.filter(id => this.#records.has(id));
    if (observedStateIds.length !== US_VISA_CHINA_STATE_IDS.length) throw new Error('Invalid supervised visa discovery.');
    return { adapterId: US_VISA_CHINA_ADAPTER_ID, adapterVersion: 1, contractVersion: 1,
      allowedOrigin: this.#allowedOrigin, locallyAuthenticatedSessionDigest: this.#sessionDigest,
      observedStateIds: [...observedStateIds], states: observedStateIds.map(id => structuredClone(this.#records.get(id)!)),
      coverageSemantics: { inclusiveDates: true, contiguousPagination: true, completeEmptyDistinguished: true },
      termsDigest: digest(input.termsDigest), ownerDecision: 'allow_read_only_discovery',
      rosterDigest: digest(input.rosterDigest), identityDigest: digest(input.identityDigest) };
  }
}

function polling(value: unknown): UsVisaChinaContractFixture['polling'] {
  exactObject(value, ['minimumIntervalMs', 'maximumIntervalMs', 'requestBudget', 'requestWindowMs'], 'visa polling');
  const item = value as Record<string, unknown>;
  for (const key of ['minimumIntervalMs', 'maximumIntervalMs', 'requestBudget', 'requestWindowMs'])
    if (!Number.isSafeInteger(item[key]) || (item[key] as number) < 1) throw new Error('Invalid visa polling limits.');
  if ((item.minimumIntervalMs as number) < 60_000 || (item.maximumIntervalMs as number) > 86_400_000 ||
      (item.minimumIntervalMs as number) > (item.maximumIntervalMs as number) ||
      (item.requestBudget as number) > 100 || (item.requestWindowMs as number) < (item.minimumIntervalMs as number))
    throw new Error('Invalid visa polling limits.');
  return item as unknown as UsVisaChinaContractFixture['polling'];
}

export function createUsVisaChinaContractFixture(input: { report: UsVisaChinaDiscoveryReport;
    currentTermsDecision: 'allow_configured_monitoring' | 'decline'; ownerReviewedOrigin: string;
    ownerReviewedRosterDigest: string; polling: UsVisaChinaContractFixture['polling'];
    authenticator: UsVisaChinaFixtureAuthenticator; issuedAt: string; expiresAt: string }): UsVisaChinaContractFixture {
  exactObject(input, ['report', 'currentTermsDecision', 'ownerReviewedOrigin', 'ownerReviewedRosterDigest',
    'polling', 'authenticator', 'issuedAt', 'expiresAt'], 'visa contract fixture');
  const report = validateDiscoveryReport(input.report);
  if (!(input.authenticator instanceof UsVisaChinaFixtureAuthenticator) ||
      input.authenticator.sessionDigest !== report.locallyAuthenticatedSessionDigest)
    throw new Error('Authenticated visa discovery session does not match.');
  if (input.currentTermsDecision !== 'allow_configured_monitoring') throw new Error('Current visa terms decision is required.');
  if (origin(input.ownerReviewedOrigin) !== report.allowedOrigin) throw new Error('Reviewed visa origin does not match.');
  if (digest(input.ownerReviewedRosterDigest) !== report.rosterDigest) throw new Error('Reviewed visa roster does not match.');
  if (report.observedStateIds.length !== US_VISA_CHINA_STATE_IDS.length ||
      US_VISA_CHINA_STATE_IDS.some((id, index) => report.observedStateIds[index] !== id))
    throw new Error('Supervised visa discovery is incomplete.');
  const normalizedPolling = polling(input.polling);
  const issuedAt = instant(input.issuedAt), expiresAt = instant(input.expiresAt);
  if (Date.parse(expiresAt) <= Date.parse(issuedAt) || Date.parse(expiresAt) - Date.parse(issuedAt) > 7 * 86_400_000)
    throw new Error('Invalid visa fixture expiry.');
  const base = { source: 'supervised_local_discovery' as const, adapterId: US_VISA_CHINA_ADAPTER_ID,
    adapterVersion: 1 as const, contractVersion: 1 as const, allowedOrigin: report.allowedOrigin,
    termsDigest: digest(report.termsDigest), rosterDigest: report.rosterDigest, identityDigest: report.identityDigest,
    discoveryDecision: report.ownerDecision, termsDecision: input.currentTermsDecision,
    observedStateIds: [...report.observedStateIds], polling: normalizedPolling,
    ownerId: input.authenticator.ownerId, installationGeneration: input.authenticator.installationGeneration,
    sessionDigest: input.authenticator.sessionDigest, issuedAt, expiresAt };
  return { ...base, authenticationTag: input.authenticator.authenticate(base) };
}

function instant(value: unknown): string {
  if (typeof value !== 'string' || new Date(value).toISOString() !== value) throw new Error('Invalid visa fixture time.');
  return value;
}

function validateContractFixture(value: unknown, authenticator: UsVisaChinaFixtureAuthenticator,
    now: string): UsVisaChinaContractFixture {
  requiredObject(value, ['source', 'adapterId', 'adapterVersion', 'contractVersion', 'allowedOrigin', 'termsDigest',
    'rosterDigest', 'identityDigest', 'observedStateIds', 'polling', 'ownerId', 'installationGeneration',
    'sessionDigest', 'issuedAt', 'expiresAt', 'discoveryDecision', 'termsDecision', 'authenticationTag'],
  'authenticated visa contract fixture');
  if (!(authenticator instanceof UsVisaChinaFixtureAuthenticator)) throw new Error('Invalid visa fixture authenticator.');
  const observedStateIds = value.observedStateIds;
  if (value.source !== 'supervised_local_discovery' || value.adapterId !== US_VISA_CHINA_ADAPTER_ID ||
      value.adapterVersion !== 1 || value.contractVersion !== 1 || !Array.isArray(observedStateIds) ||
      observedStateIds.length !== US_VISA_CHINA_STATE_IDS.length ||
      US_VISA_CHINA_STATE_IDS.some((id, index) => observedStateIds[index] !== id) ||
      value.discoveryDecision !== 'allow_read_only_discovery' || value.termsDecision !== 'allow_configured_monitoring')
    throw new Error('Invalid authenticated visa contract fixture.');
  const base = { source: 'supervised_local_discovery' as const, adapterId: US_VISA_CHINA_ADAPTER_ID,
    adapterVersion: 1 as const, contractVersion: 1 as const, allowedOrigin: origin(value.allowedOrigin),
    termsDigest: digest(value.termsDigest), rosterDigest: digest(value.rosterDigest),
    identityDigest: digest(value.identityDigest), observedStateIds: [...US_VISA_CHINA_STATE_IDS],
    discoveryDecision: 'allow_read_only_discovery' as const, termsDecision: 'allow_configured_monitoring' as const,
    polling: polling(value.polling), ownerId: String(value.ownerId), installationGeneration: String(value.installationGeneration),
    sessionDigest: digest(value.sessionDigest), issuedAt: instant(value.issuedAt), expiresAt: instant(value.expiresAt) };
  const authenticationTag = digest(value.authenticationTag);
  if (base.ownerId !== authenticator.ownerId || base.installationGeneration !== authenticator.installationGeneration ||
      base.sessionDigest !== authenticator.sessionDigest || !authenticator.verify(base, authenticationTag))
    throw new Error('Invalid authenticated visa contract fixture.');
  const current = instant(now);
  if (Date.parse(current) < Date.parse(base.issuedAt) || Date.parse(current) >= Date.parse(base.expiresAt))
    throw new Error('Authenticated visa contract fixture expired or is not current.');
  return { ...base, authenticationTag };
}

export function usVisaChinaDefaultReadiness(): UsVisaChinaReadiness {
  return { adapterId: US_VISA_CHINA_ADAPTER_ID, adapterVersion: US_VISA_CHINA_ADAPTER_VERSION,
    liveRegistration: 'disabled', discovery: 'not_started', blockers: [...BLOCKERS], report: null };
}

export function assessUsVisaChinaReadiness(input: { fixture?: UsVisaChinaContractFixture;
    authenticator?: UsVisaChinaFixtureAuthenticator; now?: string;
    privateConnection: boolean; activeGrant: boolean }): UsVisaChinaReadiness {
  exactObject(input, ['privateConnection', 'activeGrant', 'fixture', 'authenticator', 'now'], 'visa readiness');
  if (typeof input.privateConnection !== 'boolean' || typeof input.activeGrant !== 'boolean')
    throw new Error('Invalid visa readiness.');
  if (!input.fixture) return usVisaChinaDefaultReadiness();
  if (!input.authenticator || !input.now) throw new Error('Authenticated visa fixture verification is required.');
  const fixture = validateContractFixture(input.fixture, input.authenticator, input.now);
  const blockers: UsVisaChinaReadiness['blockers'] = [];
  if (!input.privateConnection) blockers.push('private_connection');
  if (!input.activeGrant) blockers.push('active_grant');
  return { adapterId: US_VISA_CHINA_ADAPTER_ID, adapterVersion: 1, liveRegistration: 'disabled',
    discovery: 'ready_for_owner_review', blockers, report: {
      allowedOrigin: fixture.allowedOrigin, contractVersion: 1,
      observedStateIds: [...fixture.observedStateIds],
      coverageSemantics: { inclusiveDates: true, contiguousPagination: true, completeEmptyDistinguished: true },
      termsDigest: fixture.termsDigest, ownerDecision: 'allow_configured_monitoring'
    } };
}

export function sanitizeUsVisaChinaReadiness(value: unknown): UsVisaChinaReadiness {
  exactObject(value, ['adapterId', 'adapterVersion', 'liveRegistration', 'discovery', 'blockers', 'report'],
    'visa readiness');
  if (value.adapterId !== US_VISA_CHINA_ADAPTER_ID || value.adapterVersion !== 1 ||
      value.liveRegistration !== 'disabled' || !['not_started', 'ready_for_owner_review'].includes(String(value.discovery)) ||
      !Array.isArray(value.blockers) || value.blockers.some(item => !BLOCKERS.includes(item)) ||
      new Set(value.blockers).size !== value.blockers.length) throw new Error('Invalid visa readiness.');
  let report: UsVisaChinaReadiness['report'] = null;
  if (value.report !== null) {
    const reportValue = value.report;
    exactObject(reportValue, ['allowedOrigin', 'contractVersion', 'observedStateIds', 'coverageSemantics',
      'termsDigest', 'ownerDecision'], 'sanitized visa discovery report');
    const coverageSemantics = reportValue.coverageSemantics;
    exactObject(coverageSemantics,
      ['inclusiveDates', 'contiguousPagination', 'completeEmptyDistinguished'], 'visa coverage semantics');
    const observedStateIds = reportValue.observedStateIds;
    if (origin(reportValue.allowedOrigin) !== reportValue.allowedOrigin || reportValue.contractVersion !== 1 ||
        !Array.isArray(observedStateIds) || observedStateIds.length !== US_VISA_CHINA_STATE_IDS.length ||
        US_VISA_CHINA_STATE_IDS.some((id, index) => observedStateIds[index] !== id) ||
        coverageSemantics.inclusiveDates !== true || coverageSemantics.contiguousPagination !== true ||
        coverageSemantics.completeEmptyDistinguished !== true ||
        reportValue.ownerDecision !== 'allow_configured_monitoring') throw new Error('Invalid visa readiness.');
    report = { allowedOrigin: reportValue.allowedOrigin, contractVersion: 1,
      observedStateIds: [...US_VISA_CHINA_STATE_IDS],
      coverageSemantics: { inclusiveDates: true, contiguousPagination: true, completeEmptyDistinguished: true },
      termsDigest: digest(reportValue.termsDigest), ownerDecision: 'allow_configured_monitoring' };
  }
  return { adapterId: US_VISA_CHINA_ADAPTER_ID, adapterVersion: 1, liveRegistration: 'disabled',
    discovery: value.discovery as UsVisaChinaReadiness['discovery'],
    blockers: [...value.blockers] as UsVisaChinaReadiness['blockers'], report };
}
