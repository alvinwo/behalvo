const CONTENT_ALLOWED_ORIGIN = 'http://127.0.0.1:43117';
const CONTENT_MAX_MESSAGE_BYTES = 32 * 1024;

type ContentPageState = 'login' | 'security_question' | 'group_roster' | 'calendar' |
  'booking_review' | 'challenge' | 'session_expired' | 'forbidden' | 'rate_limited' |
  'terms_changed' | 'unknown' | 'confirmation' | 'ambiguous_submission' | 'appointment';

type ContentCommand = { kind: 'calendar.first_page' } | { kind: 'calendar.next_page' } |
  { kind: 'slot.select'; slotId: string } |
  { kind: 'booking.intent'; slotId: string; intentId: string } |
  { kind: 'booking.submit'; slotId: string; intentId: string } | { kind: 'appointment.readback' };

interface ContentRequest {
  protocolVersion: 1;
  kind: 'recognize' | 'inspect' | 'gesture';
  requestId: string;
  profileId: string;
  connectionGeneration: number;
  epoch: string;
  serviceGeneration: string;
  origin: string;
  tabId: number;
  documentId: string;
  sequence: number;
  expectedPageState?: ContentPageState;
  command?: ContentCommand;
  operationId?: string;
  operationExpiresAt?: number;
}

interface ContentSessionControl {
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

interface ContentGestureCommit extends Omit<ContentSessionControl, 'kind'> {
  kind: 'gesture.commit' | 'gesture.cancel';
  requestId: string;
  sequence: number;
  operationId: string;
  documentId: string;
}

interface ContentDocumentBind extends Omit<ContentSessionControl, 'kind'> {
  kind: 'document.bind';
  lastSequence: number;
}

type ContentMessage = ContentRequest | ContentSessionControl | ContentGestureCommit | ContentDocumentBind;

interface ContentElement {
  dataset: Record<string, string | undefined>;
  value?: string;
  click(): void;
}

interface ContentDocument {
  querySelector(selector: string): ContentElement | null;
  querySelectorAll(selector: string): Iterable<ContentElement>;
}

function contentInvalid(): never { throw new Error('Browser request was rejected.'); }

class ContentPageContractError extends Error {
  constructor() { super('Browser page contract changed.'); this.name = 'ContentPageContractError'; }
}

function contentExact(value: Record<string, unknown>, keys: readonly string[]): void {
  const actual = Object.keys(value).sort(); const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) contentInvalid();
}

function contentIdentifier(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(value)) contentInvalid();
  return value;
}

function contentPositive(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 1_000_000) contentInvalid();
  return value as number;
}

const contentStates = new Set<ContentPageState>(['login', 'security_question', 'group_roster', 'calendar',
  'booking_review', 'challenge', 'session_expired', 'forbidden', 'rate_limited', 'terms_changed', 'unknown',
  'confirmation', 'ambiguous_submission', 'appointment']);

function validateContentCommand(value: unknown, state: ContentPageState): ContentCommand {
  if (!value || typeof value !== 'object' || Array.isArray(value)) contentInvalid();
  const command = value as Record<string, unknown>;
  if (command.kind === 'calendar.first_page' || command.kind === 'calendar.next_page') {
    contentExact(command, ['kind']); if (state !== 'calendar') contentInvalid(); return { kind: command.kind };
  }
  if (command.kind === 'slot.select') {
    contentExact(command, ['kind', 'slotId']); if (state !== 'calendar') contentInvalid();
    return { kind: command.kind, slotId: contentIdentifier(command.slotId) };
  }
  if (command.kind === 'booking.intent' || command.kind === 'booking.submit') {
    contentExact(command, ['kind', 'slotId', 'intentId']);
    if (state !== (command.kind === 'booking.intent' ? 'calendar' : 'booking_review')) contentInvalid();
    return { kind: command.kind, slotId: contentIdentifier(command.slotId),
      intentId: contentIdentifier(command.intentId) };
  }
  if (command.kind === 'appointment.readback') {
    contentExact(command, ['kind']);
    if (!['confirmation', 'ambiguous_submission', 'appointment'].includes(state)) contentInvalid();
    return { kind: command.kind };
  }
  contentInvalid();
}

