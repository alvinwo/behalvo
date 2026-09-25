import { createHash } from 'node:crypto';
import type { MonitoredActionPolicyAdapter } from '../../monitoring/types.js';
import type { JsonValue } from '../../operations/types.js';
import { canonicalJson, exactObject, jsonValue } from '../../operations/validation.js';
import { parseUsVisaChinaCandidate, validDate } from './states.js';
import {
  US_VISA_CHINA_ADAPTER_ID, US_VISA_CHINA_ADAPTER_VERSION, US_VISA_CHINA_CONTRACT_VERSION,
  type UsVisaChinaCoverage, type UsVisaChinaScope
} from './types.js';

const DIGEST = /^[a-f0-9]{64}$/;
const IDENTIFIER = /^[A-Za-z0-9._:-]{1,128}$/;

function digest(value: unknown): string {
  if (typeof value !== 'string' || !DIGEST.test(value)) throw new Error('Invalid visa scope.');
  return value;
}

export function validateUsVisaChinaScope(value: unknown): UsVisaChinaScope {
  try {
    exactObject(value, ['bookingType', 'location', 'timeZone', 'startDate', 'endDate', 'eligibleTimes',
      'selection', 'maximumEffects', 'provider', 'providerSubject', 'resourceId', 'identityDigest',
      'rosterDigest', 'termsDigest'], 'visa scope');
    if (value.bookingType !== 'new_group_appointment' || value.location !== 'Beijing' ||
        value.timeZone !== 'Asia/Shanghai' || value.startDate !== '2026-12-15' || value.endDate !== '2027-01-31' ||
        value.eligibleTimes !== 'any_offered_working_time' || value.selection !== 'earliest' ||
        value.maximumEffects !== 1 || value.provider !== 'visa-scheduling' || value.resourceId !== 'group-appointment' ||
        typeof value.providerSubject !== 'string' || !IDENTIFIER.test(value.providerSubject))
      throw new Error();
    return { bookingType: 'new_group_appointment', location: 'Beijing', timeZone: 'Asia/Shanghai',
      startDate: '2026-12-15', endDate: '2027-01-31', eligibleTimes: 'any_offered_working_time',
      selection: 'earliest', maximumEffects: 1, provider: 'visa-scheduling', providerSubject: value.providerSubject,
      resourceId: 'group-appointment', identityDigest: digest(value.identityDigest),
      rosterDigest: digest(value.rosterDigest), termsDigest: digest(value.termsDigest) };
  } catch { throw new Error('Invalid visa scope.'); }
}

function parseCoverage(value: unknown): UsVisaChinaCoverage {
  exactObject(value, ['contractVersion', 'location', 'timeZone', 'startDate', 'endDate', 'firstPage', 'lastPage',
    'inspectedPages', 'paginationComplete', 'appointmentAbsent', 'identityDigest', 'subjectDigest', 'rosterDigest',
    'termsDigest', 'termsVersion'],
  'visa coverage');
  if (value.contractVersion !== US_VISA_CHINA_CONTRACT_VERSION || value.location !== 'Beijing' ||
      value.timeZone !== 'Asia/Shanghai' || value.startDate !== '2026-12-15' || value.endDate !== '2027-01-31' ||
      value.paginationComplete !== true || value.appointmentAbsent !== true ||
      !Number.isSafeInteger(value.firstPage) || !Number.isSafeInteger(value.lastPage) ||
      (value.firstPage as number) !== 1 || (value.lastPage as number) < 1 || (value.lastPage as number) > 100 ||
      !Array.isArray(value.inspectedPages) || value.inspectedPages.length !== value.lastPage)
    throw new Error('Invalid visa coverage.');
  const pages = value.inspectedPages.map(item => {
    if (!Number.isSafeInteger(item)) throw new Error('Invalid visa coverage.');
    return item as number;
  });
  if (pages.some((item, index) => item !== index + 1)) throw new Error('Invalid visa coverage.');
  return { contractVersion: 1, location: 'Beijing', timeZone: 'Asia/Shanghai', startDate: '2026-12-15',
    endDate: '2027-01-31', firstPage: 1, lastPage: value.lastPage as number, inspectedPages: pages,
    paginationComplete: true, appointmentAbsent: true, identityDigest: digest(value.identityDigest),
    subjectDigest: digest(value.subjectDigest), rosterDigest: digest(value.rosterDigest),
    termsDigest: digest(value.termsDigest), termsVersion: identifier(value.termsVersion) };
}

