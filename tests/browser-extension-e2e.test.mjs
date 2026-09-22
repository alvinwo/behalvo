import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { PassThrough } from 'node:stream';
import { performance } from 'node:perf_hooks';
import { webcrypto } from 'node:crypto';
import { BrowserEpochRegistry, BrowserSession, NativeMessageReader, NativeMessagingTransport,
  SyntheticPortalState, startSyntheticPortal, writeNativeMessage } from '../dist/index.js';
import { createNativeRequestBoundary, dispatchNativePortMessage } from '../extension/dist/background.js';

const extensionId = 'a'.repeat(32);

function loadContent(document) {
  const manifest = JSON.parse(readFileSync(new URL('../extension/manifest.json', import.meta.url), 'utf8'));
  const source = readFileSync(new URL(`../extension/${manifest.content_scripts[0].js[0]}`, import.meta.url), 'utf8');
  let listener;
  new vm.Script(source, { filename: manifest.content_scripts[0].js[0] }).runInContext(vm.createContext({
    TextEncoder, structuredClone, performance, crypto: webcrypto, document,
    location: { origin: 'http://127.0.0.1:43117' },
    chrome: { runtime: { id: extensionId, onMessage: { addListener(value) { listener = value; } } } }
  }));
  return listener;
}

function contentSender(listener) {
  return (tabId, value) => new Promise(resolve => {
    assert.equal(tabId, 7);
    listener(value, { id: extensionId }, resolve);
  });
}

function fence() {
  return { serviceGeneration: 'service-e2e', deadline: Date.now() + 10_000,
    signal: new AbortController().signal, async assertCurrent() {} };
}

async function inspectCompiledVisaPage(rootDataset, slotDataset) {
  const document = { querySelector(selector) {
    if (selector === '[data-behalvo-page-state]') return { dataset: rootDataset };
    if (selector === '[data-behalvo-review-slot]' && slotDataset) return { dataset: slotDataset };
    return null;
  }, querySelectorAll() { return []; } };
  const boundary = createNativeRequestBoundary(contentSender(loadContent(document)));
  const binding = { protocolVersion: 1, profileId: 'profile-visa-dom', connectionGeneration: 1,
    epoch: 'a'.repeat(64), serviceGeneration: 'service-e2e', origin: 'http://127.0.0.1:43117', tabId: 7 };
  await boundary({ ...binding, kind: 'session.activate', controlId: 'activate-visa-dom' });
  return boundary({ ...binding, kind: 'inspect', requestId: 'inspect-visa-dom', sequence: 1,
    expectedPageState: rootDataset.behalvoPageState });
}

test('manifest content rejects contradictory visa review and booking evidence instead of synthesizing it', async () => {
  const digest = value => value.repeat(64);
  const validReview = { behalvoPageState: 'booking_review', behalvoIdentityDigest: digest('1'),
    behalvoRosterDigest: digest('2'), behalvoTermsDigest: digest('3'), behalvoEvidenceDigest: digest('4'),
    behalvoAppointmentAbsent: 'true', behalvoBookingType: 'new_group_appointment',
    behalvoTimeZone: 'Asia/Shanghai' };
  const validSlot = { behalvoSlotId: 'slot-2027-01-04-0900', behalvoDate: '2027-01-04',
    behalvoTime: '09:00', behalvoLocation: 'Beijing' };
  for (const [field, value] of [['behalvoAppointmentAbsent', 'false'], ['behalvoBookingType', 'reschedule'],
    ['behalvoTimeZone', 'UTC']])
    await assert.rejects(inspectCompiledVisaPage({ ...validReview, [field]: value }, validSlot), /invalid|rejected/i);
  await assert.rejects(inspectCompiledVisaPage(validReview,
    { ...validSlot, behalvoLocation: 'Shanghai' }), /invalid|rejected/i);
  for (const field of ['behalvoAppointmentAbsent', 'behalvoBookingType', 'behalvoTimeZone']) {
    const missing = { ...validReview }; delete missing[field];
    await assert.rejects(inspectCompiledVisaPage(missing, validSlot), /invalid|rejected/i);
  }

  const validBooking = { behalvoPageState: 'confirmation', behalvoReferenceDigest: digest('5'),
    behalvoRosterDigest: digest('2'), behalvoDate: '2027-01-04', behalvoTime: '09:00',
    behalvoStatus: 'booked', behalvoLocation: 'Beijing', behalvoTimeZone: 'Asia/Shanghai' };
  for (const [field, value] of [['behalvoStatus', 'pending'], ['behalvoLocation', 'Shanghai'],
    ['behalvoTimeZone', 'UTC']])
    await assert.rejects(inspectCompiledVisaPage({ ...validBooking, [field]: value }), /invalid|rejected/i);
  for (const field of ['behalvoStatus', 'behalvoLocation', 'behalvoTimeZone']) {
    const missing = { ...validBooking }; delete missing[field];
    await assert.rejects(inspectCompiledVisaPage(missing), /invalid|rejected/i);
  }
  await assert.rejects(inspectCompiledVisaPage({ ...validBooking, behalvoPageState: 'appointment',
    behalvoComplete: 'true', behalvoStatus: 'pending' }), /invalid|rejected/i);
});