function validateContentRequest(value: unknown): ContentRequest {
  let encoded: string;
  try { encoded = JSON.stringify(value); } catch { contentInvalid(); }
  if (encoded === undefined || new TextEncoder().encode(encoded).length > CONTENT_MAX_MESSAGE_BYTES ||
      !value || typeof value !== 'object' || Array.isArray(value)) contentInvalid();
  const item = value as Record<string, unknown>;
  const envelope = ['protocolVersion', 'kind', 'requestId', 'profileId', 'connectionGeneration', 'epoch',
    'serviceGeneration', 'origin', 'tabId', 'documentId', 'sequence'];
  const base = item.kind === 'recognize' ? envelope : [...envelope, 'expectedPageState'];
  contentExact(item, item.kind === 'gesture' ? [...base, 'command', 'operationId', 'operationExpiresAt'] : base);
  if (item.protocolVersion !== 1 || !['recognize', 'inspect', 'gesture'].includes(String(item.kind)) ||
      item.origin !== CONTENT_ALLOWED_ORIGIN || typeof item.epoch !== 'string' || !/^[a-f0-9]{64}$/.test(item.epoch) ||
      (item.kind !== 'recognize' && (typeof item.expectedPageState !== 'string' ||
        !contentStates.has(item.expectedPageState as ContentPageState)))) contentInvalid();
  contentIdentifier(item.requestId); contentIdentifier(item.profileId); contentIdentifier(item.serviceGeneration);
  contentIdentifier(item.documentId);
  contentPositive(item.connectionGeneration); contentPositive(item.tabId); contentPositive(item.sequence);
  const request = structuredClone(item) as unknown as ContentRequest;
  if (request.kind === 'gesture') {
    request.command = validateContentCommand(item.command, request.expectedPageState!);
    request.operationId = contentIdentifier(item.operationId);
    if (typeof item.operationExpiresAt !== 'number' || !Number.isFinite(item.operationExpiresAt) ||
        item.operationExpiresAt < 1 || item.operationExpiresAt > Number.MAX_SAFE_INTEGER) contentInvalid();
    request.operationExpiresAt = item.operationExpiresAt;
  }
  return request;
}

function validateContentMessage(value: unknown): ContentMessage {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const kind = (value as Record<string, unknown>).kind;
    if (kind === 'recognize' || kind === 'inspect' || kind === 'gesture') return validateContentRequest(value);
    if (kind === 'session.activate' || kind === 'session.revoke' || kind === 'gesture.commit' ||
        kind === 'gesture.cancel' ||
        kind === 'document.bind') {
      let encoded: string;
      try { encoded = JSON.stringify(value); } catch { contentInvalid(); }
      if (encoded === undefined || new TextEncoder().encode(encoded).length > CONTENT_MAX_MESSAGE_BYTES) contentInvalid();
      const item = value as Record<string, unknown>;
      const base = ['protocolVersion', 'kind', 'controlId', 'profileId', 'connectionGeneration', 'epoch',
        'serviceGeneration', 'origin', 'tabId'];
      contentExact(item, kind === 'gesture.commit' || kind === 'gesture.cancel'
        ? [...base, 'requestId', 'sequence', 'operationId', 'documentId'] :
        kind === 'document.bind' ? [...base, 'lastSequence'] : base);
      if (item.protocolVersion !== 1 || item.origin !== CONTENT_ALLOWED_ORIGIN ||
          typeof item.epoch !== 'string' || !/^[a-f0-9]{64}$/.test(item.epoch)) contentInvalid();
      contentIdentifier(item.controlId); contentIdentifier(item.profileId); contentIdentifier(item.serviceGeneration);
      contentPositive(item.connectionGeneration); contentPositive(item.tabId);
      if (kind === 'gesture.commit' || kind === 'gesture.cancel') {
        contentIdentifier(item.requestId); contentPositive(item.sequence); contentIdentifier(item.operationId);
        contentIdentifier(item.documentId);
      }
      if (kind === 'document.bind' && (!Number.isSafeInteger(item.lastSequence) ||
          (item.lastSequence as number) < 0 || (item.lastSequence as number) >= 1_000_000)) contentInvalid();
      return structuredClone(item) as unknown as ContentMessage;
    }
  }
  contentInvalid();
}

function recognizeContentPage(page: ContentDocument): Record<string, unknown> {
  const declaredState = page.querySelector('[data-behalvo-page-state]')?.dataset.behalvoPageState;
  try { return readContentPage(page); }
  catch (error) {
    if (error instanceof ContentPageContractError) throw error;
    if (declaredState === 'calendar') throw new ContentPageContractError();
    throw error;
  }
}

