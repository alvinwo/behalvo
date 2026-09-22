import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { performance } from 'node:perf_hooks';
import { webcrypto } from 'node:crypto';
import {
  BROWSER_PROTOCOL_VERSION, MAX_BROWSER_MESSAGE_BYTES,
  parseBrowserRequest, parseBrowserResponse
} from '../dist/index.js';
import { createBackgroundBoundary, createNativeRequestBoundary } from '../extension/dist/background.js';
import { validateExtensionRequest, validateExtensionResponse,
  validateExtensionSnapshot } from '../extension/dist/protocol.js';

const binding = {
  protocolVersion: BROWSER_PROTOCOL_VERSION,
  requestId: 'request-1', profileId: 'profile-a', connectionGeneration: 3,
  epoch: 'a'.repeat(64), serviceGeneration: 'service-a',
  origin: 'http://127.0.0.1:43117', tabId: 7, sequence: 1
};

function operationExpiry(milliseconds = 10_000) {
  return performance.timeOrigin + performance.now() + milliseconds;
}

function loadContentArtifact(document) {
  const manifest = JSON.parse(readFileSync(new URL('../extension/manifest.json', import.meta.url), 'utf8'));
  const source = readFileSync(new URL(`../extension/${manifest.content_scripts[0].js[0]}`, import.meta.url), 'utf8');
  let listener;
  const context = vm.createContext({
    TextEncoder, structuredClone, performance, crypto: webcrypto, document,
    location: { origin: 'http://127.0.0.1:43117' },
    chrome: { runtime: { id: 'a'.repeat(32), onMessage: { addListener(value) { listener = value; } } } }
  });
  const script = new vm.Script(source, { filename: manifest.content_scripts[0].js[0] });
  script.runInContext(context);
  return listener;
}

test('browser protocol accepts only exact typed inspect and allowlisted gesture messages', () => {
  assert.deepEqual(parseBrowserRequest({ ...binding, kind: 'recognize' }),
    { ...binding, kind: 'recognize' });
  assert.deepEqual(parseBrowserRequest({ ...binding, kind: 'inspect', expectedPageState: 'calendar' }),
    { ...binding, kind: 'inspect', expectedPageState: 'calendar' });
  assert.deepEqual(parseBrowserRequest({ ...binding, kind: 'gesture', expectedPageState: 'calendar',
    command: { kind: 'calendar.next_page' } }),
    { ...binding, kind: 'gesture', expectedPageState: 'calendar', command: { kind: 'calendar.next_page' } });
  assert.deepEqual(parseBrowserRequest({ ...binding, kind: 'gesture', expectedPageState: 'calendar',
    command: { kind: 'booking.intent', slotId: 'slot-a', intentId: 'intent-a' } }),
    { ...binding, kind: 'gesture', expectedPageState: 'calendar',
      command: { kind: 'booking.intent', slotId: 'slot-a', intentId: 'intent-a' } });

  for (const invalid of [
    { ...binding, kind: 'inspect', expectedPageState: 'calendar', extra: true },
    { ...binding, kind: 'recognize', expectedPageState: 'calendar' },
    { ...binding, kind: 'recognize', command: { kind: 'appointment.readback' } },
    { ...binding, protocolVersion: 2, kind: 'inspect', expectedPageState: 'calendar' },
    { ...binding, origin: 'https://example.test', kind: 'inspect', expectedPageState: 'calendar' },
    { ...binding, kind: 'gesture', expectedPageState: 'calendar', command: { kind: 'script.evaluate', source: 'click()' } },
    { ...binding, kind: 'gesture', expectedPageState: 'calendar', command: { kind: 'navigate', url: 'https://example.test' } },
    { ...binding, kind: 'gesture', expectedPageState: 'calendar', command: { kind: 'cookies.export' } },
    { ...binding, kind: 'gesture', expectedPageState: 'login', command: { kind: 'calendar.next_page' } }
    , { ...binding, kind: 'gesture', expectedPageState: 'calendar', command: { kind: 'appointment.readback' } }
    , { ...binding, kind: 'gesture', expectedPageState: 'booking_review',
      command: { kind: 'booking.intent', slotId: 'slot-a', intentId: 'intent-a' } }
  ]) assert.throws(() => parseBrowserRequest(invalid), /browser protocol/i);
});