test('framed native, background, and compiled content path revokes a delayed gesture before completed handoff', async () => {
  let clicks = 0;
  const root = { dataset: { behalvoPageState: 'calendar', behalvoPage: '1', behalvoHasNext: 'true' }, click() {} };
  const next = { dataset: { behalvoGesture: 'calendar.next_page' }, click() { clicks++; } };
  const document = { querySelector(selector) {
    if (selector === '[data-behalvo-page-state]') return root;
    if (selector === '[data-behalvo-gesture="calendar.next_page"]') return next;
    return null;
  }, querySelectorAll() { return []; } };
  const boundary = createNativeRequestBoundary(contentSender(loadContent(document)));
  const fromExtension = new PassThrough(); const toExtension = new PassThrough();
  const transport = new NativeMessagingTransport(fromExtension, toExtension);
  const reader = new NativeMessageReader(toExtension);
  const session = new BrowserSession({ profileId: 'profile-e2e', connectionGeneration: 1,
    serviceGeneration: 'service-e2e', allowedOrigin: 'http://127.0.0.1:43117', tabId: 7,
    identityDigest: 'a'.repeat(64), subjectDigest: 'b'.repeat(64), termsVersion: 'terms-1',
    registry: new BrowserEpochRegistry(), transport, persistence: {
      async pauseForHuman() {}, async releaseWorker() {}, async recoverHandoff() {},
      async resumePreflight() { throw new Error('resume must not run'); }
    } });
  const gesture = session.gesture({ kind: 'calendar.next_page' }, 'calendar', fence());
  void gesture.catch(() => {});
  const activate = await reader.read();
  await writeNativeMessage(fromExtension, await boundary(activate));
  const delayedGesture = await reader.read();
  const handoff = session.transferToHuman('challenge');
  await new Promise(resolve => setImmediate(resolve));
  const revoke = await reader.read();
  await writeNativeMessage(fromExtension, await boundary(delayedGesture));
  await writeNativeMessage(fromExtension, await boundary(revoke));
  await handoff;
  await assert.rejects(gesture, /not current/i);
  assert.equal(clicks, 0);
  await session.shutdown();
});

test('compiled content rejects a framed commit after its trusted operation deadline', async () => {
  let clicks = 0;
  const root = { dataset: { behalvoPageState: 'calendar', behalvoPage: '1', behalvoHasNext: 'true' }, click() {} };
  const next = { dataset: {}, click() { clicks++; } };
  const document = { querySelector(selector) {
    if (selector === '[data-behalvo-page-state]') return root;
    if (selector === '[data-behalvo-gesture="calendar.next_page"]') return next;
    return null;
  }, querySelectorAll() { return []; } };
  const boundary = createNativeRequestBoundary(contentSender(loadContent(document)));
  const fromExtension = new PassThrough(); const toExtension = new PassThrough();
  const transport = new NativeMessagingTransport(fromExtension, toExtension);
  const reader = new NativeMessageReader(toExtension);
  const session = new BrowserSession({ profileId: 'profile-expiry', connectionGeneration: 1,
    serviceGeneration: 'service-e2e', allowedOrigin: 'http://127.0.0.1:43117', tabId: 7,
    identityDigest: 'a'.repeat(64), subjectDigest: 'b'.repeat(64), termsVersion: 'terms-1',
    registry: new BrowserEpochRegistry(), transport, persistence: {
      async pauseForHuman() {}, async releaseWorker() {}, async recoverHandoff() {},
      async resumePreflight() { throw new Error('resume must not run'); }
    } });
  const controller = new AbortController();
  const gesture = session.gesture({ kind: 'calendar.next_page' }, 'calendar', {
    serviceGeneration: 'service-e2e', deadline: Date.now() + 100, signal: controller.signal,
    async assertCurrent() {}
  });
  void gesture.catch(() => {});
  const activate = await reader.read();
  await writeNativeMessage(fromExtension, await boundary(activate));
  const prepare = await reader.read();
  await writeNativeMessage(fromExtension, await boundary(prepare));
  const commit = await reader.read();
  await new Promise(resolve => setTimeout(resolve, 120));
  let outcome = 'rejected';
  try {
    await writeNativeMessage(fromExtension, await boundary(commit));
    outcome = 'accepted';
  } catch { /* fixed rejection is expected */ }
  await transport.close();
  await assert.rejects(gesture, /deadline|stopped|closed|framing/i);
  assert.equal(outcome, 'rejected');
  assert.equal(clicks, 0);
  await assert.rejects(session.shutdown(), /closed/i);
});

