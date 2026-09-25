import { createHash } from 'node:crypto';
import { OperationStoppedError, type TrustedExecutionFence } from '../../operations/execution-context.js';
import { exactObject, isOperationCommand, jsonValue } from '../../operations/validation.js';
import type { MonitoringRegistry } from '../../monitoring/registry.js';
import type { MonitoredActionPolicyAdapter, Observation, ObservationResult } from '../../monitoring/types.js';
import { BrowserSession, BrowserUnexpectedDestinationError } from '../../browser/session.js';
import type { BrowserPageSnapshot } from '../../browser/types.js';
import { createUsVisaChinaPolicyAdapter, validateUsVisaChinaScope } from './policy.js';
import { parseUsVisaChinaCandidate, validDate, validTime } from './states.js';
import {
  US_VISA_CHINA_ADAPTER_ID, US_VISA_CHINA_ADAPTER_VERSION,
  type UsVisaChinaBooking, type UsVisaChinaCandidate, type UsVisaChinaCoverage,
  type UsVisaChinaExecutionInput, type UsVisaChinaExecutionResult, type UsVisaChinaPreflight,
  type UsVisaChinaSyntheticPortalPort
} from './types.js';

const DIGEST = /^[a-f0-9]{64}$/;
const IDENTIFIER = /^[A-Za-z0-9._:-]{1,128}$/;
const MAX_CALENDAR_PAGES = 100;
const MAX_OBSERVATION_CANDIDATES = 1_000;
const MAX_OBSERVATION_BYTES = 262_144;

type CalendarSnapshot = Extract<BrowserPageSnapshot, { state: 'calendar' }>;
type InspectionInput = Parameters<NonNullable<MonitoredActionPolicyAdapter['inspect']>>[0];
type CalendarContext = Pick<InspectionInput, 'grant' | 'connection' | 'fence'>;

interface ReadOnlyCalendar {
  recognize(): Promise<BrowserPageSnapshot>;
  firstPage(): Promise<BrowserPageSnapshot>;
  nextPage(): Promise<BrowserPageSnapshot>;
}

interface InspectedCalendarPage {
  page: number;
  hasNext: boolean;
  candidates: UsVisaChinaCandidate[];
}

function readOnlyCalendar(session: BrowserSession, fence: TrustedExecutionFence): ReadOnlyCalendar {
  return {
    recognize: () => session.recognize(fence),
    firstPage: () => session.gestureAndWaitForNavigation(
      { kind: 'calendar.first_page' }, 'calendar', ['calendar'], fence),
    nextPage: () => session.gestureAndWaitForNavigation(
      { kind: 'calendar.next_page' }, 'calendar', ['calendar'], fence)
  };
}

function nonComplete(observedAt: string, result: ObservationResult, reason: string): Observation {
  return { observedAt, complete: false, coverage: { checkpoint: reason }, candidates: [], result };
}

function checkpointObservation(snapshot: BrowserPageSnapshot, observedAt: string): Observation {
  switch (snapshot.state) {
    case 'login': case 'session_expired':
      return nonComplete(observedAt, 'session_expired', snapshot.state);
    case 'security_question': case 'challenge': case 'forbidden':
      return nonComplete(observedAt, 'needs_human', snapshot.state);
    case 'rate_limited':
      return nonComplete(observedAt, 'rate_limited', snapshot.state);
    default:
      return nonComplete(observedAt, 'contract_changed', snapshot.state);
  }
}

function sameCalendarMetadata(left: CalendarSnapshot, right: CalendarSnapshot): boolean {
  return left.contractVersion === right.contractVersion && left.location === right.location &&
    left.timeZone === right.timeZone && left.startDate === right.startDate && left.endDate === right.endDate &&
    left.identityDigest === right.identityDigest && left.subjectDigest === right.subjectDigest &&
    left.rosterDigest === right.rosterDigest && left.termsDigest === right.termsDigest &&
    left.termsVersion === right.termsVersion && left.appointmentAbsent === right.appointmentAbsent;
}