test('browser responses are exact, bounded, bound to page state, and exclude sensitive readback', () => {
  const valid = { ...binding, kind: 'result', pageState: 'calendar', snapshot: {
    state: 'calendar', page: 1, hasNext: false,
    candidates: [{ id: 'slot-a', date: '2027-01-04', time: '09:00', location: 'Beijing' }]
  } };
  assert.deepEqual(parseBrowserResponse(valid), valid);

  for (const invalid of [
    { ...valid, pageState: 'login' },
    { ...valid, snapshot: { ...valid.snapshot, password: 'secret' } },
    { ...valid, snapshot: { ...valid.snapshot, html: '<main>raw</main>' } },
    { ...valid, snapshot: { ...valid.snapshot, cookies: ['session=x'] } },
    { ...valid, unknown: true },
    { ...valid, snapshot: { ...valid.snapshot, candidates: [
      { id: 'slot-a', date: '2027-02-30', time: '09:00', location: 'Beijing' }
    ] } },
    { ...valid, snapshot: { ...valid.snapshot, candidates: [
      { id: 'slot-a', date: '2027-01-04', time: '29:99', location: 'Beijing' }
    ] } }
  ]) assert.throws(() => parseBrowserResponse(invalid), /browser protocol/i);

  assert.throws(() => parseBrowserRequest({ ...binding, kind: 'inspect', expectedPageState: 'calendar',
    requestId: 'x'.repeat(MAX_BROWSER_MESSAGE_BYTES) }), /size|browser protocol/i);
});

test('extension background independently validates sender and exact native response', async () => {
  const request = { ...binding, kind: 'inspect', expectedPageState: 'calendar' };
  const snapshot = { state: 'calendar', page: 1, hasNext: false, candidates: [] };
  const validResponse = { ...binding, kind: 'result', pageState: 'calendar', snapshot };
  const sender = { origin: binding.origin, tab: { id: binding.tabId, url: `${binding.origin}/calendar` } };
  const boundary = createBackgroundBoundary(async () => validResponse);
  assert.deepEqual(await boundary(request, sender), validResponse);
  await assert.rejects(boundary(request, { ...sender, origin: 'https://example.test' }), /sender binding/i);
  await assert.rejects(boundary(request, { ...sender, tab: { ...sender.tab, id: 8 } }), /sender binding/i);
  const unsafe = createBackgroundBoundary(async () => ({ ...validResponse, snapshot: { ...snapshot, cookies: ['x'] } }));
  await assert.rejects(unsafe(request, sender), /browser protocol/i);
  const unknownSnapshot = createBackgroundBoundary(async () => ({ ...validResponse,
    snapshot: { ...snapshot, unexpected: true } }));
  await assert.rejects(unknownSnapshot(request, sender), /browser protocol/i);
  await assert.rejects(boundary({ ...request, expectedPageState: 'invented' }, sender), /browser protocol/i);
});

test('extension background forwards an exact native request to its bound content tab and wraps the typed result', async () => {
  const request = { ...binding, kind: 'inspect', expectedPageState: 'calendar' };
  const snapshot = { state: 'calendar', page: 1, hasNext: false, candidates: [] };
  let target;
  const boundary = createNativeRequestBoundary(async (tabId, value) => {
    target = [tabId, value];
    if (value.kind === 'session.activate') return { ...value, kind: 'session.activated', documentId: 'document-a' };
    if (value.kind === 'document.bind') return { ...value, kind: 'document.bound', documentId: 'document-a' };
    return snapshot;
  });
  const control = { protocolVersion: 1, kind: 'session.activate', controlId: 'activate-forward',
    profileId: binding.profileId, connectionGeneration: binding.connectionGeneration, epoch: binding.epoch,
    serviceGeneration: binding.serviceGeneration, origin: binding.origin, tabId: binding.tabId };
  await boundary(control);
  assert.deepEqual(await boundary(request), { ...binding, kind: 'result', pageState: 'calendar', snapshot });
  assert.deepEqual(target, [binding.tabId, { ...request, documentId: 'document-a' }]);
});

