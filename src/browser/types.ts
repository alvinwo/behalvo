import type { JsonValue } from '../operations/types.js';
import type { TrustedExecutionFence } from '../operations/execution-context.js';

export const BROWSER_PROTOCOL_VERSION = 1 as const;
export const MAX_BROWSER_MESSAGE_BYTES = 32 * 1024;
export const SYNTHETIC_PORTAL_ORIGIN = 'http://127.0.0.1:43117';

export type BrowserPageState = 'login' | 'security_question' | 'group_roster' | 'calendar' |
  'booking_review' | 'challenge' | 'session_expired' | 'forbidden' | 'rate_limited' |
  'terms_changed' | 'unknown' | 'confirmation' | 'ambiguous_submission' | 'appointment';

export interface BrowserEpoch {
  profileId: string;
  connectionGeneration: number;
  epoch: string;
  serviceGeneration: string;
  allowedOrigin: string;
}

export type BrowserGestureCommand =
  | { kind: 'calendar.next_page' }
  | { kind: 'slot.select'; slotId: string }
  | { kind: 'booking.intent'; slotId: string; intentId: string }
  | { kind: 'booking.submit'; slotId: string; intentId: string }
  | { kind: 'appointment.readback' };

export interface BrowserSlot {
  id: string;
  date: string;
  time: string;
  location: 'Beijing';
}

export interface BrowserBooking {
  referenceDigest: string;
  status: 'booked';
  rosterDigest: string;
  date: string;
  time: string;
  location: 'Beijing';
  timeZone: 'Asia/Shanghai';
}

export type BrowserPageSnapshot =
  | { state: 'login' | 'security_question' | 'challenge' | 'session_expired' | 'forbidden' |
      'rate_limited' | 'terms_changed' | 'unknown' }
  | { state: 'group_roster'; identityDigest: string; subjectDigest: string; rosterDigest: string; termsVersion: string }
  | { state: 'calendar'; page: number; hasNext: boolean; candidates: BrowserSlot[] }
  | { state: 'booking_review'; slot: BrowserSlot; identityDigest: string; rosterDigest: string;
      termsDigest: string; evidenceDigest: string; appointmentAbsent: true;
      bookingType: 'new_group_appointment'; timeZone: 'Asia/Shanghai' }
  | { state: 'confirmation'; booking: BrowserBooking }
  | { state: 'appointment'; complete: true; booking: BrowserBooking }
  | { state: 'ambiguous_submission'; intentId: string };

interface BrowserEnvelope {
  protocolVersion: typeof BROWSER_PROTOCOL_VERSION;
  requestId: string;
  profileId: string;
  connectionGeneration: number;
  epoch: string;
  serviceGeneration: string;
  origin: string;
  tabId: number;
  sequence: number;
}

export type BrowserRequest = BrowserEnvelope & ({
  kind: 'recognize';
} | {
  kind: 'inspect';
  expectedPageState: BrowserPageState;
} | {
  kind: 'gesture';
  expectedPageState: BrowserPageState;
  command: BrowserGestureCommand;
});

export type BrowserResponse = BrowserEnvelope & {
  kind: 'result';
  pageState: BrowserPageState;
  snapshot: BrowserPageSnapshot;
};

export interface BrowserSessionPort {
  recognize(fence: TrustedExecutionFence): Promise<BrowserPageSnapshot>;
  inspect(expectedState: BrowserPageState, fence: TrustedExecutionFence): Promise<BrowserPageSnapshot>;
  gesture(command: BrowserGestureCommand, expectedState: BrowserPageState,
    fence: TrustedExecutionFence): Promise<BrowserPageSnapshot>;
  transferToHuman(reason: string): Promise<void>;
  recoverHandoff(): Promise<void>;
  resume(): Promise<BrowserEpoch>;
}

export interface BrowserSessionLifecycle {
  readonly profileId?: string;
  readonly connectionGeneration?: number;
  shutdown(): Promise<void>;
}

const pageStates = new Set<BrowserPageState>(['login', 'security_question', 'group_roster', 'calendar',
  'booking_review', 'challenge', 'session_expired', 'forbidden', 'rate_limited', 'terms_changed', 'unknown',
  'confirmation', 'ambiguous_submission', 'appointment']);
const sensitiveKeys = /^(?:password|securityanswer|cookie|cookies|token|authorization|html|dom|script|url|headers?|body)$/i;

function invalid(): never { throw new Error('Browser protocol message is invalid.'); }

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype)
    invalid();
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, required: readonly string[]): void {
  const keys = Object.keys(value).sort();
  const expected = [...required].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) invalid();
}