function calendarMatchesBindings(snapshot: CalendarSnapshot, context: CalendarContext): boolean {
  const scope = validateUsVisaChinaScope(context.grant.scope);
  return snapshot.contractVersion === 1 && snapshot.location === scope.location &&
    snapshot.timeZone === scope.timeZone && snapshot.startDate === scope.startDate &&
    snapshot.endDate === scope.endDate && snapshot.identityDigest === scope.identityDigest &&
    snapshot.subjectDigest === context.grant.subjectDigest && snapshot.rosterDigest === scope.rosterDigest &&
    snapshot.termsDigest === scope.termsDigest && snapshot.appointmentAbsent === true &&
    context.connection.id === context.grant.connectionId &&
    context.connection.generation === context.grant.connectionGeneration &&
    context.connection.provider === scope.provider && context.connection.subject === scope.providerSubject;
}

function calendarCandidate(snapshot: CalendarSnapshot, candidate: CalendarSnapshot['candidates'][number]):
    UsVisaChinaCandidate {
  return parseUsVisaChinaCandidate({ ...candidate, timeZone: snapshot.timeZone,
    rosterDigest: snapshot.rosterDigest });
}

function calendarCandidates(snapshot: CalendarSnapshot): UsVisaChinaCandidate[] | undefined {
  try {
    const ids = new Set<string>();
    const evidence = new Set<string>();
    const result = snapshot.candidates.map(candidate => calendarCandidate(snapshot, candidate));
    for (const candidate of result) {
      if (ids.has(candidate.id) || evidence.has(candidate.evidenceDigest)) return undefined;
      ids.add(candidate.id); evidence.add(candidate.evidenceDigest);
    }
    return result;
  } catch { return undefined; }
}

function sameCandidateSet(left: readonly UsVisaChinaCandidate[], right: readonly UsVisaChinaCandidate[]): boolean {
  if (left.length !== right.length) return false;
  const canonical = (items: readonly UsVisaChinaCandidate[]) => items.map(item => JSON.stringify(item)).sort();
  const leftItems = canonical(left); const rightItems = canonical(right);
  return leftItems.every((item, index) => item === rightItems[index]);
}