function readContentPage(page: ContentDocument): Record<string, unknown> {
  const root = page.querySelector('[data-behalvo-page-state]');
  const candidateState = root?.dataset.behalvoPageState;
  const state: ContentPageState = candidateState && contentStates.has(candidateState as ContentPageState)
    ? candidateState as ContentPageState : 'unknown';
  if (state === 'calendar') {
    const candidates = [...page.querySelectorAll('[data-behalvo-slot-id]')].map(element => ({
      ...contentSlot(element), evidenceDigest: contentDigest(element.dataset.behalvoEvidenceDigest) }));
    if (!root) contentInvalid();
    const hasNext = contentBoolean(root.dataset.behalvoHasNext);
    if (Boolean(page.querySelector('[data-behalvo-gesture="calendar.next_page"]')) !== hasNext) contentInvalid();
    return { state, contractVersion: contentVersion(root.dataset.behalvoContractVersion),
      location: contentLiteral(root.dataset.behalvoLocation, 'Beijing'),
      timeZone: contentLiteral(root.dataset.behalvoTimeZone, 'Asia/Shanghai'),
      startDate: contentLiteral(root.dataset.behalvoStartDate, '2026-12-15'),
      endDate: contentLiteral(root.dataset.behalvoEndDate, '2027-01-31'),
      identityDigest: contentDigest(root.dataset.behalvoIdentityDigest),
      subjectDigest: contentDigest(root.dataset.behalvoSubjectDigest),
      rosterDigest: contentDigest(root.dataset.behalvoRosterDigest),
      termsDigest: contentDigest(root.dataset.behalvoTermsDigest),
      termsVersion: contentIdentifier(root.dataset.behalvoTermsVersion),
      appointmentAbsent: contentLiteral(root.dataset.behalvoAppointmentAbsent, 'true', true),
      page: contentPage(root.dataset.behalvoPage),
      hasNext, candidates };
  }
  if (state === 'group_roster') {
    if (!root) contentInvalid();
    return { state, identityDigest: contentDigest(root.dataset.behalvoIdentityDigest),
      subjectDigest: contentDigest(root.dataset.behalvoSubjectDigest),
      rosterDigest: contentDigest(root.dataset.behalvoRosterDigest),
      termsVersion: contentIdentifier(root.dataset.behalvoTermsVersion) };
  }
  if (state === 'booking_review') {
    const reviewSlot = page.querySelector('[data-behalvo-review-slot]');
    if (!reviewSlot) contentInvalid();
    if (!root) contentInvalid();
    return { state, slot: contentSlot(reviewSlot), identityDigest: contentDigest(root.dataset.behalvoIdentityDigest),
      rosterDigest: contentDigest(root.dataset.behalvoRosterDigest),
      termsDigest: contentDigest(root.dataset.behalvoTermsDigest),
      evidenceDigest: contentDigest(root.dataset.behalvoEvidenceDigest),
      appointmentAbsent: contentLiteral(root.dataset.behalvoAppointmentAbsent, 'true', true),
      bookingType: contentLiteral(root.dataset.behalvoBookingType, 'new_group_appointment'),
      timeZone: contentLiteral(root.dataset.behalvoTimeZone, 'Asia/Shanghai') };
  }
  if (state === 'confirmation' || state === 'appointment') {
    if (!root) contentInvalid();
    return { state, ...(state === 'appointment'
      ? { complete: contentLiteral(root.dataset.behalvoComplete, 'true', true) } : {}),
      booking: { referenceDigest: contentDigest(root.dataset.behalvoReferenceDigest),
      status: contentLiteral(root.dataset.behalvoStatus, 'booked'),
      rosterDigest: contentDigest(root.dataset.behalvoRosterDigest),
      date: contentDate(root.dataset.behalvoDate), time: contentTime(root.dataset.behalvoTime),
      location: contentLiteral(root.dataset.behalvoLocation, 'Beijing'),
      timeZone: contentLiteral(root.dataset.behalvoTimeZone, 'Asia/Shanghai') } };
  }
  if (state === 'ambiguous_submission') {
    if (!root) contentInvalid();
    return { state, intentId: contentIdentifier(root.dataset.behalvoIntentId) };
  }
  return { state };
}

function contentSlot(element: ContentElement): Record<string, unknown> {
  return { id: contentIdentifier(element.dataset.behalvoSlotId),
    date: contentDate(element.dataset.behalvoDate), time: contentTime(element.dataset.behalvoTime),
    location: contentLiteral(element.dataset.behalvoLocation, 'Beijing') };
}

