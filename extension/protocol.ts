export const EXTENSION_PROTOCOL_VERSION = 1 as const;
export const EXTENSION_MAX_MESSAGE_BYTES = 32 * 1024;
export const EXTENSION_ALLOWED_ORIGIN = 'http://127.0.0.1:43117';
export const EXTENSION_NATIVE_HOST = 'com.behalvo.synthetic_browser';

export type ExtensionPageState = 'login' | 'security_question' | 'group_roster' | 'calendar' |
  'booking_review' | 'challenge' | 'session_expired' | 'forbidden' | 'rate_limited' |
  'terms_changed' | 'unknown' | 'confirmation' | 'ambiguous_submission' | 'appointment';

export interface ExtensionRequest {
  protocolVersion: 1;
  kind: 'recognize' | 'inspect' | 'gesture';
  requestId: string;
  profileId: string;
  connectionGeneration: number;
  epoch: string;
  serviceGeneration: string;
  origin: string;
  tabId: number;
  sequence: number;
  expectedPageState?: ExtensionPageState;
  operationId?: string;
  operationExpiresAt?: number;
  command?: { kind: 'calendar.first_page' } | { kind: 'calendar.next_page' } |
    { kind: 'slot.select'; slotId: string } |
    { kind: 'booking.intent'; slotId: string; intentId: string } |
    { kind: 'booking.submit'; slotId: string; intentId: string } | { kind: 'appointment.readback' };
}

export interface ExtensionResponse {
  protocolVersion: 1;
  kind: 'result';
  requestId: string;
  profileId: string;
  connectionGeneration: number;
  epoch: string;
  serviceGeneration: string;
  origin: string;
  tabId: number;
  sequence: number;
  documentId: string;
  pageState: ExtensionPageState;
  snapshot: Record<string, unknown>;
}

export interface ExtensionSessionControl {
  protocolVersion: 1;
  kind: 'session.activate' | 'session.revoke';
  controlId: string;
  profileId: string;
  connectionGeneration: number;
  epoch: string;
  serviceGeneration: string;
  origin: string;
  tabId: number;
}

export interface ExtensionGestureCommit extends Omit<ExtensionSessionControl, 'kind'> {
  kind: 'gesture.commit';
  requestId: string;
  sequence: number;
  operationId: string;
}

export interface ExtensionGestureCancel extends Omit<ExtensionGestureCommit, 'kind'> {
  kind: 'gesture.cancel';
}

export type ExtensionNativeMessage = ExtensionRequest | ExtensionSessionControl | ExtensionGestureCommit |
  ExtensionGestureCancel;

export interface ExtensionControlResponse extends Omit<ExtensionSessionControl, 'kind'> {
  kind: 'session.activated' | 'session.revoked';
}

export interface ExtensionPreparedResponse extends Omit<ExtensionResponse, 'kind'> {
  kind: 'gesture.prepared';
}

export interface ExtensionCancellationResponse extends Omit<ExtensionGestureCancel, 'kind'> {
  kind: 'gesture.cancelled' | 'gesture.settled';
}

function invalid(): never { throw new Error('Browser protocol message is invalid.'); }