async function inspectSyntheticCalendar(session: BrowserSession, context: CalendarContext,
    policy: MonitoredActionPolicyAdapter): Promise<Observation> {
  const observedAt = new Date().toISOString();
  if (session.profileId !== context.grant.browserProfileId ||
      session.connectionGeneration !== context.grant.connectionGeneration)
    return nonComplete(observedAt, 'contract_changed', 'binding_changed');
  const reader = readOnlyCalendar(session, context.fence);
  const recognized = await reader.recognize();
  if (recognized.state !== 'calendar') return checkpointObservation(recognized, observedAt);

  let snapshot: BrowserPageSnapshot;
  try { snapshot = await reader.firstPage(); }
  catch (error) {
    if (error instanceof BrowserUnexpectedDestinationError)
      return checkpointObservation(error.snapshot, observedAt);
    throw error;
  }
  if (snapshot.state !== 'calendar' || snapshot.page !== 1 || !calendarMatchesBindings(snapshot, context))
    return nonComplete(observedAt, 'contract_changed', 'calendar_binding_changed');

  const first = snapshot;
  const pages: InspectedCalendarPage[] = [];
  const candidates: Array<{ page: number; value: UsVisaChinaCandidate }> = [];
  const candidateIds = new Set<string>(); const candidateEvidence = new Set<string>();
  let totalBytes = 0;
  for (;;) {
    if (snapshot.state !== 'calendar' || snapshot.page !== pages.length + 1 ||
        !sameCalendarMetadata(first, snapshot) || !calendarMatchesBindings(snapshot, context))
      return nonComplete(observedAt, 'contract_changed', 'calendar_contract_changed');
    const pageCandidates = calendarCandidates(snapshot);
    if (!pageCandidates) return nonComplete(observedAt, 'contract_changed', 'candidate_set_changed');
    totalBytes += Buffer.byteLength(JSON.stringify(snapshot), 'utf8');
    if (totalBytes > MAX_OBSERVATION_BYTES ||
        candidates.length + pageCandidates.length > MAX_OBSERVATION_CANDIDATES)
      return nonComplete(observedAt, 'contract_changed', 'observation_bound_exceeded');
    pages.push({ page: snapshot.page, hasNext: snapshot.hasNext, candidates: pageCandidates });
    for (const candidate of pageCandidates) {
      if (candidateIds.has(candidate.id) || candidateEvidence.has(candidate.evidenceDigest))
        return nonComplete(observedAt, 'contract_changed', 'candidate_set_changed');
      candidateIds.add(candidate.id); candidateEvidence.add(candidate.evidenceDigest);
      candidates.push({ page: snapshot.page, value: candidate });
    }
    if (!snapshot.hasNext) break;
    if (snapshot.page >= MAX_CALENDAR_PAGES)
      return nonComplete(observedAt, 'contract_changed', 'observation_bound_exceeded');
    try { snapshot = await reader.nextPage(); }
    catch (error) {
      if (error instanceof BrowserUnexpectedDestinationError)
        return checkpointObservation(error.snapshot, observedAt);
      throw error;
    }
  }

  const coverage: UsVisaChinaCoverage = { contractVersion: 1, location: 'Beijing', timeZone: 'Asia/Shanghai',
    startDate: '2026-12-15', endDate: '2027-01-31', firstPage: 1, lastPage: pages.length,
    inspectedPages: pages.map(page => page.page), paginationComplete: true, appointmentAbsent: true,
    identityDigest: first.identityDigest, subjectDigest: first.subjectDigest, rosterDigest: first.rosterDigest,
    termsDigest: first.termsDigest, termsVersion: first.termsVersion };
  const complete: Observation = { observedAt, complete: true,
    coverage: structuredClone(coverage) as unknown as Observation['coverage'],
    candidates: candidates.map(item => structuredClone(item.value) as unknown as Observation['candidates'][number]),
    result: 'complete' };
  const command = policy.selectCommand({ grant: context.grant, scope: context.grant.scope, observation: complete });
  if (!command) return { ...complete, candidates: [] };
  if (!isOperationCommand(command) || !command.arguments || typeof command.arguments !== 'object')
    return nonComplete(observedAt, 'contract_changed', 'selection_contract_changed');
  const selectedId = (command.arguments as Record<string, unknown>).candidateId;
  const selected = candidates.find(item => item.value.id === selectedId);
  if (!selected) return nonComplete(observedAt, 'contract_changed', 'selection_contract_changed');

  try { snapshot = await reader.firstPage(); }
  catch (error) {
    if (error instanceof BrowserUnexpectedDestinationError)
      return checkpointObservation(error.snapshot, observedAt);
    throw error;
  }
  for (let expectedPage = 1; expectedPage <= selected.page; expectedPage++) {
    const original = pages[expectedPage - 1]!;
    if (snapshot.state !== 'calendar' || snapshot.page !== expectedPage ||
        !sameCalendarMetadata(first, snapshot) || !calendarMatchesBindings(snapshot, context))
      return nonComplete(observedAt, 'contract_changed', 'calendar_contract_changed');
    const rereadCandidates = calendarCandidates(snapshot);
    if (!rereadCandidates) return nonComplete(observedAt, 'contract_changed', 'candidate_set_changed');
    totalBytes += Buffer.byteLength(JSON.stringify(snapshot), 'utf8');
    if (totalBytes > MAX_OBSERVATION_BYTES)
      return nonComplete(observedAt, 'contract_changed', 'observation_bound_exceeded');
    if (expectedPage === selected.page) {
      if (!rereadCandidates.some(candidate => candidate.id === selected.value.id))
        return { observedAt, complete: false,
          coverage: { preflight: 'candidate_disappeared_before_reservation',
            evidenceDigest: selected.value.evidenceDigest }, candidates: [], result: 'provider_unavailable' };
      if (snapshot.hasNext !== original.hasNext)
        return nonComplete(observedAt, 'contract_changed', 'pagination_changed');
      if (!sameCandidateSet(original.candidates, rereadCandidates))
        return nonComplete(observedAt, 'contract_changed', 'candidate_set_changed');
      break;
    }
    if (!sameCandidateSet(original.candidates, rereadCandidates))
      return nonComplete(observedAt, 'contract_changed', 'candidate_set_changed');
    if (snapshot.hasNext !== original.hasNext) {
      if (original.hasNext && !snapshot.hasNext)
        return { observedAt, complete: false,
          coverage: { preflight: 'candidate_disappeared_before_reservation',
            evidenceDigest: selected.value.evidenceDigest }, candidates: [], result: 'provider_unavailable' };
      return nonComplete(observedAt, 'contract_changed', 'pagination_changed');
    }
    if (!snapshot.hasNext) return { observedAt, complete: false,
      coverage: { preflight: 'candidate_disappeared_before_reservation',
        evidenceDigest: selected.value.evidenceDigest }, candidates: [], result: 'provider_unavailable' };
    try { snapshot = await reader.nextPage(); }
    catch (error) {
      if (error instanceof BrowserUnexpectedDestinationError)
        return checkpointObservation(error.snapshot, observedAt);
      throw error;
    }
  }
  const reread = snapshot.state === 'calendar'
    ? calendarCandidates(snapshot)?.find(item => item.id === selected.value.id) : undefined;
  if (!reread) return { observedAt, complete: false,
    coverage: { preflight: 'candidate_disappeared_before_reservation',
      evidenceDigest: selected.value.evidenceDigest }, candidates: [], result: 'provider_unavailable' };
  if (JSON.stringify(reread) !== JSON.stringify(selected.value))
    return nonComplete(observedAt, 'contract_changed', 'candidate_evidence_changed');
  return { ...complete,
    candidates: [structuredClone(selected.value) as unknown as Observation['candidates'][number]] };
}

