import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BrowserEpochRegistry, BrowserSession, MonitoringRegistry, MonitoringService, OperationRegistry,
  OperationService, Operator, ServiceRuntime, SqliteStore, SyntheticPortalState,
  createSyntheticUsVisaChinaExecutionAdapter
} from '../dist/index.js';

const workspaceId = 'visa-runtime';
const ownerId = 'owner';
const now = '2026-09-21T12:00:00.000Z';
const hash = value => createHash('sha256').update(value).digest('hex');
const identityDigest = hash('synthetic-owner');
const subjectDigest = hash('synthetic-account');
const rosterDigest = hash('synthetic-group-roster');
const termsDigest = hash('synthetic-terms');
const evidenceDigest = hash('synthetic-slot-evidence');
const candidate = { id: 'slot-2027-01-04-0900', date: '2027-01-04', time: '09:00', location: 'Beijing',
  timeZone: 'Asia/Shanghai', rosterDigest, evidenceDigest };

function response(request, snapshot) {
  return { protocolVersion: 1, kind: 'result', requestId: request.requestId,
    profileId: request.profileId, connectionGeneration: request.connectionGeneration, epoch: request.epoch,
    serviceGeneration: request.serviceGeneration, origin: request.origin, tabId: request.tabId,
    sequence: request.sequence, pageState: snapshot.state, snapshot };
}

function session(portal, options = {}) {
  let submits = 0;
  const browser = new BrowserSession({ profileId: 'profile-visa', connectionGeneration: 1,
    serviceGeneration: 'service-visa', allowedOrigin: 'http://127.0.0.1:43117', tabId: 7,
    identityDigest, subjectDigest, termsVersion: 'terms-1', registry: new BrowserEpochRegistry(),
    persistence: { async pauseForHuman() {}, async releaseWorker() {}, async recoverHandoff() {},
      async resumePreflight() { return { profileId: 'profile-visa', connectionGeneration: 1,
        identityDigest, subjectDigest, termsVersion: 'terms-1', appointmentAbsent: true }; } },
    transport: { async inspect(request) {
      options.requests?.push(structuredClone(request));
      const snapshot = portal.inspect();
      if (options.enforceExpectedState && request.kind !== 'recognize' && snapshot.state !== request.expectedPageState)
        throw new Error('Synthetic browser page state changed.');
      return response(request, snapshot);
    },
      async gesture(request, authorize) {
        options.requests?.push(structuredClone(request));
        if (options.enforceExpectedState && portal.inspect().state !== request.expectedPageState)
          throw new Error('Synthetic browser page state changed.');
        if (request.command.kind === 'slot.select' && options.selectGate) await options.selectGate.promise;
        if (request.command.kind === 'appointment.readback' && options.readbackGate)
          await options.readbackGate.promise;
        const final = await authorize(); final();
        if (request.command.kind === 'booking.submit') {
          submits++;
          const snapshot = portal.gesture(request.command);
          if (options.throwAfterSubmit) throw new Error('RAW_PROVIDER_SECRET');
          return response(request, snapshot);
        }
        const snapshot = portal.gesture(request.command);
        if (request.command.kind === 'slot.select' && options.afterSelect) await options.afterSelect();
        if (request.command.kind === 'slot.select' && options.throwBeforeSubmit) throw new Error('transport stopped');
        if (request.command.kind === 'appointment.readback' && options.throwAfterConfirmation)
          throw new Error('RAW_READBACK_SECRET');
        return response(request, snapshot);
      }, async revoke() {}, async close() {} }
  });
  return { browser, submits: () => submits };
}

function build(path, key, portal, options = {}) {
  const store = new SqliteStore(path, { encryptionKey: key, serviceQueue: { upgradeExisting: false } });
  if (!options.existing) {
    store.createWorkspace(workspaceId, ownerId);
    new Operator(store, () => now).createWork(workspaceId, ownerId,
      { id: 'work', title: 'Visa', goal: 'Book exact group appointment', threadId: 'thread' });
    store.append(workspaceId, store.state(workspaceId).version, [{ type: 'connection.registered', data: { connection: {
      id: 'connection-visa', provider: 'visa-scheduling', subject: 'synthetic-account', label: 'Synthetic visa',
      generation: 1, status: 'active' } } }], { recordedAt: now });
  }
  const browserFixture = session(portal, options);
  const registry = new MonitoringRegistry();
  registry.register(createSyntheticUsVisaChinaExecutionAdapter({ session: browserFixture.browser }));
  const monitoring = new MonitoringService(store, registry, { workspaceId, ownerId,
    installationGeneration: 'installation-visa', clock: options.clock ?? (() => now), random: () => 0.5 });
  const operations = new OperationService(store, new OperationRegistry(), options.clock ?? (() => now), workspaceId);
  const runtime = new ServiceRuntime(store, { async processAdmittedOwnerTurn() {
    throw new Error('model must not run'); } }, operations, { workspaceId, ownerId, instanceId: 'runtime-visa',
    serviceGeneration: 'service-visa', clock: options.clock ?? (() => now), monitoring,
    browserSessions: [browserFixture.browser], ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}) });
  return { store, monitoring, runtime, ...browserFixture };
}