test('extension background rejects a wrong-version document binding acknowledgement', async () => {
  const boundary = createNativeRequestBoundary(async (_tabId, value) => {
    if (value.kind === 'session.activate')
      return { ...value, kind: 'session.activated', documentId: 'document-version' };
    if (value.kind === 'document.bind')
      return { ...value, protocolVersion: 2, kind: 'document.bound', documentId: 'document-version' };
    return { state: 'calendar', page: 1, hasNext: false, candidates: [] };
  });
  const control = { protocolVersion: 1, kind: 'session.activate', controlId: 'activate-version',
    profileId: binding.profileId, connectionGeneration: binding.connectionGeneration, epoch: binding.epoch,
    serviceGeneration: binding.serviceGeneration, origin: binding.origin, tabId: binding.tabId };
  await boundary(control);
  await assert.rejects(boundary({ ...binding, kind: 'inspect', expectedPageState: 'calendar' }),
    /binding or replay/i);
});

test('extension protocol rejects empty, nonpositive, and unbounded binding values before dispatch', () => {
  const request = { ...binding, kind: 'inspect', expectedPageState: 'calendar' };
  for (const invalid of [
    { ...request, requestId: '' }, { ...request, profileId: '' },
    { ...request, serviceGeneration: '' }, { ...request, connectionGeneration: 0 },
    { ...request, tabId: 0 }, { ...request, sequence: 0 }
  ]) assert.throws(() => validateExtensionRequest(invalid), /browser protocol/i);
  const response = { ...binding, kind: 'result', pageState: 'calendar',
    snapshot: { state: 'calendar', page: 1, hasNext: false, candidates: [] } };
  assert.throws(() => validateExtensionResponse({ ...response, profileId: '' }), /browser protocol/i);
});

test('compiled content boundary recognizes adapter fields and clicks one fixed allowlisted target', async () => {
  let clicks = 0;
  const root = { dataset: { behalvoPageState: 'calendar', behalvoPage: '2', behalvoHasNext: 'false' }, click() {} };
  const slot = { dataset: { behalvoSlotId: 'slot-a', behalvoDate: '2027-01-04', behalvoTime: '09:00',
    behalvoLocation: 'Beijing' }, click() { clicks++; } };
  const document = {
    querySelector(selector) {
      if (selector === '[data-behalvo-page-state]') return root;
      if (selector === '[data-behalvo-gesture="slot.select"][data-behalvo-slot-id="slot-a"]') return slot;
      return null;
    },
    querySelectorAll(selector) { return selector === '[data-behalvo-slot-id]' ? [slot] : []; }
  };
  const listener = loadContentArtifact(document);
  const send = value => new Promise(resolve => listener(value, { id: 'a'.repeat(32) }, resolve));
  const control = { protocolVersion: 1, controlId: 'control-content', profileId: binding.profileId,
    connectionGeneration: binding.connectionGeneration, epoch: binding.epoch,
    serviceGeneration: binding.serviceGeneration, origin: binding.origin, tabId: binding.tabId };
  const activated = await send({ ...control, kind: 'session.activate' });
  const request = { ...binding, kind: 'gesture', expectedPageState: 'calendar',
    command: { kind: 'slot.select', slotId: 'slot-a' }, documentId: activated.documentId,
    operationId: 'operation-slot-a', operationExpiresAt: operationExpiry() };
  const snapshot = await send(request);
  assert.deepEqual(structuredClone(snapshot), { state: 'calendar', page: 2, hasNext: false,
    candidates: [{ id: 'slot-a', date: '2027-01-04', time: '09:00', location: 'Beijing' }] });
  assert.equal(clicks, 0);
  await send({ ...control, controlId: 'control-commit', kind: 'gesture.commit',
    requestId: request.requestId, sequence: request.sequence, operationId: request.operationId,
    documentId: activated.documentId });
  assert.equal(clicks, 1);
});