async function freshReservedPreflight(session: BrowserSession, context: CalendarContext,
    policy: MonitoredActionPolicyAdapter, expected: UsVisaChinaCandidate): Promise<UsVisaChinaPreflight> {
  const observation = await inspectSyntheticCalendar(session, context, policy);
  if (!observation.complete || observation.result !== 'complete' || observation.candidates.length !== 1)
    throw new Error('Visa preflight candidate disappeared or page evidence changed.');
  const candidate = parseUsVisaChinaCandidate(observation.candidates[0]);
  if (JSON.stringify(candidate) !== JSON.stringify(expected))
    throw new Error('Visa preflight candidate disappeared or drifted.');
  const coverage = observation.coverage as unknown as UsVisaChinaCoverage;
  return { appointmentAbsent: true, identityDigest: coverage.identityDigest,
    rosterDigest: coverage.rosterDigest, termsDigest: coverage.termsDigest, candidate };
}

export function registerDisabledUsVisaChinaAdapter(registry: MonitoringRegistry): void {
  registry.registerDisabled({ id: US_VISA_CHINA_ADAPTER_ID, version: US_VISA_CHINA_ADAPTER_VERSION,
    reason: 'supervised_discovery_required' });
}

async function current(fence: TrustedExecutionFence): Promise<void> {
  if (fence.signal.aborted || Date.now() >= fence.deadline) throw new OperationStoppedError();
  await fence.assertCurrent();
  if (fence.signal.aborted || Date.now() >= fence.deadline) throw new OperationStoppedError();
}

function boundAction(value: unknown, statuses: readonly string[]): { id: string; attemptId: string;
    arguments: Record<string, unknown>; expectedResult: Record<string, unknown> } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Visa action is not reserved.');
  const action = value as Record<string, unknown>;
  if (typeof action.status !== 'string' || !statuses.includes(action.status) ||
      typeof action.id !== 'string' || typeof action.attemptId !== 'string' ||
      !action.monitoredGrant || typeof action.monitoredGrant !== 'object' || !action.command ||
      typeof action.command !== 'object') throw new Error('Visa action is not reserved and running.');
  const monitoredGrant = action.monitoredGrant as Record<string, unknown>;
  exactObject(monitoredGrant, ['id', 'digest', 'revision'], 'visa monitored grant reference');
  if (!IDENTIFIER.test(action.id) || !IDENTIFIER.test(action.attemptId) ||
      typeof monitoredGrant.id !== 'string' || !IDENTIFIER.test(monitoredGrant.id) ||
      typeof monitoredGrant.digest !== 'string' || !DIGEST.test(monitoredGrant.digest) ||
      !Number.isSafeInteger(monitoredGrant.revision) || (monitoredGrant.revision as number) < 1)
    throw new Error('Visa action is not reserved and running.');
  const command = action.command as Record<string, unknown>;
  if (command.operationId !== US_VISA_CHINA_ADAPTER_ID || command.operationVersion !== '1' ||
      !command.arguments || typeof command.arguments !== 'object' || Array.isArray(command.arguments) ||
      !command.expectedResult || typeof command.expectedResult !== 'object' || Array.isArray(command.expectedResult))
    throw new Error('Visa action binding is invalid.');
  return { id: action.id, attemptId: action.attemptId,
    arguments: command.arguments as Record<string, unknown>, expectedResult: command.expectedResult as Record<string, unknown> };
}