function reserve(f) {
  const grant = f.monitoring.proposeGrant({ id: 'grant-visa', workspaceId, ownerId, adapter: 'us-visa-china',
    adapterVersion: 1, connectionId: 'connection-visa', connectionGeneration: 1,
    browserProfileId: 'profile-visa', subjectDigest, scope: { bookingType: 'new_group_appointment',
      location: 'Beijing', timeZone: 'Asia/Shanghai', startDate: '2026-12-15', endDate: '2027-01-31',
      eligibleTimes: 'any_offered_working_time', selection: 'earliest', maximumEffects: 1,
      provider: 'visa-scheduling', providerSubject: 'synthetic-account', resourceId: 'group-appointment',
      identityDigest, rosterDigest, termsDigest }, maximumEffects: 1, expiresAt: '2026-09-22T12:00:00.000Z' });
  f.monitoring.activateGrant({ ownerId, grantId: grant.id, digest: grant.digest, revision: grant.revision });
  return f.monitoring.reserve({ grantId: grant.id, workId: 'work', observation: { observedAt: now, complete: true,
    coverage: { contractVersion: 1, location: 'Beijing', timeZone: 'Asia/Shanghai', startDate: '2026-12-15',
      endDate: '2027-01-31', firstPage: 1, lastPage: 2, inspectedPages: [1, 2], paginationComplete: true,
      appointmentAbsent: true, identityDigest, rosterDigest, termsDigest }, candidates: [candidate], result: 'complete' },
    maxObservationAgeMs: 60_000, binding: { adapter: 'us-visa-china', adapterVersion: 1,
      connectionId: 'connection-visa', connectionGeneration: 1, browserProfileId: 'profile-visa', subjectDigest },
    actionId: 'action-visa', attemptId: 'attempt-visa' });
}

test('service runtime executes a real durable reservation through BrowserSession and encrypted intent journal', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'visa-runtime-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'store.db'); const key = randomBytes(32);
  const portal = new SyntheticPortalState({ scenario: 'calendar_match' });
  portal.gesture({ kind: 'calendar.next_page' });
  const f = build(path, key, portal); const action = reserve(f);
  f.runtime.admitAction({ requestId: 'execute-visa', kind: 'execute', actionId: action.id, digest: action.digest });
  await f.runtime.drain();
  assert.equal(portal.mutationCount, 1);
  assert.equal(f.submits(), 1);
  const final = f.store.state(workspaceId).actions[action.id];
  assert.equal(final.status, 'accepted');
  assert.equal(final.verification.status, 'satisfied');
  assert.ok(final.monitoredIntent.evidenceRef);
  assert.deepEqual(JSON.parse(f.store.readArtifact(workspaceId, final.monitoredIntent.evidenceRef)).intentId,
    final.monitoredIntent.intentId);
  assert.equal(final.monitoredConfirmation.referenceDigest,
    portal.authoritativeReadback().booking.referenceDigest);
  assert.deepEqual(JSON.parse(f.store.readArtifact(workspaceId, final.monitoredConfirmation.evidenceRef)),
    portal.authoritativeReadback().booking);
  assert.equal(f.monitoring.grant('grant-visa').status, 'consumed');
  await f.runtime.shutdown(); f.store.close();
  const reopened = new SqliteStore(path, { encryptionKey: Uint8Array.from(key), serviceQueue: { upgradeExisting: false } });
  assert.equal(reopened.state(workspaceId).actions[action.id].status, 'accepted');
  reopened.close();
});