export function validateExtensionRequest(value: unknown): ExtensionRequest {
  let encoded: string;
  try { encoded = JSON.stringify(value); } catch { invalid(); }
  if (encoded === undefined || new TextEncoder().encode(encoded).length > EXTENSION_MAX_MESSAGE_BYTES ||
      !value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const item = value as Record<string, unknown>;
  const envelope = ['protocolVersion', 'kind', 'requestId', 'profileId', 'connectionGeneration', 'epoch',
    'serviceGeneration', 'origin', 'tabId', 'sequence'];
  const base = item.kind === 'recognize' ? envelope : [...envelope, 'expectedPageState'];
  const expected = item.kind === 'gesture' ? [...base, 'command', 'operationId', 'operationExpiresAt'] : base;
  if (Object.keys(item).sort().join('\0') !== expected.sort().join('\0') || item.protocolVersion !== 1 ||
      !['recognize', 'inspect', 'gesture'].includes(String(item.kind)) || item.origin !== EXTENSION_ALLOWED_ORIGIN ||
      !positive(item.connectionGeneration) || !positive(item.tabId) || !positive(item.sequence) ||
      typeof item.epoch !== 'string' || !/^[a-f0-9]{64}$/.test(item.epoch) ||
      (item.kind !== 'recognize' && (typeof item.expectedPageState !== 'string' ||
        !pageStates.has(item.expectedPageState as ExtensionPageState)))) invalid();
  identifier(item.requestId); identifier(item.profileId); identifier(item.serviceGeneration);
  if (item.kind === 'gesture') {
    validateCommand(item.command, String(item.expectedPageState));
    identifier(item.operationId); operationExpiry(item.operationExpiresAt);
  }
  return structuredClone(item) as unknown as ExtensionRequest;
}

export function validateExtensionResponse(value: unknown): ExtensionResponse {
  let encoded: string;
  try { encoded = JSON.stringify(value); } catch { invalid(); }
  if (encoded === undefined || new TextEncoder().encode(encoded).length > EXTENSION_MAX_MESSAGE_BYTES ||
      !value || typeof value !== 'object' || Array.isArray(value)) invalid();
  rejectSensitive(value);
  const item = value as Record<string, unknown>;
  const keys = ['protocolVersion', 'kind', 'requestId', 'profileId', 'connectionGeneration', 'epoch',
    'serviceGeneration', 'origin', 'tabId', 'sequence', 'documentId', 'pageState', 'snapshot'];
  if (Object.keys(item).sort().join('\0') !== keys.sort().join('\0') || item.protocolVersion !== 1 ||
      item.kind !== 'result' || item.origin !== EXTENSION_ALLOWED_ORIGIN ||
      !positive(item.connectionGeneration) || !positive(item.tabId) || !positive(item.sequence) ||
      typeof item.epoch !== 'string' || !/^[a-f0-9]{64}$/.test(item.epoch) ||
      typeof item.pageState !== 'string' || !pageStates.has(item.pageState as ExtensionPageState) ||
      !item.snapshot || typeof item.snapshot !== 'object' || Array.isArray(item.snapshot)) invalid();
  identifier(item.requestId); identifier(item.profileId); identifier(item.serviceGeneration); identifier(item.documentId);
  const snapshot = validateExtensionSnapshot(item.snapshot);
  if (snapshot.state !== item.pageState) invalid();
  return structuredClone({ ...item, snapshot }) as unknown as ExtensionResponse;
}

export function validateExtensionNativeMessage(value: unknown): ExtensionNativeMessage {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const kind = (value as Record<string, unknown>).kind;
    if (kind === 'recognize' || kind === 'inspect' || kind === 'gesture') return validateExtensionRequest(value);
    if (kind === 'session.activate' || kind === 'session.revoke') return validateSessionControl(value);
    if (kind === 'gesture.commit' || kind === 'gesture.cancel') return validateGestureControl(value) as
      ExtensionGestureCommit | ExtensionGestureCancel;
  }
  invalid();
}

export function validateExtensionControlResponse(value: unknown): ExtensionControlResponse {
  assertEncoded(value);
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const item = value as Record<string, unknown>;
  exact(item, ['protocolVersion', 'kind', 'controlId', 'profileId', 'connectionGeneration', 'epoch',
    'serviceGeneration', 'origin', 'tabId']);
  if (item.kind !== 'session.activated' && item.kind !== 'session.revoked') invalid();
  validateControlBinding(item);
  return structuredClone(item) as unknown as ExtensionControlResponse;
}

export function validateExtensionPreparedResponse(value: unknown): ExtensionPreparedResponse {
  assertEncoded(value); rejectSensitive(value);
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const item = value as Record<string, unknown>;
  exact(item, ['protocolVersion', 'kind', 'requestId', 'profileId', 'connectionGeneration', 'epoch',
    'serviceGeneration', 'origin', 'tabId', 'sequence', 'documentId', 'pageState', 'snapshot']);
  if (item.kind !== 'gesture.prepared') invalid();
  validateResultBinding(item);
  const snapshot = validateExtensionSnapshot(item.snapshot);
  if (snapshot.state !== item.pageState) invalid();
  return structuredClone({ ...item, snapshot }) as unknown as ExtensionPreparedResponse;
}

export function validateExtensionCancellationResponse(value: unknown): ExtensionCancellationResponse {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const kind = (value as Record<string, unknown>).kind;
  if (kind !== 'gesture.cancelled' && kind !== 'gesture.settled') invalid();
  const message = validateGestureControl(value, kind);
  return message as ExtensionCancellationResponse;
}