test('compiled content submits only the exact reviewed slot and durable intent', async () => {
  let wrongClicks = 0; let exactClicks = 0;
  const reviewSlot = { dataset: { behalvoSlotId: 'slot-a', behalvoDate: '2027-01-04',
    behalvoTime: '09:00', behalvoLocation: 'Beijing' }, click() {} };
  const wrongSubmit = { dataset: {}, click() { wrongClicks++; } };
  const exactSubmit = { dataset: {}, click() { exactClicks++; } };
  const exactSelector = '[data-behalvo-gesture="booking.submit"]' +
    '[data-behalvo-slot-id="slot-a"][data-behalvo-intent-id="intent-a"]';
  const document = {
    querySelector(selector) {
      if (selector === '[data-behalvo-page-state]') return { dataset: { behalvoPageState: 'booking_review',
        behalvoIdentityDigest: 'a'.repeat(64), behalvoRosterDigest: 'c'.repeat(64),
        behalvoTermsDigest: 'b'.repeat(64), behalvoEvidenceDigest: 'd'.repeat(64),
        behalvoAppointmentAbsent: 'true', behalvoBookingType: 'new_group_appointment',
        behalvoTimeZone: 'Asia/Shanghai' } };
      if (selector === '[data-behalvo-review-slot]') return reviewSlot;
      if (selector === exactSelector) return exactSubmit;
      if (selector === '[data-behalvo-gesture="booking.submit"]') return wrongSubmit;
      return null;
    },
    querySelectorAll() { return []; }
  };
  const listener = loadContentArtifact(document);
  const send = value => new Promise(resolve => listener(value, { id: 'a'.repeat(32) }, resolve));
  const control = { protocolVersion: 1, controlId: 'control-submit', profileId: binding.profileId,
    connectionGeneration: binding.connectionGeneration, epoch: binding.epoch,
    serviceGeneration: binding.serviceGeneration, origin: binding.origin, tabId: binding.tabId };
  const activated = await send({ ...control, kind: 'session.activate' });
  const request = { ...binding, kind: 'gesture', expectedPageState: 'booking_review',
    command: { kind: 'booking.submit', slotId: 'slot-a', intentId: 'intent-a' },
    documentId: activated.documentId, operationId: 'operation-submit-a', operationExpiresAt: operationExpiry() };
  assert.equal((await send(request)).state, 'booking_review');
  await send({ ...control, controlId: 'control-submit-commit', kind: 'gesture.commit',
    requestId: request.requestId, sequence: request.sequence, operationId: request.operationId,
    documentId: activated.documentId });
  assert.equal(wrongClicks, 0);
  assert.equal(exactClicks, 1);
});

test('manifest content artifact parses and installs as a classic script', () => {
  const listener = loadContentArtifact({ querySelector() { return null; }, querySelectorAll() { return []; } });
  assert.equal(typeof listener, 'function');
});

test('actual background and compiled content bind one epoch and revoke a prepared gesture before click', async () => {
  let clicks = 0;
  const root = { dataset: { behalvoPageState: 'calendar', behalvoPage: '1', behalvoHasNext: 'true' }, click() {} };
  const next = { dataset: {}, click() { clicks++; } };
  const document = {
    querySelector(selector) {
      if (selector === '[data-behalvo-page-state]') return root;
      if (selector === '[data-behalvo-gesture="calendar.next_page"]') return next;
      return null;
    },
    querySelectorAll() { return []; }
  };
  const listener = loadContentArtifact(document);
  const sendContent = (tabId, value) => new Promise(resolve => {
    assert.equal(tabId, binding.tabId);
    listener(value, { id: 'a'.repeat(32) }, resolve);
  });
  const boundary = createNativeRequestBoundary(sendContent);
  const control = { protocolVersion: 1, controlId: 'control-1', profileId: binding.profileId,
    connectionGeneration: binding.connectionGeneration, epoch: binding.epoch,
    serviceGeneration: binding.serviceGeneration, origin: binding.origin, tabId: binding.tabId };
  assert.equal((await boundary({ ...control, kind: 'session.activate' })).kind, 'session.activated');
  const inspect = { ...binding, kind: 'inspect', expectedPageState: 'calendar' };
  assert.equal((await boundary(inspect)).kind, 'result');
  await assert.rejects(boundary(inspect), /binding or replay/i);
  await assert.rejects(boundary({ ...inspect, requestId: 'request-foreign', profileId: 'profile-b', sequence: 2 }),
    /binding or replay/i);
  const gesture = { ...binding, requestId: 'request-2', sequence: 2, kind: 'gesture',
    expectedPageState: 'calendar', command: { kind: 'calendar.next_page' },
    operationId: 'operation-revoke-a', operationExpiresAt: operationExpiry() };
  assert.equal((await boundary(gesture)).kind, 'gesture.prepared');
  assert.equal(clicks, 0);
  const revocation = { ...control, controlId: 'control-2', kind: 'session.revoke' };
  assert.equal((await boundary(revocation)).kind, 'session.revoked');
  const duplicateRevocation = { ...revocation, controlId: 'control-duplicate-revoke' };
  assert.deepEqual(structuredClone(await sendContent(binding.tabId, duplicateRevocation)),
    { error: 'Browser request was rejected.' });
  await assert.rejects(boundary(duplicateRevocation), /binding or replay/i);
  await assert.rejects(boundary({ ...control, controlId: 'control-3', kind: 'gesture.commit',
    requestId: gesture.requestId, sequence: gesture.sequence, operationId: gesture.operationId }),
  /binding or replay/i);
  assert.equal(clicks, 0);
});