function expectedArguments(value: Record<string, unknown>) {
  exactObject(value, ['bookingType', 'candidateId', 'date', 'time', 'location', 'timeZone', 'rosterDigest',
    'identityDigest', 'termsDigest', 'evidenceDigest'], 'visa action arguments');
  const candidate = parseUsVisaChinaCandidate({ id: value.candidateId, date: value.date, time: value.time,
    location: value.location, timeZone: value.timeZone, rosterDigest: value.rosterDigest,
    evidenceDigest: value.evidenceDigest });
  if (value.bookingType !== 'new_group_appointment' || typeof value.identityDigest !== 'string' ||
      !DIGEST.test(value.identityDigest) || typeof value.termsDigest !== 'string' || !DIGEST.test(value.termsDigest))
    throw new Error('Visa action binding is invalid.');
  return { candidate, identityDigest: value.identityDigest, termsDigest: value.termsDigest };
}

function assertExpectedResult(value: Record<string, unknown>, candidate: ReturnType<typeof expectedArguments>['candidate']): void {
  exactObject(value, ['status', 'date', 'time', 'location', 'timeZone', 'rosterDigest'],
    'visa expected result');
  if (value.status !== 'booked' || value.date !== candidate.date || value.time !== candidate.time ||
      value.location !== candidate.location || value.timeZone !== candidate.timeZone ||
      value.rosterDigest !== candidate.rosterDigest)
    throw new Error('Visa preflight expected-result drift.');
}

function assertPreflight(input: UsVisaChinaExecutionInput['expected'], action: ReturnType<typeof expectedArguments>,
    value: Awaited<ReturnType<UsVisaChinaExecutionInput['preflight']>>): void {
  if (!value || value.appointmentAbsent !== true || value.identityDigest !== input.identityDigest ||
      value.rosterDigest !== input.rosterDigest || value.termsDigest !== input.termsDigest ||
      action.identityDigest !== input.identityDigest || action.candidate.rosterDigest !== input.rosterDigest ||
      action.termsDigest !== input.termsDigest) throw new Error('Visa preflight drift or existing appointment.');
  const candidate = parseUsVisaChinaCandidate(value.candidate);
  if (JSON.stringify(candidate) !== JSON.stringify(action.candidate)) throw new Error('Visa preflight candidate drift.');
}

function browserBooking(value: unknown, expected: Record<string, unknown>, phase: 'confirmation' | 'appointment'):
    UsVisaChinaBooking | undefined {
  try {
    exactObject(value, phase === 'appointment' ? ['state', 'complete', 'booking'] : ['state', 'booking'],
      'visa booking snapshot');
    const snapshot = value as Record<string, unknown>;
    if (snapshot.state !== phase || (phase === 'appointment' && snapshot.complete !== true)) return undefined;
    exactObject(snapshot.booking, ['referenceDigest', 'status', 'date', 'time', 'location', 'timeZone',
      'rosterDigest'], 'visa booking readback');
    const item = snapshot.booking as Record<string, unknown>;
    if (typeof item.referenceDigest !== 'string' || !DIGEST.test(item.referenceDigest) || item.status !== 'booked' ||
        item.location !== 'Beijing' || item.timeZone !== 'Asia/Shanghai' || typeof item.date !== 'string' ||
        typeof item.time !== 'string' || !validDate(item.date) || !validTime(item.time) ||
        item.date !== expected.date || item.time !== expected.time || item.location !== expected.location ||
        item.timeZone !== expected.timeZone || item.status !== expected.status ||
        item.rosterDigest !== expected.rosterDigest || typeof item.rosterDigest !== 'string' ||
        !DIGEST.test(item.rosterDigest)) return undefined;
    return { referenceDigest: item.referenceDigest, status: 'booked', date: item.date, time: item.time,
      location: 'Beijing', timeZone: 'Asia/Shanghai', rosterDigest: item.rosterDigest };
  } catch { return undefined; }
}