test('an expired compiled intent commit leaves no late intent value or gesture', async () => {
  const slotId = 'slot-expired-intent'; const intentId = 'intent-expired-before-commit';
  const input = { dataset: { behalvoIntentInput: slotId }, value: '', click() {} };
  let clicks = 0;
  const document = { querySelector(selector) {
    if (selector === '[data-behalvo-page-state]') return { dataset: {
      behalvoPageState: 'calendar', behalvoPage: '1', behalvoHasNext: 'false' } };
    if (selector === `[data-behalvo-intent-input="${slotId}"]`) return input;
    if (selector === `[data-behalvo-gesture="booking.intent"][data-behalvo-intent-slot="${slotId}"]`)
      return { dataset: {}, click() { clicks++; } };
    return null;
  }, querySelectorAll(selector) { return selector === '[data-behalvo-slot-id]' ? [{ dataset: {
    behalvoSlotId: slotId, behalvoDate: '2027-01-04', behalvoTime: '09:00', behalvoLocation: 'Beijing'
  }, click() {} }] : []; } };
  const send = contentSender(loadContent(document));
  const binding = { protocolVersion: 1, profileId: 'profile-expired-intent', connectionGeneration: 1,
    epoch: 'b'.repeat(64), serviceGeneration: 'service-e2e', origin: 'http://127.0.0.1:43117', tabId: 7 };
  const activated = await send(7, { ...binding, kind: 'session.activate', controlId: 'activate-expired-intent' });
  const request = { ...binding, kind: 'gesture', requestId: 'gesture-expired-intent',
    documentId: activated.documentId, sequence: 1, expectedPageState: 'calendar',
    command: { kind: 'booking.intent', slotId, intentId }, operationId: 'operation-expired-intent',
    operationExpiresAt: performance.timeOrigin + performance.now() + 10 };
  assert.equal((await send(7, request)).state, 'calendar');
  await new Promise(resolve => setTimeout(resolve, 20));
  const committed = await send(7, { ...binding, kind: 'gesture.commit', controlId: 'commit-expired-intent',
    documentId: activated.documentId, requestId: request.requestId, sequence: request.sequence,
    operationId: request.operationId });
  assert.equal(committed.error, 'Browser request was rejected.');
  assert.equal(input.value, '');
  assert.equal(clicks, 0);
});

test('abort is acknowledged in compiled content before a delayed framed commit', async () => {
  let clicks = 0;
  const root = { dataset: { behalvoPageState: 'calendar', behalvoPage: '1', behalvoHasNext: 'true' }, click() {} };
  const document = { querySelector(selector) {
    if (selector === '[data-behalvo-page-state]') return root;
    if (selector === '[data-behalvo-gesture="calendar.next_page"]') return { dataset: {}, click() { clicks++; } };
    return null;
  }, querySelectorAll() { return []; } };
  const boundary = createNativeRequestBoundary(contentSender(loadContent(document)));
  const fromExtension = new PassThrough(); const toExtension = new PassThrough();
  const transport = new NativeMessagingTransport(fromExtension, toExtension, 32 * 1024, 200);
  const reader = new NativeMessageReader(toExtension);
  const session = new BrowserSession({ profileId: 'profile-abort', connectionGeneration: 1,
    serviceGeneration: 'service-e2e', allowedOrigin: 'http://127.0.0.1:43117', tabId: 7,
    identityDigest: 'a'.repeat(64), subjectDigest: 'b'.repeat(64), termsVersion: 'terms-1',
    registry: new BrowserEpochRegistry(), transport, persistence: {
      async pauseForHuman() {}, async releaseWorker() {}, async recoverHandoff() {},
      async resumePreflight() { throw new Error('resume must not run'); }
    } });
  const controller = new AbortController();
  const gesture = session.gesture({ kind: 'calendar.next_page' }, 'calendar', {
    serviceGeneration: 'service-e2e', deadline: Date.now() + 10_000, signal: controller.signal,
    async assertCurrent() {}
  });
  void gesture.catch(() => {});
  const activate = await reader.read();
  await writeNativeMessage(fromExtension, await boundary(activate));
  const prepare = await reader.read();
  await writeNativeMessage(fromExtension, await boundary(prepare));
  const commit = await reader.read();
  const nextFrame = reader.read();
  controller.abort();
  const cancellation = await Promise.race([
    nextFrame,
    new Promise(resolve => setTimeout(() => resolve(undefined), 40))
  ]);
  let lateCommit = 'not-delivered';
  if (cancellation) {
    await writeNativeMessage(fromExtension, await boundary(cancellation));
    try { await boundary(commit); lateCommit = 'accepted'; } catch { lateCommit = 'rejected'; }
  }
  await transport.close();
  await assert.rejects(gesture, /cancel|stopped|closed|framing/i);
  await assert.rejects(session.shutdown(), /closed/i);
  assert.equal(cancellation?.kind, 'gesture.cancel');
  assert.equal(lateCommit, 'rejected');
  assert.equal(clicks, 0);
});