test('compiled content recognizes every advertised typed page snapshot', async () => {
  const digestA = 'a'.repeat(64); const digestB = 'b'.repeat(64); const digestC = 'c'.repeat(64);
  const slot = { dataset: { behalvoSlotId: 'slot-a', behalvoDate: '2027-01-04',
    behalvoTime: '09:00', behalvoLocation: 'Beijing' }, click() {} };
  const cases = [
    [{ behalvoPageState: 'group_roster', behalvoIdentityDigest: digestA, behalvoSubjectDigest: digestB,
      behalvoRosterDigest: digestC, behalvoTermsVersion: 'terms-1' }, null,
    { state: 'group_roster', identityDigest: digestA, subjectDigest: digestB,
      rosterDigest: digestC, termsVersion: 'terms-1' }],
    [{ behalvoPageState: 'booking_review', behalvoIdentityDigest: digestA, behalvoRosterDigest: digestC,
      behalvoTermsDigest: digestB, behalvoEvidenceDigest: digestA, behalvoAppointmentAbsent: 'true',
      behalvoBookingType: 'new_group_appointment', behalvoTimeZone: 'Asia/Shanghai' }, slot,
      { state: 'booking_review', slot: { id: 'slot-a', date: '2027-01-04', time: '09:00', location: 'Beijing' },
        identityDigest: digestA, rosterDigest: digestC, termsDigest: digestB, evidenceDigest: digestA,
        appointmentAbsent: true, bookingType: 'new_group_appointment', timeZone: 'Asia/Shanghai' }],
    [{ behalvoPageState: 'confirmation', behalvoReferenceDigest: digestA, behalvoRosterDigest: digestC,
      behalvoDate: '2027-01-04', behalvoTime: '09:00', behalvoStatus: 'booked',
      behalvoLocation: 'Beijing', behalvoTimeZone: 'Asia/Shanghai' }, null,
    { state: 'confirmation', booking: { referenceDigest: digestA, status: 'booked', rosterDigest: digestC,
      date: '2027-01-04', time: '09:00', location: 'Beijing', timeZone: 'Asia/Shanghai' } }],
    [{ behalvoPageState: 'ambiguous_submission', behalvoIntentId: 'intent-a' }, null,
      { state: 'ambiguous_submission', intentId: 'intent-a' }],
    [{ behalvoPageState: 'appointment', behalvoReferenceDigest: digestA, behalvoRosterDigest: digestC,
      behalvoDate: '2027-01-04', behalvoTime: '09:00', behalvoStatus: 'booked',
      behalvoLocation: 'Beijing', behalvoTimeZone: 'Asia/Shanghai', behalvoComplete: 'true' }, null,
    { state: 'appointment', complete: true, booking: { referenceDigest: digestA, status: 'booked', rosterDigest: digestC,
      date: '2027-01-04', time: '09:00', location: 'Beijing', timeZone: 'Asia/Shanghai' } }]
  ];
  for (const [dataset, reviewSlot, expected] of cases) {
    const root = { dataset, click() {} };
    const document = { querySelector(selector) {
      if (selector === '[data-behalvo-page-state]') return root;
      if (selector === '[data-behalvo-review-slot]') return reviewSlot;
      return null;
    }, querySelectorAll() { return []; } };
    const listener = loadContentArtifact(document);
    const send = value => new Promise(resolve => listener(value, { id: 'a'.repeat(32) }, resolve));
    const control = { protocolVersion: 1, kind: 'session.activate', controlId: `activate-${dataset.behalvoPageState}`,
      profileId: binding.profileId, connectionGeneration: binding.connectionGeneration, epoch: binding.epoch,
      serviceGeneration: binding.serviceGeneration, origin: binding.origin, tabId: binding.tabId };
    const activated = await send(control);
    const snapshot = await send({ ...binding, requestId: `inspect-${dataset.behalvoPageState}`,
      kind: 'inspect', expectedPageState: dataset.behalvoPageState, documentId: activated.documentId });
    assert.deepEqual(structuredClone(validateExtensionSnapshot(snapshot)), expected);
  }
});