test('an expired retained grant cannot dispatch a reserved visa mutation', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'visa-expired-authority-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'store.db'); const key = randomBytes(32);
  const portal = new SyntheticPortalState({ scenario: 'calendar_match' });
  portal.gesture({ kind: 'calendar.next_page' });
  let clock = now;
  const f = build(path, key, portal, { clock: () => clock }); const action = reserve(f);
  clock = '2026-09-23T12:00:00.000Z';
  f.runtime.admitAction({ requestId: 'execute-expired-visa', kind: 'execute',
    actionId: action.id, digest: action.digest });
  await f.runtime.drain();
  assert.equal(f.submits(), 0);
  assert.equal(portal.mutationCount, 0);
  assert.equal(f.monitoring.grant('grant-visa').settlement.outcome, 'failed');
  assert.equal(f.store.state(workspaceId).actions[action.id].status, 'failed');
  await f.runtime.shutdown(); f.store.close();
});

test('connection revocation while slot selection is awaited prevents visa submission', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'visa-revoked-authority-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'store.db'); const key = randomBytes(32);
  const portal = new SyntheticPortalState({ scenario: 'calendar_match' });
  portal.gesture({ kind: 'calendar.next_page' });
  let f;
  f = build(path, key, portal, { afterSelect: async () => {
    const state = f.store.state(workspaceId);
    f.store.append(workspaceId, state.version,
      [{ type: 'connection.revoked', data: { id: 'connection-visa', generation: 2 } }], { recordedAt: now });
  } });
  const action = reserve(f);
  f.runtime.admitAction({ requestId: 'execute-revoked-visa', kind: 'execute',
    actionId: action.id, digest: action.digest });
  await f.runtime.drain();
  assert.equal(f.submits(), 0);
  assert.equal(portal.mutationCount, 0);
  assert.equal(f.monitoring.grant('grant-visa').settlement.outcome, 'unknown');
  assert.equal(f.store.state(workspaceId).actions[action.id].status, 'unknown');
  await f.runtime.shutdown(); f.store.close();
});

test('verification-only recovery reads back from the exact ambiguous page state', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'visa-ambiguous-readback-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'store.db'); const key = randomBytes(32);
  const portal = new SyntheticPortalState({ scenario: 'calendar_match', ambiguousSubmission: true });
  portal.gesture({ kind: 'calendar.next_page' });
  const requests = [];
  const f = build(path, key, portal, { enforceExpectedState: true, requests }); const action = reserve(f);
  f.runtime.admitAction({ requestId: 'execute-ambiguous-visa', kind: 'execute',
    actionId: action.id, digest: action.digest });
  await f.runtime.drain();
  assert.equal(f.store.state(workspaceId).actions[action.id].status, 'unknown');
  assert.equal(portal.inspect().state, 'ambiguous_submission');
  const readbackJob = f.runtime.admitAction({ requestId: 'readback-ambiguous-visa', kind: 'readback',
    actionId: action.id, digest: action.digest });
  await f.runtime.drain();
  assert.ok(requests.some(request => request.kind === 'recognize'));
  assert.ok(requests.some(request => request.command?.kind === 'appointment.readback' &&
    request.expectedPageState === 'ambiguous_submission'), JSON.stringify(requests));
  assert.equal(f.store.serviceJob(workspaceId, readbackJob.job.id).result.reason, 'completed');
  assert.equal(portal.inspect().state, 'appointment');
  assert.equal(f.store.state(workspaceId).actions[action.id].status, 'accepted');
  assert.equal(f.monitoring.grant('grant-visa').status, 'consumed');
  await f.runtime.shutdown(); f.store.close();
});

for (const lateOutcome of ['resolve', 'reject'])
  test(`a non-cooperative visa gesture releases the worker and discards late ${lateOutcome}`, async t => {
    const directory = mkdtempSync(join(tmpdir(), `visa-noncooperative-${lateOutcome}-`));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const path = join(directory, 'store.db'); const key = randomBytes(32);
    const portal = new SyntheticPortalState({ scenario: 'calendar_match' });
    portal.gesture({ kind: 'calendar.next_page' });
    const selectGate = Promise.withResolvers();
    const f = build(path, key, portal, { timeoutMs: 20, selectGate }); const action = reserve(f);
    f.runtime.admitAction({ requestId: `execute-stalled-visa-${lateOutcome}`, kind: 'execute',
      actionId: action.id, digest: action.digest });
    const drained = f.runtime.drain();
    const bounded = await Promise.race([drained.then(() => true),
      new Promise(resolve => setTimeout(() => resolve(false), 100))]);
    await drained;
    assert.equal(bounded, true);
    assert.equal(f.runtime.snapshot().activeJobId, null);
    assert.equal(f.submits(), 0);
    assert.equal(portal.mutationCount, 0);
    assert.equal(f.store.state(workspaceId).actions[action.id].status, 'unknown');
    const journalLength = f.store.journal(workspaceId).length;
    if (lateOutcome === 'resolve') selectGate.resolve();
    else selectGate.reject(new Error('RAW_LATE_SELECTION_SECRET'));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.store.journal(workspaceId).length, journalLength);
    assert.equal(f.submits(), 0);
    assert.equal(portal.mutationCount, 0);
    await f.runtime.shutdown(); f.store.close();
  });