test('original deadline and cancellation overtake a commit held between background and content', async () => {
  const state = new SyntheticPortalState({ scenario: 'booking_review' });
  const slotId = 'slot-2027-01-04-0900'; const intentId = 'synthetic-intent';
  let bookingMutations = 0;
  const document = { querySelector(selector) {
    const snapshot = state.inspect();
    if (selector === '[data-behalvo-page-state]') {
      if (snapshot.state === 'booking_review') return { dataset: { behalvoPageState: 'booking_review',
        behalvoIdentityDigest: snapshot.identityDigest, behalvoRosterDigest: snapshot.rosterDigest,
        behalvoTermsDigest: snapshot.termsDigest, behalvoEvidenceDigest: snapshot.evidenceDigest,
        behalvoAppointmentAbsent: 'true', behalvoBookingType: snapshot.bookingType,
        behalvoTimeZone: snapshot.timeZone } };
      if (snapshot.state === 'confirmation') return { dataset: { behalvoPageState: 'confirmation',
        behalvoReferenceDigest: snapshot.booking.referenceDigest,
        behalvoRosterDigest: snapshot.booking.rosterDigest, behalvoDate: snapshot.booking.date,
        behalvoTime: snapshot.booking.time, behalvoStatus: snapshot.booking.status,
        behalvoLocation: snapshot.booking.location,
        behalvoTimeZone: snapshot.booking.timeZone } };
    }
    if (selector === '[data-behalvo-review-slot]') return { dataset: {
      behalvoSlotId: slotId, behalvoDate: '2027-01-04', behalvoTime: '09:00',
      behalvoLocation: 'Beijing' } };
    if (selector === '[data-behalvo-gesture="booking.submit"]' +
        `[data-behalvo-slot-id="${slotId}"][data-behalvo-intent-id="${intentId}"]`) return {
      dataset: {}, click() { bookingMutations++; state.gesture({ kind: 'booking.submit', slotId, intentId }); }
    };
    return null;
  }, querySelectorAll() { return []; } };
  const listener = loadContent(document);
  const direct = contentSender(listener);
  let releaseCommit;
  const boundary = createNativeRequestBoundary(async (tabId, value) => {
    if (value.kind === 'gesture') {
      await new Promise(resolve => setTimeout(resolve, 80));
      return direct(tabId, value);
    }
    if (value.kind === 'gesture.commit') return new Promise((resolve, reject) => {
      releaseCommit = () => direct(tabId, value).then(resolve, reject);
    });
    return direct(tabId, value);
  });
  const fromExtension = new PassThrough(); const toExtension = new PassThrough();
  const transport = new NativeMessagingTransport(fromExtension, toExtension, 32 * 1024, 500);
  const reader = new NativeMessageReader(toExtension);
  const session = new BrowserSession({ profileId: 'profile-in-flight-expiry', connectionGeneration: 1,
    serviceGeneration: 'service-e2e', allowedOrigin: 'http://127.0.0.1:43117', tabId: 7,
    identityDigest: 'a'.repeat(64), subjectDigest: 'b'.repeat(64), termsVersion: 'terms-1',
    registry: new BrowserEpochRegistry(), transport, persistence: {
      async pauseForHuman() {}, async releaseWorker() {}, async recoverHandoff() {},
      async resumePreflight() { throw new Error('resume must not run'); }
    } });
  const controller = new AbortController(); const deadline = Date.now() + 180;
  const gesture = session.gesture({ kind: 'booking.submit', slotId, intentId }, 'booking_review', {
    serviceGeneration: 'service-e2e', deadline, signal: controller.signal, async assertCurrent() {}
  });
  void gesture.catch(() => {});
  const activate = await reader.read();
  await writeNativeMessage(fromExtension, await boundary(activate));
  const prepare = await reader.read();
  await writeNativeMessage(fromExtension, await boundary(prepare));
  const commit = await reader.read();
  let disconnects = 0; const posted = []; const postWrites = [];
  const port = { postMessage(value) { posted.push(value);
    postWrites.push(writeNativeMessage(fromExtension, value)); }, disconnect() { disconnects++; } };
  const heldCommit = dispatchNativePortMessage(boundary, port, commit);
  await new Promise(resolve => setTimeout(resolve, Math.max(0, deadline - Date.now() + 25)));
  const cancellation = await reader.read();
  assert.equal(cancellation.kind, 'gesture.cancel');
  const cancelled = await boundary(cancellation);
  assert.equal(cancelled.kind, 'gesture.cancelled');
  await writeNativeMessage(fromExtension, cancelled);
  releaseCommit();
  await heldCommit;
  await assert.rejects(gesture, /deadline|cancel|stopped/i);
  assert.equal(bookingMutations, 0);
  assert.equal(state.inspect().state, 'booking_review');
  assert.equal(disconnects, 0);
  assert.deepEqual(posted, []);
  const shutdown = session.shutdown();
  const revoke = await reader.read();
  await dispatchNativePortMessage(boundary, port, revoke);
  await Promise.all(postWrites);
  await shutdown;
  assert.equal(posted.at(-1)?.kind, 'session.revoked');
  assert.equal(disconnects, 0);
});