test('background rebinds an exact sequence baseline when navigation installs a fresh content document', async () => {
  const page = number => {
    const root = { dataset: { behalvoPageState: 'calendar', behalvoPage: String(number),
      behalvoHasNext: 'false' }, click() {} };
    return { querySelector(selector) { return selector === '[data-behalvo-page-state]' ? root : null; },
      querySelectorAll() { return []; } };
  };
  let listener = loadContentArtifact(page(1));
  const boundary = createNativeRequestBoundary((tabId, value) => new Promise(resolve => {
    assert.equal(tabId, binding.tabId); listener(value, { id: 'a'.repeat(32) }, resolve);
  }));
  const control = { protocolVersion: 1, kind: 'session.activate', controlId: 'activate-navigation',
    profileId: binding.profileId, connectionGeneration: binding.connectionGeneration, epoch: binding.epoch,
    serviceGeneration: binding.serviceGeneration, origin: binding.origin, tabId: binding.tabId };
  await boundary(control);
  assert.equal((await boundary({ ...binding, kind: 'inspect', expectedPageState: 'calendar' })).snapshot.page, 1);
  listener = loadContentArtifact(page(2));
  const second = { ...binding, requestId: 'request-navigation-2', sequence: 2,
    kind: 'inspect', expectedPageState: 'calendar' };
  assert.equal((await boundary(second)).snapshot.page, 2);
  await assert.rejects(boundary({ ...second, requestId: 'request-navigation-replay', sequence: 1 }),
    /binding or replay/i);
});

test('background revocation invalidates an operation suspended while binding its document', async () => {
  let releaseBind; let gestureDispatches = 0;
  const snapshot = { state: 'calendar', page: 1, hasNext: true, candidates: [] };
  const boundary = createNativeRequestBoundary(async (_tabId, value) => {
    if (value.kind === 'session.activate') return { ...value, kind: 'session.activated', documentId: 'document-held' };
    if (value.kind === 'session.revoke') return { ...value, kind: 'session.revoked', documentId: 'document-held' };
    if (value.kind === 'document.bind') return new Promise(resolve => {
      releaseBind = () => resolve({ ...value, kind: 'document.bound', documentId: 'document-held' });
    });
    gestureDispatches++; return snapshot;
  });
  const control = { protocolVersion: 1, profileId: binding.profileId,
    connectionGeneration: binding.connectionGeneration, epoch: binding.epoch,
    serviceGeneration: binding.serviceGeneration, origin: binding.origin, tabId: binding.tabId };
  await boundary({ ...control, kind: 'session.activate', controlId: 'activate-held-bind' });
  const gesture = boundary({ ...binding, kind: 'gesture', expectedPageState: 'calendar',
    command: { kind: 'calendar.next_page' }, operationId: 'operation-delayed-bind',
    operationExpiresAt: operationExpiry() });
  void gesture.catch(() => {});
  await new Promise(resolve => setImmediate(resolve));
  await boundary({ ...control, kind: 'session.revoke', controlId: 'revoke-held-bind' });
  releaseBind();
  await assert.rejects(gesture, /binding|replay|superseded/i);
  assert.equal(gestureDispatches, 0);
});