function contentLiteral<T extends string | boolean>(value: unknown, expected: string, result?: T): string | T {
  if (value !== expected) contentInvalid();
  return result ?? expected;
}

function contentBoolean(value: unknown): boolean {
  if (value !== 'true' && value !== 'false') contentInvalid();
  return value === 'true';
}

function contentPage(value: unknown): number {
  if (typeof value !== 'string' || !/^[1-9]\d{0,2}$/.test(value)) contentInvalid();
  const page = Number(value);
  if (page > 100) contentInvalid();
  return page;
}

function contentVersion(value: unknown): 1 {
  if (value !== '1') contentInvalid();
  return 1;
}

function contentDigest(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) contentInvalid();
  return value;
}

function contentDate(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) contentInvalid();
  const [year, month, day] = value.split('-').map(Number);
  const parsed = new Date(Date.UTC(year!, month! - 1, day!));
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() + 1 !== month || parsed.getUTCDate() !== day)
    contentInvalid();
  return value;
}

function contentTime(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{2}:\d{2}$/.test(value)) contentInvalid();
  const [hour, minute] = value.split(':').map(Number);
  if (hour! > 23 || minute! > 59) contentInvalid();
  return value;
}

function executeContentGesture(page: ContentDocument, request: ContentRequest, authorize: () => void): void {
  if (request.kind !== 'gesture' || !request.command) contentInvalid();
  if (recognizeContentPage(page).state !== request.expectedPageState) contentInvalid();
  let selector: string;
  let beforeClick: (() => void) | undefined;
  switch (request.command.kind) {
    case 'calendar.first_page': selector = '[data-behalvo-gesture="calendar.first_page"]'; break;
    case 'calendar.next_page': selector = '[data-behalvo-gesture="calendar.next_page"]'; break;
    case 'slot.select': selector = `[data-behalvo-gesture="slot.select"][data-behalvo-slot-id="${request.command.slotId}"]`; break;
    case 'booking.intent': {
      const input = page.querySelector(`[data-behalvo-intent-input="${request.command.slotId}"]`);
      if (!input) contentInvalid();
      const intentId = request.command.intentId;
      beforeClick = () => { input.value = intentId; };
      selector = `[data-behalvo-gesture="booking.intent"][data-behalvo-intent-slot="${request.command.slotId}"]`;
      break;
    }
    case 'booking.submit': selector = `[data-behalvo-gesture="booking.submit"]` +
      `[data-behalvo-slot-id="${request.command.slotId}"]` +
      `[data-behalvo-intent-id="${request.command.intentId}"]`; break;
    case 'appointment.readback': selector = '[data-behalvo-gesture="appointment.readback"]'; break;
  }
  const element = page.querySelector(selector);
  if (!element) contentInvalid();
  authorize();
  beforeClick?.();
  element.click();
}

declare const chrome: undefined | { runtime: { id: string; onMessage: { addListener(callback: (
  value: unknown, sender: { id?: string }, respond: (value: unknown) => void) => boolean): void } } };