for (const lateOutcome of ['resolve', 'reject'])
  test(`a non-cooperative visa readback releases the worker and discards late ${lateOutcome}`, async t => {
    const directory = mkdtempSync(join(tmpdir(), `visa-readback-${lateOutcome}-`));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const path = join(directory, 'store.db'); const key = randomBytes(32);
    const portal = new SyntheticPortalState({ scenario: 'calendar_match', ambiguousSubmission: true });
    portal.gesture({ kind: 'calendar.next_page' });
    const readbackGate = Promise.withResolvers();
    const f = build(path, key, portal, { timeoutMs: 50, readbackGate }); const action = reserve(f);
    f.runtime.admitAction({ requestId: `execute-readback-${lateOutcome}`, kind: 'execute',
      actionId: action.id, digest: action.digest });
    await f.runtime.drain();
    assert.equal(f.store.state(workspaceId).actions[action.id].status, 'unknown');
    f.runtime.admitAction({ requestId: `stalled-readback-${lateOutcome}`, kind: 'readback',
      actionId: action.id, digest: action.digest });
    const drained = f.runtime.drain();
    const bounded = await Promise.race([drained.then(() => true),
      new Promise(resolve => setTimeout(() => resolve(false), 200))]);
    assert.equal(bounded, true);
    assert.equal(f.runtime.snapshot().activeJobId, null);
    assert.equal(f.store.state(workspaceId).actions[action.id].status, 'unknown');
    assert.equal(f.monitoring.grant('grant-visa').status, 'blocked');
    assert.equal(portal.inspect().state, 'ambiguous_submission');
    const journalLength = f.store.journal(workspaceId).length;
    if (lateOutcome === 'resolve') readbackGate.resolve();
    else readbackGate.reject(new Error('RAW_LATE_READBACK_SECRET'));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.store.journal(workspaceId).length, journalLength);
    assert.equal(f.store.state(workspaceId).actions[action.id].status, 'unknown');
    assert.equal(portal.inspect().state, 'ambiguous_submission');
    await f.runtime.shutdown(); f.store.close();
  });

test('journaled visa intent reaches the portal without transport-side provider injection', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'visa-intent-bridge-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'store.db'); const key = randomBytes(32);
  const portal = new SyntheticPortalState({ scenario: 'calendar_match' });
  portal.gesture({ kind: 'calendar.next_page' });
  const f = build(path, key, portal); const action = reserve(f);
  f.runtime.admitAction({ requestId: 'execute-intent-bridge-visa', kind: 'execute',
    actionId: action.id, digest: action.digest });
  await f.runtime.drain();
  assert.equal(f.store.state(workspaceId).actions[action.id].status, 'accepted');
  assert.equal(portal.mutationCount, 1);
  assert.equal(f.submits(), 1);
  await f.runtime.shutdown(); f.store.close();
});

for (const phase of ['before_submit', 'after_submit', 'after_confirmation']) test(`restart after ${phase} is verification-only and never submits twice`, async t => {
  const directory = mkdtempSync(join(tmpdir(), `visa-${phase}-`));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'store.db'); const key = randomBytes(32);
  const portal = new SyntheticPortalState({ scenario: 'calendar_match' });
  portal.gesture({ kind: 'calendar.next_page' });
  const option = phase === 'before_submit' ? { throwBeforeSubmit: true } : phase === 'after_submit'
    ? { throwAfterSubmit: true } : { throwAfterConfirmation: true };
  const f = build(path, key, portal, option); const action = reserve(f);
  f.runtime.admitAction({ requestId: `execute-${phase}`, kind: 'execute', actionId: action.id, digest: action.digest });
  await f.runtime.drain();
  const mutations = portal.mutationCount; const submits = f.submits();
  const uncertain = f.store.state(workspaceId).actions[action.id];
  assert.equal(uncertain.status, 'unknown');
  assert.equal(Boolean(uncertain.monitoredConfirmation), phase === 'after_confirmation');
  assert.equal(f.monitoring.grant('grant-visa').status, 'blocked');
  await f.runtime.shutdown(); f.store.close();
  const restoredPortal = SyntheticPortalState.restore(portal.exportDurableState());
  const restarted = build(path, Uint8Array.from(key), restoredPortal, { existing: true });
  restarted.runtime.admitAction({ requestId: `execute-again-${phase}`, kind: 'execute',
    actionId: action.id, digest: action.digest });
  await restarted.runtime.drain();
  assert.equal(restoredPortal.mutationCount, mutations);
  assert.equal(restarted.submits(), 0);
  assert.equal(restarted.store.state(workspaceId).actions[action.id].status, 'unknown');
  await restarted.runtime.shutdown(); restarted.store.close();
  assert.equal(submits, phase === 'before_submit' ? 0 : 1);
});