test('acknowledged revoke settles a held commit before the same native channel resumes', async () => {
  let clicks = 0; let releaseCommit;
  const listener = loadContent({ querySelector(selector) {
    if (selector === '[data-behalvo-page-state]') return { dataset: {
      behalvoPageState: 'calendar', behalvoPage: '1', behalvoHasNext: 'true' } };
    if (selector === '[data-behalvo-gesture="calendar.next_page"]')
      return { dataset: {}, click() { clicks++; } };
    return null;
  }, querySelectorAll() { return []; } });
  const direct = contentSender(listener);
  const boundary = createNativeRequestBoundary(async (tabId, value) => {
    if (value.kind === 'gesture.commit') return new Promise((resolve, reject) => {
      releaseCommit = () => direct(tabId, value).then(resolve, reject);
    });
    return direct(tabId, value);
  });
  const fromExtension = new PassThrough(); const toExtension = new PassThrough();
  const transport = new NativeMessagingTransport(fromExtension, toExtension, 32 * 1024, 500);
  const reader = new NativeMessageReader(toExtension);
  const session = new BrowserSession({ profileId: 'profile-revoke-in-flight', connectionGeneration: 1,
    serviceGeneration: 'service-e2e', allowedOrigin: 'http://127.0.0.1:43117', tabId: 7,
    identityDigest: 'a'.repeat(64), subjectDigest: 'b'.repeat(64), termsVersion: 'terms-1',
    registry: new BrowserEpochRegistry(), transport, persistence: {
      async pauseForHuman() {}, async releaseWorker() {}, async recoverHandoff() {},
      async resumePreflight() { return { profileId: 'profile-revoke-in-flight', connectionGeneration: 1,
        identityDigest: 'a'.repeat(64), subjectDigest: 'b'.repeat(64), termsVersion: 'terms-1',
        appointmentAbsent: true }; }
    } });
  const gesture = session.gesture({ kind: 'calendar.next_page' }, 'calendar', fence());
  void gesture.catch(() => {});
  const activate = await reader.read();
  await writeNativeMessage(fromExtension, await boundary(activate));
  const prepare = await reader.read();
  await writeNativeMessage(fromExtension, await boundary(prepare));
  const commit = await reader.read();
  let disconnects = 0; const posted = []; const postWrites = [];
  const port = { postMessage(value) { posted.push(value);
    postWrites.push(writeNativeMessage(fromExtension, value)); }, disconnect() { disconnects++; } };
  const heldCommit = dispatchNativePortMessage(boundary, port, commit);
  const handoff = session.transferToHuman('challenge');
  const revoke = await reader.read();
  await dispatchNativePortMessage(boundary, port, revoke);
  await Promise.all(postWrites);
  await handoff;
  releaseCommit();
  await heldCommit;
  await assert.rejects(Promise.race([gesture, new Promise((_, reject) => setTimeout(
    () => reject(new Error('Gesture did not settle after acknowledged revoke.')), 50))]), /not current|cancel/i);
  assert.equal(clicks, 0);
  assert.equal(disconnects, 0);

  await session.resume();
  const inspection = session.inspect('calendar', fence());
  const reactivate = await reader.read();
  await dispatchNativePortMessage(boundary, port, reactivate);
  const inspect = await reader.read();
  await dispatchNativePortMessage(boundary, port, inspect);
  await Promise.all(postWrites);
  assert.deepEqual(await inspection, { state: 'calendar', page: 1, hasNext: true, candidates: [] });

  const shutdown = session.shutdown();
  const finalRevoke = await reader.read();
  await dispatchNativePortMessage(boundary, port, finalRevoke);
  await Promise.all(postWrites);
  await shutdown;
  assert.equal(posted.filter(value => value.kind === 'session.revoked').length, 2);
  assert.equal(disconnects, 0);
});