export function validateExtensionSnapshot(value: unknown): Record<string, unknown> {
  rejectSensitive(value);
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const item = value as Record<string, unknown>;
  const state = item.state;
  if (typeof state !== 'string' || !pageStates.has(state as ExtensionPageState)) invalid();
  if (['login', 'security_question', 'challenge', 'session_expired', 'forbidden', 'rate_limited',
    'terms_changed', 'unknown'].includes(state)) { exact(item, ['state']); return { state }; }
  if (state === 'group_roster') {
    exact(item, ['state', 'identityDigest', 'subjectDigest', 'rosterDigest', 'termsVersion']);
    digest(item.identityDigest); digest(item.subjectDigest); digest(item.rosterDigest); identifier(item.termsVersion);
  } else if (state === 'calendar') {
    exact(item, ['state', 'contractVersion', 'location', 'timeZone', 'startDate', 'endDate',
      'identityDigest', 'subjectDigest', 'rosterDigest', 'termsDigest', 'termsVersion',
      'appointmentAbsent', 'page', 'hasNext', 'candidates']);
    if (item.contractVersion !== 1 || item.location !== 'Beijing' || item.timeZone !== 'Asia/Shanghai' ||
        item.startDate !== '2026-12-15' || item.endDate !== '2027-01-31' || item.appointmentAbsent !== true ||
        !Number.isSafeInteger(item.page) || (item.page as number) < 1 || (item.page as number) > 100 ||
        typeof item.hasNext !== 'boolean' || !Array.isArray(item.candidates) || item.candidates.length > 64) invalid();
    digest(item.identityDigest); digest(item.subjectDigest); digest(item.rosterDigest); digest(item.termsDigest);
    identifier(item.termsVersion);
    for (const candidate of item.candidates) validateCalendarCandidate(candidate);
  } else if (state === 'booking_review') {
    exact(item, ['state', 'slot', 'identityDigest', 'rosterDigest', 'termsDigest', 'evidenceDigest',
      'appointmentAbsent', 'bookingType', 'timeZone']); validateSlot(item.slot);
    digest(item.identityDigest); digest(item.rosterDigest); digest(item.termsDigest); digest(item.evidenceDigest);
    if (item.appointmentAbsent !== true || item.bookingType !== 'new_group_appointment' ||
        item.timeZone !== 'Asia/Shanghai') invalid();
  } else if (state === 'confirmation') {
    exact(item, ['state', 'booking']); validateBooking(item.booking);
  } else if (state === 'appointment') {
    exact(item, ['state', 'complete', 'booking']); validateBooking(item.booking);
    if (item.complete !== true) invalid();
  } else {
    exact(item, ['state', 'intentId']); identifier(item.intentId);
  }
  return structuredClone(item);
}

function validateCommand(value: unknown, state: string): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const command = value as Record<string, unknown>;
  if (command.kind === 'calendar.first_page' || command.kind === 'calendar.next_page') {
    if (Object.keys(command).length !== 1 || state !== 'calendar') invalid();
  } else if (command.kind === 'slot.select') {
    if (Object.keys(command).sort().join() !== 'kind,slotId' || state !== 'calendar') invalid();
    identifier(command.slotId);
  } else if (command.kind === 'booking.intent' || command.kind === 'booking.submit') {
    if (Object.keys(command).sort().join() !== 'intentId,kind,slotId') invalid();
    if (command.kind === 'booking.intent' && state !== 'calendar') invalid();
    if (command.kind === 'booking.submit' && state !== 'booking_review') invalid();
    identifier(command.slotId); identifier(command.intentId);
  } else if (command.kind === 'appointment.readback') {
    if (Object.keys(command).length !== 1 || !['confirmation', 'ambiguous_submission', 'appointment'].includes(state)) invalid();
  } else invalid();
}

function validateCalendarCandidate(value: unknown): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const item = value as Record<string, unknown>;
  exact(item, ['id', 'date', 'time', 'location', 'evidenceDigest']);
  validateSlot({ id: item.id, date: item.date, time: item.time, location: item.location });
  digest(item.evidenceDigest);
}

function validateSessionControl(value: unknown): ExtensionSessionControl {
  assertEncoded(value); rejectSensitive(value);
  const item = value as Record<string, unknown>;
  exact(item, ['protocolVersion', 'kind', 'controlId', 'profileId', 'connectionGeneration', 'epoch',
    'serviceGeneration', 'origin', 'tabId']);
  if (item.kind !== 'session.activate' && item.kind !== 'session.revoke') invalid();
  validateControlBinding(item);
  return structuredClone(item) as unknown as ExtensionSessionControl;
}