function identifier(value: unknown): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 128 || !/^[A-Za-z0-9._:-]+$/.test(value)) invalid();
  return value;
}

function digest(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) invalid();
  return value;
}

function bounded(value: unknown, maximum = 1_000_000): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum) invalid();
  return value as number;
}

function origin(value: unknown): string {
  if (typeof value !== 'string' || value.length > 128) invalid();
  let parsed: URL;
  try { parsed = new URL(value); } catch { invalid(); }
  if (parsed.origin !== value || parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1' || !parsed.port ||
      parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) invalid();
  return value;
}

function pageState(value: unknown): BrowserPageState {
  if (typeof value !== 'string' || !pageStates.has(value as BrowserPageState)) invalid();
  return value as BrowserPageState;
}

function assertSize(value: unknown, maximum = MAX_BROWSER_MESSAGE_BYTES): void {
  let encoded: string;
  try { encoded = JSON.stringify(value); } catch { invalid(); }
  if (encoded === undefined || Buffer.byteLength(encoded, 'utf8') > maximum) invalid();
}

function rejectSensitive(value: unknown): void {
  if (Array.isArray(value)) { for (const item of value) rejectSensitive(item); return; }
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (sensitiveKeys.test(key)) invalid();
    rejectSensitive(item);
  }
}

function parseEnvelope(value: Record<string, unknown>): BrowserEnvelope {
  if (value.protocolVersion !== BROWSER_PROTOCOL_VERSION) invalid();
  return {
    protocolVersion: BROWSER_PROTOCOL_VERSION,
    requestId: identifier(value.requestId), profileId: identifier(value.profileId),
    connectionGeneration: bounded(value.connectionGeneration), epoch: digest(value.epoch),
    serviceGeneration: identifier(value.serviceGeneration), origin: origin(value.origin),
    tabId: bounded(value.tabId), sequence: bounded(value.sequence)
  };
}

export function parseBrowserGesture(value: unknown): BrowserGestureCommand {
  const item = object(value);
  if (item.kind === 'calendar.next_page' || item.kind === 'appointment.readback') {
    exact(item, ['kind']); return { kind: item.kind };
  }
  if (item.kind === 'slot.select') {
    exact(item, ['kind', 'slotId']); return { kind: item.kind, slotId: identifier(item.slotId) };
  }
  if (item.kind === 'booking.intent' || item.kind === 'booking.submit') {
    exact(item, ['kind', 'slotId', 'intentId']);
    return { kind: item.kind, slotId: identifier(item.slotId), intentId: identifier(item.intentId) };
  }
  invalid();
}

function validGestureState(command: BrowserGestureCommand, expected: BrowserPageState): boolean {
  if (command.kind === 'calendar.next_page' || command.kind === 'slot.select' || command.kind === 'booking.intent')
    return expected === 'calendar';
  if (command.kind === 'booking.submit') return expected === 'booking_review';
  return ['confirmation', 'ambiguous_submission', 'appointment'].includes(expected);
}

export function parseBrowserRequest(value: unknown): BrowserRequest {
  assertSize(value); rejectSensitive(value);
  const item = object(value);
  if (item.kind === 'recognize') {
    exact(item, ['protocolVersion', 'kind', 'requestId', 'profileId', 'connectionGeneration', 'epoch',
      'serviceGeneration', 'origin', 'tabId', 'sequence']);
    return { ...parseEnvelope(item), kind: 'recognize' };
  }
  if (item.kind === 'inspect') {
    exact(item, ['protocolVersion', 'kind', 'requestId', 'profileId', 'connectionGeneration', 'epoch',
      'serviceGeneration', 'origin', 'tabId', 'sequence', 'expectedPageState']);
    return { ...parseEnvelope(item), kind: 'inspect', expectedPageState: pageState(item.expectedPageState) };
  }
  if (item.kind === 'gesture') {
    exact(item, ['protocolVersion', 'kind', 'requestId', 'profileId', 'connectionGeneration', 'epoch',
      'serviceGeneration', 'origin', 'tabId', 'sequence', 'expectedPageState', 'command']);
    const command = parseBrowserGesture(item.command);
    const expectedPageState = pageState(item.expectedPageState);
    if (!validGestureState(command, expectedPageState)) invalid();
    return { ...parseEnvelope(item), kind: 'gesture', expectedPageState, command };
  }
  invalid();
}