for (const acknowledgement of ['cancelled', 'failed', 'malformed', 'timeout', 'settled']) {
  test(`framed commit coordinates a held ${acknowledgement} cancellation acknowledgement`, async t => {
    // Break caught: classifying a commit reply before the concurrent cancellation
    // has a validated outcome disconnects a safely cancelled native channel.
    const state = new SyntheticPortalState({ scenario: 'calendar_match' });
    const slotId = 'slot-2027-01-04-0900'; const intentId = 'held-cancel-intent';
    state.gesture({ kind: 'calendar.next_page' });
    state.recordDurableIntent(intentId, slotId);
    state.gesture({ kind: 'slot.select', slotId });
    let clicks = 0;
    const direct = contentSender(loadContent({ querySelector(selector) {
      const snapshot = state.inspect();
      if (selector === '[data-behalvo-page-state]') return { dataset: snapshot.state === 'booking_review'
        ? { behalvoPageState: 'booking_review', behalvoIdentityDigest: snapshot.identityDigest,
          behalvoRosterDigest: snapshot.rosterDigest, behalvoTermsDigest: snapshot.termsDigest,
          behalvoEvidenceDigest: snapshot.evidenceDigest, behalvoAppointmentAbsent: 'true',
          behalvoBookingType: snapshot.bookingType, behalvoTimeZone: snapshot.timeZone }
        : { behalvoPageState: 'confirmation', behalvoReferenceDigest: snapshot.booking.referenceDigest,
          behalvoRosterDigest: snapshot.booking.rosterDigest, behalvoDate: snapshot.booking.date,
          behalvoTime: snapshot.booking.time, behalvoStatus: snapshot.booking.status,
          behalvoLocation: snapshot.booking.location,
          behalvoTimeZone: snapshot.booking.timeZone } };
      if (selector === '[data-behalvo-review-slot]') return { dataset: {
        behalvoSlotId: slotId, behalvoDate: '2027-01-04', behalvoTime: '09:00',
        behalvoLocation: 'Beijing' } };
      if (selector === '[data-behalvo-gesture="booking.submit"]' +
          `[data-behalvo-slot-id="${slotId}"][data-behalvo-intent-id="${intentId}"]`) return {
        dataset: {}, click() { clicks++; state.gesture({ kind: 'booking.submit', slotId, intentId }); }
      };
      return null;
    }, querySelectorAll() { return []; } }));
    const commitDelivery = Promise.withResolvers();
    const commitApplied = Promise.withResolvers();
    const cancellationApplied = Promise.withResolvers();
    const cancelAcknowledgement = Promise.withResolvers();
    const boundary = createNativeRequestBoundary(async (tabId, value) => {
      if (value.kind === 'gesture.commit') {
        if (acknowledgement !== 'settled') await commitDelivery.promise;
        const response = await direct(tabId, value);
        commitApplied.resolve(response);
        if (acknowledgement === 'settled') await commitDelivery.promise;
        return response;
      }
      if (value.kind === 'gesture.cancel') {
        cancellationApplied.resolve(await direct(tabId, value));
        return cancelAcknowledgement.promise;
      }
      return direct(tabId, value);
    });
    const fromExtension = new PassThrough(); const toExtension = new PassThrough();
    const transport = new NativeMessagingTransport(fromExtension, toExtension, 32 * 1024,
      acknowledgement === 'timeout' ? 100 : 1_000);
    t.after(() => transport.close());
    const reader = new NativeMessageReader(toExtension);
    const profileId = `profile-held-cancel-${acknowledgement}`;
    const session = new BrowserSession({ profileId, connectionGeneration: 1,
      serviceGeneration: 'service-e2e', allowedOrigin: 'http://127.0.0.1:43117', tabId: 7,
      identityDigest: 'a'.repeat(64), subjectDigest: 'b'.repeat(64), termsVersion: 'terms-1',
      registry: new BrowserEpochRegistry(), transport, persistence: {
        async pauseForHuman() {}, async releaseWorker() {}, async recoverHandoff() {},
        async resumePreflight() { return { profileId, connectionGeneration: 1,
          identityDigest: 'a'.repeat(64), subjectDigest: 'b'.repeat(64), termsVersion: 'terms-1',
          appointmentAbsent: true }; }
      } });
    let disconnects = 0; const posted = []; const postWrites = [];
    const port = { postMessage(value) {
      if (fromExtension.writableEnded) throw new Error('Synthetic native port is disconnected.');
      posted.push(value); postWrites.push(writeNativeMessage(fromExtension, value));
    }, disconnect() { disconnects++; fromExtension.end(); } };
    const dispatch = value => dispatchNativePortMessage(boundary, port, value);
    const controller = new AbortController();
    let settlements = 0;
    const gesture = session.gesture({ kind: 'booking.submit', slotId, intentId }, 'booking_review', {
      ...fence(), signal: controller.signal
    }).then(value => { settlements++; return { value }; }, error => { settlements++; return { error }; });
    await dispatch(await reader.read()); // activate
    await dispatch(await reader.read()); // prepare
    const commit = await reader.read();
    let commitFinished = false;
    const pendingCommit = dispatch(commit).then(() => { commitFinished = true; });
    if (acknowledgement === 'settled') await commitApplied.promise;
    controller.abort();
    const cancellation = await reader.read();
    assert.equal(cancellation.kind, 'gesture.cancel');
    const pendingCancel = dispatch(cancellation);
    const cancelled = await cancellationApplied.promise;
    assert.equal(cancelled.kind, acknowledgement === 'settled' ? 'gesture.settled' : 'gesture.cancelled');
    commitDelivery.resolve();
    const contentResult = await commitApplied.promise;
    if (acknowledgement !== 'settled') assert.equal(contentResult.error, 'Browser request was rejected.');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(disconnects, 0, 'commit must await the cancellation outcome before classification');
    assert.equal(commitFinished, false);
    assert.equal(settlements, 0);

    if (acknowledgement === 'timeout') {
      assert.match((await gesture).error.message, /timed out/i);
      cancelAcknowledgement.resolve(cancelled);
    } else if (acknowledgement === 'failed') {
      cancelAcknowledgement.reject(new Error('Synthetic cancellation delivery failed.'));
    } else if (acknowledgement === 'malformed') {
      cancelAcknowledgement.resolve({ ...cancelled, operationId: 'wrong-operation' });
    } else cancelAcknowledgement.resolve(cancelled);
    await Promise.all([pendingCancel, pendingCommit, ...postWrites]);
    const outcome = await gesture;
    assert.equal(settlements, 1);
    assert.equal(clicks, acknowledgement === 'settled' ? 1 : 0);
    assert.equal(state.mutationCount, acknowledgement === 'settled' ? 1 : 0);
    assert.equal(state.inspect().state, acknowledgement === 'settled' ? 'confirmation' : 'booking_review');
    if (['failed', 'malformed', 'timeout'].includes(acknowledgement)) {
      assert.match(outcome.error.message, /framing|timed out/i);
      if (acknowledgement !== 'timeout') assert.ok(disconnects > 0, 'unconfirmed cancellation remains fatal');
      await assert.rejects(session.inspect('booking_review', fence()), /unavailable/i);
      return;
    }
    assert.match(outcome.error.message, /cancel|stopped/i);
    assert.equal(disconnects, 0);
    assert.equal(posted.filter(value => value.kind === cancelled.kind).length, 1);
    assert.equal(posted.filter(value => value.kind === 'result' && value.requestId === commit.requestId).length,
      acknowledgement === 'settled' ? 1 : 0);
    // Same transport remains usable before and after a fresh human-handoff epoch.
    const expectedState = acknowledgement === 'settled' ? 'confirmation' : 'booking_review';
    const inspection = session.inspect(expectedState, fence());
    await dispatch(await reader.read());
    assert.equal((await inspection).state, expectedState);
    const handoff = session.transferToHuman('challenge');
    await dispatch(await reader.read());
    await handoff;
    if (acknowledgement === 'cancelled') {
      await session.resume();
      const resumedInspection = session.inspect('booking_review', fence());
      await dispatch(await reader.read()); // new activation
      await dispatch(await reader.read()); // inspect
      assert.equal((await resumedInspection).state, 'booking_review');
      const shutdown = session.shutdown();
      await dispatch(await reader.read());
      await shutdown;
    } else await session.shutdown();
    await Promise.all(postWrites);
    assert.equal(settlements, 1);
    assert.equal(disconnects, 0);
  });
}