function exactReview(value: unknown, expected: ReturnType<typeof expectedArguments>, input: UsVisaChinaExecutionInput['expected']): boolean {
  try {
    exactObject(value, ['state', 'candidate', 'identityDigest', 'rosterDigest', 'termsDigest',
      'appointmentAbsent', 'bookingType'], 'visa pre-mutation review');
    const review = value as Record<string, unknown>;
    if (review.state !== 'booking_review' || review.identityDigest !== input.identityDigest ||
        review.rosterDigest !== input.rosterDigest || review.termsDigest !== input.termsDigest ||
        review.appointmentAbsent !== true || review.bookingType !== 'new_group_appointment') return false;
    const candidate = parseUsVisaChinaCandidate(review.candidate);
    return JSON.stringify(candidate) === JSON.stringify(expected.candidate);
  } catch { return false; }
}

export async function executeSyntheticUsVisaBooking(input: UsVisaChinaExecutionInput): Promise<UsVisaChinaExecutionResult> {
  const action = boundAction(input.action, ['running']);
  const argumentsValue = expectedArguments(action.arguments);
  assertExpectedResult(action.expectedResult, argumentsValue.candidate);
  await current(input.fence);
  const preflight = await input.preflight();
  await current(input.fence);
  assertPreflight(input.expected, argumentsValue, preflight);
  const intentId = createHash('sha256').update(`${action.id}\0${action.attemptId}`).digest('hex');
  await current(input.fence);
  await input.portal.recordDurableIntent(intentId, argumentsValue.candidate.id);
  await current(input.fence);
  const review = await input.portal.gesture({ kind: 'slot.select', slotId: argumentsValue.candidate.id });
  await current(input.fence);
  if (!exactReview(review, argumentsValue, input.expected))
    return { status: 'failed', reason: 'contract_changed' };
  await current(input.fence);
  let submitted: unknown;
  try {
    submitted = await input.portal.gesture({ kind: 'booking.submit', slotId: argumentsValue.candidate.id, intentId });
    await current(input.fence);
  } catch { return { status: 'unknown', verificationOnly: true }; }
  if (submitted && typeof submitted === 'object' && (submitted as { state?: unknown }).state === 'ambiguous_submission')
    return { status: 'unknown', verificationOnly: true };
  const confirmation = browserBooking(submitted, action.expectedResult, 'confirmation');
  if (!confirmation) return { status: 'unknown', verificationOnly: true };
  await current(input.fence);
  if (input.recordConfirmation) {
    await input.recordConfirmation(confirmation);
    await current(input.fence);
  }
  let readback: unknown;
  try {
    readback = await input.portal.gesture({ kind: 'appointment.readback' });
    await current(input.fence);
  } catch { return { status: 'unknown', verificationOnly: true }; }
  const receipt = browserBooking(readback, action.expectedResult, 'appointment');
  if (!receipt || receipt.referenceDigest !== confirmation.referenceDigest)
    return { status: 'unknown', verificationOnly: true };
  return { status: 'accepted', verification: { status: 'satisfied' }, receipt };
}

export async function verifySyntheticUsVisaBooking(input: { action: unknown; portal: UsVisaChinaSyntheticPortalPort;
    fence: TrustedExecutionFence; confirmationReferenceDigest?: string }): Promise<{ status: 'satisfied'; receipt: UsVisaChinaBooking } |
      { status: 'unknown'; receipt?: never }> {
  let action: ReturnType<typeof boundAction>;
  try {
    action = boundAction(input.action, ['unknown', 'accepted']);
    const argumentsValue = expectedArguments(action.arguments);
    assertExpectedResult(action.expectedResult, argumentsValue.candidate);
  } catch { return { status: 'unknown' }; }
  let readback: unknown;
  try {
    await current(input.fence);
    readback = await input.portal.gesture({ kind: 'appointment.readback' });
    await current(input.fence);
  } catch { return { status: 'unknown' }; }
  const receipt = browserBooking(readback, action.expectedResult, 'appointment');
  return receipt && (!input.confirmationReferenceDigest ||
    receipt.referenceDigest === input.confirmationReferenceDigest)
    ? { status: 'satisfied', receipt } : { status: 'unknown' };
}