test('background acknowledges cancellation while a gesture is suspended binding its document', async () => {
  let releaseBind; let gestureDispatches = 0;
  const boundary = createNativeRequestBoundary(async (_tabId, value) => {
    if (value.kind === 'session.activate')
      return { ...value, kind: 'session.activated', documentId: 'document-cancel-bind' };
    if (value.kind === 'session.revoke')
      return { ...value, kind: 'session.revoked', documentId: 'document-cancel-bind' };
    if (value.kind === 'document.bind') return new Promise(resolve => {
      releaseBind = () => resolve({ ...value, kind: 'document.bound', documentId: 'document-cancel-bind' });
    });
    gestureDispatches++; return { state: 'calendar', page: 1, hasNext: true, candidates: [] };
  });
  const control = { protocolVersion: 1, profileId: binding.profileId,
    connectionGeneration: binding.connectionGeneration, epoch: binding.epoch,
    serviceGeneration: binding.serviceGeneration, origin: binding.origin, tabId: binding.tabId };
  await boundary({ ...control, kind: 'session.activate', controlId: 'activate-cancel-bind' });
  const gestureMessage = { ...binding, kind: 'gesture', expectedPageState: 'calendar',
    command: { kind: 'calendar.next_page' }, operationId: 'operation-cancel-bind',
    operationExpiresAt: operationExpiry() };
  const gesture = boundary(gestureMessage);
  void gesture.catch(() => {});
  await new Promise(resolve => setImmediate(resolve));
  const cancellation = { ...control, kind: 'gesture.cancel', controlId: 'cancel-held-bind',
    requestId: gestureMessage.requestId, sequence: gestureMessage.sequence,
    operationId: gestureMessage.operationId };
  assert.deepEqual(await boundary(cancellation), { ...cancellation, kind: 'gesture.cancelled' });
  releaseBind();
  await assert.rejects(gesture, /binding|replay|superseded/i);
  assert.equal(gestureDispatches, 0);
});

test('background reports settled when cancellation follows forwarded mutation and a late acknowledgement', async () => {
  let clicks = 0; let releaseAcknowledgement; let forwardedResolve;
  const forwarded = new Promise(resolve => { forwardedResolve = resolve; });
  const listener = loadContentArtifact({ querySelector(selector) {
    if (selector === '[data-behalvo-page-state]') return { dataset: {
      behalvoPageState: 'calendar', behalvoPage: '1', behalvoHasNext: 'true' } };
    if (selector === '[data-behalvo-gesture="calendar.next_page"]')
      return { dataset: {}, click() { clicks++; } };
    return null;
  }, querySelectorAll() { return []; } });
  const direct = value => new Promise(resolve => listener(value, { id: 'a'.repeat(32) }, resolve));
  const boundary = createNativeRequestBoundary(async (_tabId, value) => {
    if (value.kind !== 'gesture.commit') return direct(value);
    const response = await direct(value); forwardedResolve();
    return new Promise(resolve => { releaseAcknowledgement = () => resolve(response); });
  });
  const control = { protocolVersion: 1, profileId: binding.profileId,
    connectionGeneration: binding.connectionGeneration, epoch: binding.epoch,
    serviceGeneration: binding.serviceGeneration, origin: binding.origin, tabId: binding.tabId };
  await boundary({ ...control, kind: 'session.activate', controlId: 'activate-forwarded-cancel' });
  const gesture = { ...binding, kind: 'gesture', expectedPageState: 'calendar',
    command: { kind: 'calendar.next_page' }, operationId: 'operation-forwarded-cancel',
    operationExpiresAt: operationExpiry() };
  await boundary(gesture);
  const commit = boundary({ ...control, kind: 'gesture.commit', controlId: 'commit-forwarded-cancel',
    requestId: gesture.requestId, sequence: gesture.sequence, operationId: gesture.operationId });
  await forwarded;
  const cancellation = { ...control, kind: 'gesture.cancel', controlId: 'cancel-after-forward',
    requestId: gesture.requestId, sequence: gesture.sequence, operationId: gesture.operationId };
  assert.equal((await boundary(cancellation)).kind, 'gesture.settled');
  releaseAcknowledgement();
  assert.equal((await commit).kind, 'result');
  assert.equal((await boundary({ ...cancellation, controlId: 'cancel-after-late-ack' })).kind, 'gesture.settled');
  assert.equal(clicks, 1);
});