function identifier(value: unknown): string {
  if (typeof value !== 'string' || !IDENTIFIER.test(value)) throw new Error('Invalid visa coverage.');
  return value;
}

export function createUsVisaChinaPolicyAdapter(): MonitoredActionPolicyAdapter {
  const adapter: MonitoredActionPolicyAdapter = {
    id: US_VISA_CHINA_ADAPTER_ID,
    version: US_VISA_CHINA_ADAPTER_VERSION,
    validateScope(value) { return validateUsVisaChinaScope(value) as unknown as JsonValue; },
    coverageSufficient(scopeValue, coverageValue) {
      try {
        const scope = validateUsVisaChinaScope(scopeValue);
        const coverage = parseCoverage(coverageValue);
        return coverage.location === scope.location && coverage.timeZone === scope.timeZone &&
          coverage.startDate === scope.startDate && coverage.endDate === scope.endDate &&
          coverage.identityDigest === scope.identityDigest && coverage.rosterDigest === scope.rosterDigest &&
          coverage.termsDigest === scope.termsDigest;
      } catch { return false; }
    },
    selectCommand({ grant, scope: scopeValue, observation }) {
      const scope = validateUsVisaChinaScope(scopeValue);
      const coverage = parseCoverage(observation.coverage);
      if (coverage.identityDigest !== scope.identityDigest || coverage.rosterDigest !== scope.rosterDigest ||
          coverage.termsDigest !== scope.termsDigest || !coverage.appointmentAbsent)
        throw new Error('Invalid visa coverage.');
      const ids = new Set<string>(); const evidence = new Set<string>();
      const candidates = observation.candidates.map(value => {
        const item = parseUsVisaChinaCandidate(value);
        if (ids.has(item.id) || evidence.has(item.evidenceDigest))
          throw new Error('Visa candidate evidence is not unique.');
        ids.add(item.id); evidence.add(item.evidenceDigest);
        if (item.location !== scope.location || item.timeZone !== scope.timeZone ||
            item.rosterDigest !== scope.rosterDigest || !validDate(item.date) ||
            item.date < scope.startDate || item.date > scope.endDate)
          throw new Error('Visa candidate violates the approved scope.');
        return item;
      }).sort((left, right) => left.date.localeCompare(right.date) || left.time.localeCompare(right.time) ||
        left.id.localeCompare(right.id));
      const selected = candidates[0];
      if (!selected) return undefined;
      const argumentsValue = { bookingType: 'new_group_appointment' as const, candidateId: selected.id,
        date: selected.date, time: selected.time, location: 'Beijing' as const, timeZone: 'Asia/Shanghai' as const,
        rosterDigest: scope.rosterDigest, identityDigest: scope.identityDigest, termsDigest: scope.termsDigest,
        evidenceDigest: selected.evidenceDigest };
      const expectedResult = { status: 'booked', date: selected.date, time: selected.time,
        location: 'Beijing', timeZone: 'Asia/Shanghai', rosterDigest: scope.rosterDigest };
      const preconditionState = { appointmentAbsent: true, identityDigest: scope.identityDigest,
        rosterDigest: scope.rosterDigest, termsDigest: scope.termsDigest,
        candidateEvidenceDigest: selected.evidenceDigest };
      const requestFingerprint = createHash('sha256').update(canonicalJson(jsonValue([
        grant.id, grant.digest, grant.revision, selected, coverage, argumentsValue
      ], 'visa request fingerprint'))).digest('hex');
      return { kind: 'operation.execute', operationId: US_VISA_CHINA_ADAPTER_ID,
        operationVersion: String(US_VISA_CHINA_ADAPTER_VERSION), connectionId: grant.connectionId,
        provider: scope.provider, subject: scope.providerSubject, connectionGeneration: grant.connectionGeneration,
        resourceId: scope.resourceId, arguments: argumentsValue, affectedResourceIds: [scope.resourceId],
        precondition: { state: preconditionState, providerVersion: String(US_VISA_CHINA_CONTRACT_VERSION),
          source: `${US_VISA_CHINA_ADAPTER_ID}:synthetic`, observedAt: observation.observedAt },
        expectedResult, subjectRevision: 0, requestFingerprint };
    }
  };
  return Object.freeze(adapter);
}