/** Synthetic-only production composition. Live registration remains disabled. */
export function createSyntheticUsVisaChinaExecutionAdapter(input: { session: BrowserSession }): MonitoredActionPolicyAdapter {
  exactObject(input, ['session'], 'synthetic visa execution adapter');
  if (!(input.session instanceof BrowserSession)) throw new Error('A trusted BrowserSession is required.');
  const policy = createUsVisaChinaPolicyAdapter();
  const portal = (fence: TrustedExecutionFence, intentId?: string): UsVisaChinaSyntheticPortalPort => ({
    inspect: () => input.session.inspect('calendar', fence),
    recordDurableIntent: async (recorded, slotId) => {
      if (!intentId || recorded !== intentId) throw new Error('Visa durable intent binding changed.');
      await input.session.gestureAndWaitForNavigation(
        { kind: 'booking.intent', slotId, intentId: recorded }, 'calendar', ['calendar'], fence);
    },
    gesture: async (value: unknown) => {
      const command = value as { kind: 'slot.select' | 'booking.submit' | 'appointment.readback'; slotId?: string; intentId?: string };
      let expectedState: 'calendar' | 'booking_review' | 'confirmation' | 'ambiguous_submission' | 'appointment';
      if (command.kind === 'slot.select') expectedState = 'calendar';
      else if (command.kind === 'booking.submit') expectedState = 'booking_review';
      else {
        const recognized = await input.session.recognize(fence);
        if (!['confirmation', 'ambiguous_submission', 'appointment'].includes(recognized.state))
          return recognized;
        expectedState = recognized.state as typeof expectedState;
      }
      let snapshot;
      try {
        snapshot = await input.session.gestureAndWaitForNavigation(command as never, expectedState,
          command.kind === 'slot.select' ? ['booking_review'] : command.kind === 'booking.submit'
            ? ['confirmation', 'ambiguous_submission'] : ['appointment'], fence);
      } catch (error) {
        if (command.kind === 'slot.select' && error instanceof BrowserUnexpectedDestinationError)
          return error.snapshot;
        throw error;
      }
      if (snapshot.state !== 'booking_review') return snapshot;
      return { state: 'booking_review', candidate: { ...snapshot.slot, timeZone: snapshot.timeZone,
        rosterDigest: snapshot.rosterDigest, evidenceDigest: snapshot.evidenceDigest },
        identityDigest: snapshot.identityDigest, rosterDigest: snapshot.rosterDigest,
        termsDigest: snapshot.termsDigest, appointmentAbsent: snapshot.appointmentAbsent,
        bookingType: snapshot.bookingType };
    }
  });
  return { ...policy,
    inspect(context) { return inspectSyntheticCalendar(input.session, context, policy); },
    async executeReserved({ action, grant, connection, fence, intentId, recordConfirmation }) {
      if (input.session.profileId !== grant.browserProfileId ||
          input.session.connectionGeneration !== grant.connectionGeneration ||
          connection.id !== grant.connectionId || connection.generation !== grant.connectionGeneration)
        return { status: 'failed', reason: 'contract_changed' };
      if (!isOperationCommand(action.command)) return { status: 'failed', reason: 'contract_changed' };
      const args = expectedArguments(action.command.arguments as Record<string, unknown>);
      const result = await executeSyntheticUsVisaBooking({ action, portal: portal(fence, intentId),
        expected: { identityDigest: args.identityDigest, rosterDigest: args.candidate.rosterDigest,
          termsDigest: args.termsDigest },
        preflight: () => freshReservedPreflight(input.session, { grant, connection, fence }, policy, args.candidate),
        recordConfirmation: booking => recordConfirmation(jsonValue(booking, 'visa confirmation')), fence });
      if (result.status === 'accepted') return { status: 'accepted', receipt: jsonValue(result.receipt, 'visa receipt') };
      return result;
    },
    async verifyReserved({ action, grant, connection, fence }) {
      if (input.session.profileId !== grant.browserProfileId ||
          input.session.connectionGeneration !== grant.connectionGeneration || connection.id !== grant.connectionId)
        return { status: 'unknown' };
      const result = await verifySyntheticUsVisaBooking({ action, portal: portal(fence), fence,
        ...(action.monitoredConfirmation
          ? { confirmationReferenceDigest: action.monitoredConfirmation.referenceDigest } : {}) });
      return result.status === 'satisfied'
        ? { status: 'satisfied', receipt: jsonValue(result.receipt, 'visa receipt') } : result;
    }
  };
}

export { createUsVisaChinaPolicyAdapter };