test('compiled content preserves one absolute expiry across delayed prepare delivery', async () => {
  let clicks = 0; let releaseCommit;
  const listener = loadContent({ querySelector(selector) {
    if (selector === '[data-behalvo-page-state]') return { dataset: {
      behalvoPageState: 'calendar', behalvoPage: '1', behalvoHasNext: 'true' } };
    if (selector === '[data-behalvo-gesture="calendar.next_page"]')
      return { dataset: {}, click() { clicks++; } };
    return null;
  }, querySelectorAll() { return []; } });
  const direct = contentSender(listener);
  const boundary = createNativeRequestBoundary(async (tabId, value) => {
    if (value.kind === 'gesture') {
      await new Promise(resolve => setTimeout(resolve, 70));
      return direct(tabId, value);
    }
    if (value.kind === 'gesture.commit') return new Promise((resolve, reject) => {
      releaseCommit = () => direct(tabId, value).then(resolve, reject);
    });
    return direct(tabId, value);
  });
  const control = { protocolVersion: 1, profileId: 'profile-absolute-expiry', connectionGeneration: 1,
    epoch: 'a'.repeat(64), serviceGeneration: 'service-e2e', origin: 'http://127.0.0.1:43117', tabId: 7 };
  await boundary({ ...control, kind: 'session.activate', controlId: 'activate-absolute-expiry' });
  const expiresAt = performance.timeOrigin + performance.now() + 130;
  const request = { ...control, kind: 'gesture', requestId: 'gesture-absolute-expiry', sequence: 1,
    expectedPageState: 'calendar', command: { kind: 'calendar.next_page' },
    operationId: 'operation-absolute-expiry', operationExpiresAt: expiresAt };
  await boundary(request);
  const commit = boundary({ ...control, kind: 'gesture.commit', controlId: 'commit-absolute-expiry',
    requestId: request.requestId, sequence: request.sequence, operationId: request.operationId });
  void commit.catch(() => {});
  await new Promise(resolve => setTimeout(resolve,
    Math.max(0, expiresAt - (performance.timeOrigin + performance.now()) + 15)));
  releaseCommit();
  await assert.rejects(commit, /protocol|binding|replay/i);
  assert.equal(clicks, 0);
});