function validateGestureControl(value: unknown, responseKind?: 'gesture.cancelled' | 'gesture.settled'):
  ExtensionGestureCommit | ExtensionGestureCancel | ExtensionCancellationResponse {
  assertEncoded(value); rejectSensitive(value);
  const item = value as Record<string, unknown>;
  exact(item, ['protocolVersion', 'kind', 'controlId', 'profileId', 'connectionGeneration', 'epoch',
    'serviceGeneration', 'origin', 'tabId', 'requestId', 'sequence', 'operationId']);
  if (responseKind ? item.kind !== responseKind : item.kind !== 'gesture.commit' && item.kind !== 'gesture.cancel') invalid();
  validateControlBinding(item); identifier(item.requestId); positiveRequired(item.sequence); identifier(item.operationId);
  return structuredClone(item) as unknown as ExtensionGestureCommit | ExtensionGestureCancel |
    ExtensionCancellationResponse;
}

function validateControlBinding(item: Record<string, unknown>): void {
  if (item.protocolVersion !== 1 || item.origin !== EXTENSION_ALLOWED_ORIGIN ||
      typeof item.epoch !== 'string' || !/^[a-f0-9]{64}$/.test(item.epoch)) invalid();
  identifier(item.controlId); identifier(item.profileId); identifier(item.serviceGeneration);
  positiveRequired(item.connectionGeneration); positiveRequired(item.tabId);
}

function validateResultBinding(item: Record<string, unknown>): void {
  if (item.protocolVersion !== 1 || item.origin !== EXTENSION_ALLOWED_ORIGIN ||
      typeof item.epoch !== 'string' || !/^[a-f0-9]{64}$/.test(item.epoch) ||
      typeof item.pageState !== 'string' || !pageStates.has(item.pageState as ExtensionPageState)) invalid();
  identifier(item.requestId); identifier(item.profileId); identifier(item.serviceGeneration); identifier(item.documentId);
  positiveRequired(item.connectionGeneration); positiveRequired(item.tabId); positiveRequired(item.sequence);
}

function assertEncoded(value: unknown): void {
  let encoded: string;
  try { encoded = JSON.stringify(value); } catch { invalid(); }
  if (encoded === undefined || new TextEncoder().encode(encoded).length > EXTENSION_MAX_MESSAGE_BYTES) invalid();
}

function positiveRequired(value: unknown): void { if (!positive(value)) invalid(); }

const pageStates = new Set<ExtensionPageState>(['login', 'security_question', 'group_roster', 'calendar',
  'booking_review', 'challenge', 'session_expired', 'forbidden', 'rate_limited', 'terms_changed', 'unknown',
  'confirmation', 'ambiguous_submission', 'appointment']);

function exact(item: Record<string, unknown>, keys: string[]): void {
  if (Object.keys(item).sort().join('\0') !== [...keys].sort().join('\0')) invalid();
}

function identifier(value: unknown): void {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(value)) invalid();
}

function positive(value: unknown): boolean {
  return Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= 1_000_000;
}

function operationExpiry(value: unknown): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1 || value > Number.MAX_SAFE_INTEGER) invalid();
}

function digest(value: unknown): void {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) invalid();
}

function validateSlot(value: unknown): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const item = value as Record<string, unknown>; exact(item, ['id', 'date', 'time', 'location']);
  identifier(item.id);
  if (typeof item.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(item.date) ||
      typeof item.time !== 'string' || !/^\d{2}:\d{2}$/.test(item.time) || item.location !== 'Beijing') invalid();
  const [year, month, day] = item.date.split('-').map(Number);
  const parsed = new Date(Date.UTC(year!, month! - 1, day!));
  const [hour, minute] = item.time.split(':').map(Number);
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() + 1 !== month || parsed.getUTCDate() !== day ||
      hour! > 23 || minute! > 59) invalid();
}

function validateBooking(value: unknown): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const item = value as Record<string, unknown>;
  exact(item, ['referenceDigest', 'status', 'rosterDigest', 'date', 'time', 'location', 'timeZone']);
  digest(item.referenceDigest); digest(item.rosterDigest);
  if (item.status !== 'booked' || item.timeZone !== 'Asia/Shanghai') invalid();
  validateSlot({ id: 'booking', date: item.date, time: item.time, location: item.location });
}

function rejectSensitive(value: unknown): void {
  if (Array.isArray(value)) { for (const item of value) rejectSensitive(item); return; }
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (/^(?:password|securityanswer|cookie|cookies|token|authorization|html|dom|script|url|headers?|body)$/i.test(key)) invalid();
    rejectSensitive(item);
  }
}