if (typeof chrome !== 'undefined' && globalThis.location.origin === CONTENT_ALLOWED_ORIGIN) {
  const documentId = contentIdentifier(globalThis.crypto.randomUUID());
  let active: ContentSessionControl | undefined;
  let lastSequence = 0;
  let pending: { request: ContentRequest; operationId: string; expiresAt: number } | undefined;
  const controls = new Set<string>();
  const retiredBindings = new Set<string>();
  const settledOperations = new Map<string, ContentGestureCommit>();
  chrome.runtime.onMessage.addListener((value, sender, respond) => {
    try {
      if (sender.id !== chrome.runtime.id) contentInvalid();
      const message = validateContentMessage(value);
      if (message.kind === 'session.activate') {
        contentUseControl(controls, message.controlId);
        if (active || pending || retiredBindings.has(contentBindingKey(message))) contentBindingError();
        active = { ...message }; lastSequence = 0;
        respond({ ...message, kind: 'session.activated', documentId }); return false;
      }
      if (message.kind === 'document.bind') {
        contentUseControl(controls, message.controlId);
        if (retiredBindings.has(contentBindingKey(message)) || pending ||
            (active && (!sameContentBinding(active, message) || message.lastSequence !== lastSequence)))
          contentBindingError();
        active = { ...message, kind: 'session.activate' }; lastSequence = message.lastSequence;
        respond({ ...message, kind: 'document.bound', documentId }); return false;
      }
      if (message.kind === 'session.revoke') {
        contentUseControl(controls, message.controlId);
        const key = contentBindingKey(message);
        if (active && !sameContentBinding(active, message)) contentBindingError();
        active = undefined; pending = undefined;
        retireContentBinding(retiredBindings, key);
        respond({ ...message, kind: 'session.revoked', documentId }); return false;
      }
      if (message.kind === 'gesture.cancel') {
        contentUseControl(controls, message.controlId);
        const operation = pending;
        if (!active || message.documentId !== documentId || !sameContentBinding(active, message))
          contentBindingError();
        if (operation && operation.request.requestId === message.requestId &&
            operation.request.sequence === message.sequence && operation.operationId === message.operationId) {
          pending = undefined;
          respond({ ...message, kind: 'gesture.cancelled' }); return false;
        }
        const settled = settledOperations.get(message.operationId);
        if (!settled || settled.requestId !== message.requestId || settled.sequence !== message.sequence ||
            settled.documentId !== message.documentId || !sameContentBinding(active, settled)) contentBindingError();
        respond({ ...message, kind: 'gesture.settled' }); return false;
      }
      if (message.kind === 'gesture.commit') {
        contentUseControl(controls, message.controlId);
        const operation = pending;
        if (!active || message.documentId !== documentId || !operation || !sameContentBinding(active, message) ||
            operation.request.requestId !== message.requestId || operation.request.sequence !== message.sequence ||
            operation.operationId !== message.operationId) contentBindingError();
        const page = document as unknown as ContentDocument;
        try {
          executeContentGesture(page, operation.request, () => {
            if (!active || !sameContentBinding(active, message) || monotonicContentNow() >= operation.expiresAt)
              contentBindingError();
            pending = undefined;
          });
        } catch (error) {
          if (error instanceof ContentPageContractError) pending = undefined;
          throw error;
        }
        settledOperations.set(message.operationId, { ...message });
        if (settledOperations.size > 1_000)
          settledOperations.delete(settledOperations.keys().next().value!);
        respond(recognizeContentPage(page)); return false;
      }
      const request = validateContentRequest(message);
      if (!active || request.documentId !== documentId || !sameContentBinding(active, request) ||
          request.sequence !== lastSequence + 1)
        contentBindingError();
      lastSequence = request.sequence;
      const page = document as unknown as ContentDocument;
      const snapshot = recognizeContentPage(page);
      if (request.kind !== 'recognize' && snapshot.state !== request.expectedPageState) contentInvalid();
      if (request.kind === 'gesture') {
        if (pending) contentBindingError();
        contentRemainingOperationTime(request.operationExpiresAt!);
        pending = { request, operationId: request.operationId!,
          expiresAt: request.operationExpiresAt! };
      }
      respond(snapshot);
    } catch (error) {
      respond(error instanceof ContentPageContractError
        ? { error: 'page_contract_changed' } : { error: 'Browser request was rejected.' });
    }
    return false;
  });
}

function sameContentBinding(left: ContentSessionControl, right: ContentMessage): boolean {
  return left.profileId === right.profileId && left.connectionGeneration === right.connectionGeneration &&
    left.epoch === right.epoch && left.serviceGeneration === right.serviceGeneration &&
    left.origin === right.origin && left.tabId === right.tabId;
}

function contentBindingKey(value: ContentSessionControl | ContentDocumentBind): string {
  return [value.profileId, value.connectionGeneration, value.epoch, value.serviceGeneration,
    value.origin, value.tabId].join('\0');
}

function retireContentBinding(retired: Set<string>, key: string): void {
  retired.add(key);
  if (retired.size > 1_000) retired.delete(retired.values().next().value!);
}

function contentUseControl(controls: Set<string>, controlId: string): void {
  if (controls.has(controlId)) contentBindingError();
  controls.add(controlId);
  if (controls.size > 1_000) controls.delete(controls.values().next().value!);
}

function contentBindingError(): never { throw new Error('Browser message binding or replay is invalid.'); }

function monotonicContentNow(): number { return performance.timeOrigin + performance.now(); }

function contentRemainingOperationTime(expiresAt: number): number {
  const remaining = Math.ceil(expiresAt - monotonicContentNow());
  if (remaining < 1 || remaining > 60_000) contentBindingError();
  return remaining;
}