test('compiled content commits the exact form rendered by the loopback portal', async t => {
  const state = new SyntheticPortalState({ scenario: 'calendar_match' });
  const server = await startSyntheticPortal({ state, port: 0 });
  t.after(() => server.close());
  const html = await (await fetch(`${server.origin}/`)).text();
  assert.match(html, /<form method="post" action="\/gesture">/);
  let submitted;
  const root = { dataset: { behalvoPageState: 'calendar', behalvoPage: '1', behalvoHasNext: 'true' }, click() {} };
  const next = { dataset: { behalvoGesture: 'calendar.next_page' }, click() {
    submitted = fetch(`${server.origin}/gesture`, { method: 'POST', redirect: 'manual',
      headers: { origin: server.origin, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ kind: 'calendar.next_page' }) });
  } };
  const document = { querySelector(selector) {
    if (selector === '[data-behalvo-page-state]') return root;
    if (selector === '[data-behalvo-gesture="calendar.next_page"]' &&
        html.includes('data-behalvo-gesture="calendar.next_page"')) return next;
    return null;
  }, querySelectorAll() { return []; } };
  const boundary = createNativeRequestBoundary(contentSender(loadContent(document)));
  const binding = { protocolVersion: 1, profileId: 'profile-http', connectionGeneration: 1,
    epoch: 'a'.repeat(64), serviceGeneration: 'service-http', origin: 'http://127.0.0.1:43117', tabId: 7 };
  await boundary({ ...binding, kind: 'session.activate', controlId: 'activate-http' });
  const request = { ...binding, kind: 'gesture', requestId: 'gesture-http', sequence: 1,
    expectedPageState: 'calendar', command: { kind: 'calendar.next_page' },
    operationId: 'operation-http', operationExpiresAt: performance.timeOrigin + performance.now() + 10_000 };
  assert.equal((await boundary(request)).kind, 'gesture.prepared');
  await boundary({ ...binding, kind: 'gesture.commit', controlId: 'commit-http',
    requestId: request.requestId, sequence: request.sequence, operationId: request.operationId });
  assert.equal((await submitted).status, 303);
  assert.deepEqual(state.inspect(), { state: 'calendar', page: 2, hasNext: false,
    candidates: [{ id: 'slot-2027-01-04-0900', date: '2027-01-04', time: '09:00', location: 'Beijing' }] });

  const slotId = 'slot-2027-01-04-0900'; const intentId = 'journaled-intent';
  const intentHtml = await (await fetch(`${server.origin}/`)).text();
  assert.match(intentHtml, /data-behalvo-gesture="booking\.intent"/);
  const intentInput = { dataset: { behalvoIntentInput: slotId }, value: '', click() {} };
  let installed;
  const intentButton = { dataset: { behalvoGesture: 'booking.intent', behalvoIntentSlot: slotId }, click() {
    installed = fetch(`${server.origin}/gesture`, { method: 'POST', redirect: 'manual',
      headers: { origin: server.origin, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ kind: 'booking.intent', slotId, intentId: intentInput.value }) });
  } };
  const candidate = { dataset: { behalvoSlotId: slotId, behalvoDate: '2027-01-04',
    behalvoTime: '09:00', behalvoLocation: 'Beijing' }, click() {} };
  const intentDocument = { querySelector(selector) {
    if (selector === '[data-behalvo-page-state]') return { dataset: {
      behalvoPageState: 'calendar', behalvoPage: '2', behalvoHasNext: 'false' } };
    if (selector === `[data-behalvo-intent-input="${slotId}"]`) return intentInput;
    if (selector === `[data-behalvo-gesture="booking.intent"][data-behalvo-intent-slot="${slotId}"]`)
      return intentButton;
    return null;
  }, querySelectorAll(selector) { return selector === '[data-behalvo-slot-id]' ? [candidate] : []; } };
  const intentBoundary = createNativeRequestBoundary(contentSender(loadContent(intentDocument)));
  await intentBoundary({ ...binding, kind: 'session.activate', controlId: 'activate-http-intent' });
  const intentRequest = { ...binding, kind: 'gesture', requestId: 'gesture-http-intent', sequence: 1,
    expectedPageState: 'calendar', command: { kind: 'booking.intent', slotId, intentId },
    operationId: 'operation-http-intent', operationExpiresAt: performance.timeOrigin + performance.now() + 10_000 };
  assert.equal((await intentBoundary(intentRequest)).kind, 'gesture.prepared');
  await intentBoundary({ ...binding, kind: 'gesture.commit', controlId: 'commit-http-intent',
    requestId: intentRequest.requestId, sequence: intentRequest.sequence, operationId: intentRequest.operationId });
  assert.equal((await installed).status, 303);
  assert.deepEqual(state.exportDurableState().durableIntent, { intentId, slotId });
});