test('compiled fresh document acknowledges current epoch revocation before any rebind', async () => {
  const page = () => ({ querySelector(selector) {
    return selector === '[data-behalvo-page-state]'
      ? { dataset: { behalvoPageState: 'calendar', behalvoPage: '1', behalvoHasNext: 'false' } }
      : null;
  }, querySelectorAll() { return []; } });
  let listener = loadContentArtifact(page());
  const boundary = createNativeRequestBoundary((tabId, value) => new Promise(resolve => {
    assert.equal(tabId, binding.tabId); listener(value, { id: 'a'.repeat(32) }, resolve);
  }));
  const control = { protocolVersion: 1, profileId: binding.profileId,
    connectionGeneration: binding.connectionGeneration, epoch: binding.epoch,
    serviceGeneration: binding.serviceGeneration, origin: binding.origin, tabId: binding.tabId };
  await boundary({ ...control, kind: 'session.activate', controlId: 'activate-before-navigation' });
  listener = loadContentArtifact(page());
  assert.equal((await boundary({ ...control, kind: 'session.revoke', controlId: 'revoke-fresh-document' })).kind,
    'session.revoked');
});

test('compiled content never revives a revoked epoch from a delayed document bind', async () => {
  const root = { dataset: { behalvoPageState: 'calendar', behalvoPage: '1', behalvoHasNext: 'true' } };
  const listener = loadContentArtifact({ querySelector(selector) {
    if (selector === '[data-behalvo-page-state]') return root;
    if (selector === '[data-behalvo-gesture="calendar.next_page"]') return { dataset: {}, click() {} };
    return null;
  }, querySelectorAll() { return []; } });
  let releaseBind;
  const direct = value => new Promise(resolve => listener(value, { id: 'a'.repeat(32) }, resolve));
  const boundary = createNativeRequestBoundary((_tabId, value) => {
    if (value.kind === 'document.bind') return new Promise(resolve => {
      releaseBind = async () => resolve(await direct(value));
    });
    return direct(value);
  });
  const control = { protocolVersion: 1, profileId: binding.profileId,
    connectionGeneration: binding.connectionGeneration, epoch: binding.epoch,
    serviceGeneration: binding.serviceGeneration, origin: binding.origin, tabId: binding.tabId };
  await boundary({ ...control, kind: 'session.activate', controlId: 'activate-delayed-bind' });
  const gesture = boundary({ ...binding, kind: 'gesture', expectedPageState: 'calendar',
    command: { kind: 'calendar.next_page' }, operationId: 'operation-delayed-bind',
    operationExpiresAt: operationExpiry() });
  void gesture.catch(() => {});
  await new Promise(resolve => setImmediate(resolve));
  await boundary({ ...control, kind: 'session.revoke', controlId: 'revoke-delayed-bind' });
  await releaseBind();
  await assert.rejects(gesture, /binding|protocol|replay|superseded/i);
  const fresh = { ...control, epoch: 'b'.repeat(64), controlId: 'activate-after-delayed-bind',
    kind: 'session.activate' };
  assert.equal((await boundary(fresh)).kind, 'session.activated');
});

test('background retires a delayed bind delivered to a replacement document after revoke', async () => {
  const page = () => ({ querySelector(selector) {
    return selector === '[data-behalvo-page-state]'
      ? { dataset: { behalvoPageState: 'calendar', behalvoPage: '1', behalvoHasNext: 'false' } }
      : null;
  }, querySelectorAll() { return []; } });
  let listener = loadContentArtifact(page()); let releaseBind;
  const direct = value => new Promise(resolve => listener(value, { id: 'a'.repeat(32) }, resolve));
  const boundary = createNativeRequestBoundary((_tabId, value) => {
    if (value.kind === 'document.bind') return new Promise(resolve => {
      releaseBind = async () => resolve(await direct(value));
    });
    return direct(value);
  });
  const control = { protocolVersion: 1, profileId: binding.profileId,
    connectionGeneration: binding.connectionGeneration, epoch: binding.epoch,
    serviceGeneration: binding.serviceGeneration, origin: binding.origin, tabId: binding.tabId };
  await boundary({ ...control, kind: 'session.activate', controlId: 'activate-before-replacement' });
  const request = boundary({ ...binding, kind: 'inspect', expectedPageState: 'calendar' });
  void request.catch(() => {});
  await new Promise(resolve => setImmediate(resolve));
  await boundary({ ...control, kind: 'session.revoke', controlId: 'revoke-before-replacement' });
  listener = loadContentArtifact(page());
  await releaseBind();
  await assert.rejects(request, /binding|replay|superseded/i);
  const fresh = { ...control, epoch: 'b'.repeat(64), kind: 'session.activate',
    controlId: 'activate-after-replacement-bind' };
  assert.equal((await boundary(fresh)).kind, 'session.activated');
});