function parseSlot(value: unknown): BrowserSlot {
  const item = object(value); exact(item, ['id', 'date', 'time', 'location']);
  if (typeof item.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(item.date) ||
      typeof item.time !== 'string' || !/^\d{2}:\d{2}$/.test(item.time) || item.location !== 'Beijing') invalid();
  const [year, month, day] = item.date.split('-').map(Number);
  const parsed = new Date(Date.UTC(year!, month! - 1, day!));
  const [hour, minute] = item.time.split(':').map(Number);
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() + 1 !== month || parsed.getUTCDate() !== day ||
      hour! > 23 || minute! > 59) invalid();
  return { id: identifier(item.id), date: item.date, time: item.time, location: 'Beijing' };
}

function parseBooking(value: unknown): BrowserBooking {
  const item = object(value); exact(item, ['referenceDigest', 'status', 'rosterDigest', 'date', 'time', 'location', 'timeZone']);
  const slot = parseSlot({ id: 'booking', date: item.date, time: item.time, location: item.location });
  if (item.status !== 'booked' || item.timeZone !== 'Asia/Shanghai') invalid();
  return { referenceDigest: digest(item.referenceDigest), rosterDigest: digest(item.rosterDigest),
    status: 'booked', date: slot.date, time: slot.time, location: 'Beijing', timeZone: 'Asia/Shanghai' };
}

export function parseBrowserSnapshot(value: unknown): BrowserPageSnapshot {
  rejectSensitive(value);
  const item = object(value); const state = pageState(item.state);
  if (['login', 'security_question', 'challenge', 'session_expired', 'forbidden', 'rate_limited',
    'terms_changed', 'unknown'].includes(state)) { exact(item, ['state']); return { state: state as
      'login' | 'security_question' | 'challenge' | 'session_expired' | 'forbidden' | 'rate_limited' |
      'terms_changed' | 'unknown' }; }
  if (state === 'group_roster') {
    exact(item, ['state', 'identityDigest', 'subjectDigest', 'rosterDigest', 'termsVersion']);
    return { state, identityDigest: digest(item.identityDigest), subjectDigest: digest(item.subjectDigest),
      rosterDigest: digest(item.rosterDigest), termsVersion: identifier(item.termsVersion) };
  }
  if (state === 'calendar') {
    exact(item, ['state', 'page', 'hasNext', 'candidates']);
    if (typeof item.hasNext !== 'boolean' || !Array.isArray(item.candidates) || item.candidates.length > 64) invalid();
    return { state, page: bounded(item.page, 100), hasNext: item.hasNext, candidates: item.candidates.map(parseSlot) };
  }
  if (state === 'booking_review') {
    exact(item, ['state', 'slot', 'identityDigest', 'rosterDigest', 'termsDigest', 'evidenceDigest',
      'appointmentAbsent', 'bookingType', 'timeZone']);
    if (item.appointmentAbsent !== true || item.bookingType !== 'new_group_appointment' ||
        item.timeZone !== 'Asia/Shanghai') invalid();
    return { state, slot: parseSlot(item.slot), identityDigest: digest(item.identityDigest),
      rosterDigest: digest(item.rosterDigest), termsDigest: digest(item.termsDigest),
      evidenceDigest: digest(item.evidenceDigest), appointmentAbsent: true,
      bookingType: 'new_group_appointment', timeZone: 'Asia/Shanghai' };
  }
  if (state === 'confirmation') {
    exact(item, ['state', 'booking']); return { state, booking: parseBooking(item.booking) };
  }
  if (state === 'appointment') {
    exact(item, ['state', 'complete', 'booking']);
    if (item.complete !== true) invalid();
    return { state, complete: true, booking: parseBooking(item.booking) };
  }
  exact(item, ['state', 'intentId']);
  return { state: 'ambiguous_submission', intentId: identifier(item.intentId) };
}

export function parseBrowserResponse(value: unknown): BrowserResponse {
  assertSize(value); rejectSensitive(value);
  const item = object(value);
  exact(item, ['protocolVersion', 'kind', 'requestId', 'profileId', 'connectionGeneration', 'epoch',
    'serviceGeneration', 'origin', 'tabId', 'sequence', 'pageState', 'snapshot']);
  if (item.kind !== 'result') invalid();
  const snapshot = parseBrowserSnapshot(item.snapshot); const state = pageState(item.pageState);
  if (state !== snapshot.state) invalid();
  return { ...parseEnvelope(item), kind: 'result', pageState: state, snapshot };
}

export function browserMessageBytes(value: JsonValue | BrowserRequest | BrowserResponse): Buffer {
  assertSize(value);
  return Buffer.from(JSON.stringify(value), 'utf8');
}