for (const phase of ['before_intent', 'after_intent', 'after_mutation', 'after_confirmation'])
  test(`an abrupt process restart ${phase} durably becomes unknown without replay`, async t => {
    const directory = mkdtempSync(join(tmpdir(), `visa-crash-${phase}-`));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const path = join(directory, 'store.db'); const key = randomBytes(32);
    const portal = new SyntheticPortalState({ scenario: 'calendar_match',
      ambiguousSubmission: phase === 'after_mutation' });
    portal.gesture({ kind: 'calendar.next_page' });
    const first = build(path, key, portal); const action = reserve(first);
    const admitted = first.runtime.admitAction({ requestId: `crash-${phase}`, kind: 'execute',
      actionId: action.id, digest: action.digest });
    const job = first.store.claimServiceJob(workspaceId, 'crashed-process', now);
    assert.equal(job.id, admitted.job.id);
    const intentId = hash(`${action.id}\0${action.attemptId}`);
    if (phase !== 'before_intent') first.store.recordMonitoredActionIntent(workspaceId, job.claim, {
      actionId: action.id, grantId: 'grant-visa', attemptId: action.attemptId, intentId,
      evidence: JSON.stringify({ intentId, actionId: action.id }), at: now });
    if (phase === 'after_mutation' || phase === 'after_confirmation') {
      const fence = { serviceGeneration: 'service-visa', deadline: Date.now() + 10_000,
        signal: new AbortController().signal, async assertCurrent() {} };
      await first.browser.gesture({ kind: 'booking.intent', slotId: candidate.id, intentId }, 'calendar', fence);
      await first.browser.gesture({ kind: 'slot.select', slotId: candidate.id }, 'calendar', fence);
      const confirmation = await first.browser.gesture(
        { kind: 'booking.submit', slotId: candidate.id, intentId }, 'booking_review', fence);
      if (phase === 'after_confirmation') first.store.recordMonitoredActionConfirmation(workspaceId, job.claim, {
        actionId: action.id, grantId: 'grant-visa', attemptId: action.attemptId,
        referenceDigest: confirmation.booking.referenceDigest, evidence: JSON.stringify(confirmation.booking), at: now
      });
    }
    await first.browser.shutdown(); first.store.close();

    const restoredPortal = SyntheticPortalState.restore(portal.exportDurableState());
    const restarted = build(path, Uint8Array.from(key), restoredPortal, { existing: true });
    restarted.runtime.start(); await restarted.runtime.drain();
    const recovered = restarted.store.state(workspaceId).actions[action.id];
    assert.equal(recovered.status, 'unknown');
    assert.equal(Boolean(recovered.monitoredConfirmation), phase === 'after_confirmation');
    if (phase === 'after_confirmation') assert.equal(recovered.monitoredConfirmation.referenceDigest,
      restoredPortal.authoritativeReadback().booking.referenceDigest);
    assert.equal(restarted.monitoring.grant('grant-visa').settlement.outcome, 'unknown');
    assert.equal(restarted.store.serviceJob(workspaceId, job.id).result.reason, 'action_unknown');
    const mutations = restoredPortal.mutationCount;
    restarted.runtime.admitAction({ requestId: `no-replay-${phase}`, kind: 'execute',
      actionId: action.id, digest: action.digest });
    await restarted.runtime.drain();
    assert.equal(restoredPortal.mutationCount, mutations);
    assert.equal(restarted.submits(), 0);
    if (phase === 'after_mutation' || phase === 'after_confirmation') {
      restarted.runtime.admitAction({ requestId: `readback-${phase}`, kind: 'readback',
        actionId: action.id, digest: action.digest });
      await restarted.runtime.drain();
      assert.equal(restarted.store.state(workspaceId).actions[action.id].status, 'accepted');
      assert.equal(restarted.monitoring.grant('grant-visa').status, 'consumed');
      assert.equal(restoredPortal.mutationCount, 1);
    }
    await restarted.runtime.shutdown(); restarted.store.close();
  });
