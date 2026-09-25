import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, webcrypto } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { performance } from 'node:perf_hooks';
import vm from 'node:vm';
import {
  BrowserEpochRegistry, BrowserSession, MonitoringRegistry, MonitoringService, NativeMessageReader,
  NativeMessagingTransport, OperationRegistry, OperationService, Operator, ServiceRuntime, SqliteStore,
  SyntheticPortalState, createSyntheticUsVisaChinaExecutionAdapter, startSyntheticPortal, writeNativeMessage
} from '../dist/index.js';
import { createNativeRequestBoundary } from '../extension/dist/background.js';

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
const extensionId = 'a'.repeat(32);

function compiledContent(document) {
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

function htmlAttributes(source) {
  const result = {};
  for (const match of source.matchAll(/([a-zA-Z0-9-]+)="([^"]*)"/g)) {
    const key = match[1].replace(/^data-/, '').replace(/-([a-z])/g, (_, value) => value.toUpperCase());
    result[key] = match[2].replaceAll('&quot;', '"').replaceAll('&lt;', '<').replaceAll('&gt;', '>')
      .replaceAll('&amp;', '&');
  }
  return result;
}

function asyncPortalBrowserDocument(html, navigate) {
  const main = html.match(/<main ([^>]*)>/);
  assert.ok(main, 'synthetic portal main element');
  const root = { dataset: htmlAttributes(main[1]) };
  const elements = [];
  for (const match of html.matchAll(/<form[^>]*>([\s\S]*?)<\/form>/g)) {
    const form = match[1]; const fields = {};
    for (const input of form.matchAll(/<input ([^>]*)>/g)) {
      const attributes = htmlAttributes(input[1]);
      fields[attributes.name] = attributes.value;
      if (attributes.behalvoIntentInput) elements.push({ dataset: attributes,
        get value() { return fields[attributes.name]; }, set value(value) { fields[attributes.name] = value; } });
    }
    const button = form.match(/<button [^>]*data-behalvo-gesture="[^"]+"[^>]*>/);
    if (button) elements.push({ dataset: htmlAttributes(button[0]), click() { void navigate(fields).catch(() => {}); } });
  }
  const review = html.match(/<div ([^>]*data-behalvo-review-slot[^>]*)>/);
  if (review) elements.push({ dataset: { ...htmlAttributes(review[1]), behalvoReviewSlot: '' } });
  const matches = (element, selector) => {
    for (const match of selector.matchAll(/\[data-([a-z0-9-]+)(?:="([^"]*)")?\]/g)) {
      const key = match[1].replace(/-([a-z])/g, (_, value) => value.toUpperCase());
      if (!(key in element.dataset) || (match[2] !== undefined && element.dataset[key] !== match[2])) return false;
    }
    return true;
  };
  return {
    querySelector(selector) {
      if (selector === '[data-behalvo-page-state]') return root;
      return elements.find(element => matches(element, selector)) ?? null;
    },
    querySelectorAll(selector) { return elements.filter(element => matches(element, selector)); }
  };
}

async function asynchronousHttpBrowser(server, options = {}) {
  let listener; let closed = false; let navigationCount = 0;
  const navigations = new Set();
  const commands = []; const navigationErrors = []; const navigationEvents = []; const boundaryEvents = [];
  const fromExtension = new PassThrough(); const toExtension = new PassThrough();
  const install = html => {
    listener = compiledContent(asyncPortalBrowserDocument(html, fields => {
      const navigation = (async () => {
        commands.push(fields.kind); navigationCount++;
        if (options.beforeNavigate) await options.beforeNavigate(fields.kind, navigationCount);
        navigationEvents.push(`${fields.kind}:fetch`);
        const response = await fetch(`${server.origin}/gesture`, { method: 'POST', redirect: 'follow',
          headers: { origin: server.origin, 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams(fields) });
        navigationEvents.push(`${fields.kind}:response:${response.status}`);
        const destination = await response.text(); navigationEvents.push(`${fields.kind}:document`);
        if (options.beforeInstall) await options.beforeInstall(fields.kind);
        if (options.destination) install(options.destination(fields.kind, destination, navigationCount));
        else install(destination);
      })();
      navigations.add(navigation); void navigation.catch(error => navigationErrors.push(String(error)))
        .finally(() => navigations.delete(navigation)).catch(() => {});
      return navigation;
    }));
  };
  install(await (await fetch(`${server.origin}/`)).text());
  const boundary = createNativeRequestBoundary((tabId, value) => new Promise((resolve, reject) => {
    assert.equal(tabId, 7);
    if (!listener) { reject(new Error('content document unavailable')); return; }
    try { listener(value, { id: extensionId }, resolve); } catch (error) { reject(error); }
  }));
  const reader = new NativeMessageReader(toExtension);
  let writes = Promise.resolve();
  const pump = (async () => {
    while (!closed) {
      const message = await reader.read();
      if (message === undefined) return;
      boundaryEvents.push(`request:${message.kind}`);
      void boundary(message).then(response => {
        boundaryEvents.push(`response:${response.kind}`);
        writes = writes.then(() => writeNativeMessage(fromExtension, response));
        return writes;
      }).catch(error => boundaryEvents.push(`error:${message.kind}:${String(error)}`));
    }
  })();
  void pump.catch(() => {});
  const transport = new NativeMessagingTransport(fromExtension, toExtension, undefined, options.transportTimeoutMs ?? 1_000);
  const browser = new BrowserSession({ profileId: 'profile-visa', connectionGeneration: 1,
    serviceGeneration: 'service-visa', allowedOrigin: 'http://127.0.0.1:43117', tabId: 7,
    identityDigest, subjectDigest, termsVersion: 'terms-1', registry: new BrowserEpochRegistry(), transport,
    persistence: { async pauseForHuman() {}, async releaseWorker() {}, async recoverHandoff() {},
      async resumePreflight() { return { profileId: 'profile-visa', connectionGeneration: 1,
        identityDigest, subjectDigest, termsVersion: 'terms-1', appointmentAbsent: true }; } }
  });
  return { browser, commands, navigationErrors, navigationEvents, boundaryEvents,
    submits: () => commands.filter(command => command === 'booking.submit').length,
    async close() { await Promise.allSettled([...navigations]); closed = true; await browser.shutdown();
      fromExtension.end(); toExtension.end(); await writes; } };
}

function response(request, snapshot, documentId = 'document-sync') {
  return { protocolVersion: 1, kind: 'result', requestId: request.requestId,
    profileId: request.profileId, connectionGeneration: request.connectionGeneration, epoch: request.epoch,
    serviceGeneration: request.serviceGeneration, origin: request.origin, tabId: request.tabId,
    sequence: request.sequence, documentId, pageState: snapshot.state, snapshot };
}

function session(portal, options = {}) {
  let submits = 0; let documentNumber = 1;
  const currentDocument = () => `document-sync-${documentNumber}`;
  const browser = new BrowserSession({ profileId: 'profile-visa', connectionGeneration: 1,
    serviceGeneration: 'service-visa', allowedOrigin: 'http://127.0.0.1:43117', tabId: 7,
    identityDigest, subjectDigest, termsVersion: 'terms-1', registry: new BrowserEpochRegistry(),
    persistence: { async pauseForHuman() {}, async releaseWorker() {}, async recoverHandoff() {},
      async resumePreflight() { return { profileId: 'profile-visa', connectionGeneration: 1,
        identityDigest, subjectDigest, termsVersion: 'terms-1', appointmentAbsent: true }; } },
    transport: { async inspect(request) {
      options.requests?.push(structuredClone(request));
      const actual = portal.inspect();
      const snapshot = actual.state === 'appointment' && options.readbackSnapshot ? options.readbackSnapshot(actual) : actual;
      if (options.enforceExpectedState && request.kind !== 'recognize' && snapshot.state !== request.expectedPageState)
        throw new Error('Synthetic browser page state changed.');
      return response(request, snapshot, currentDocument());
    },
      async gesture(request, authorize) {
        options.requests?.push(structuredClone(request));
        if (options.enforceExpectedState && portal.inspect().state !== request.expectedPageState)
          throw new Error('Synthetic browser page state changed.');
        if (request.command.kind === 'slot.select' && options.selectGate) {
          options.selectionEntered?.resolve(); await options.selectGate.promise;
        }
        if (request.command.kind === 'appointment.readback' && options.readbackGate) {
          options.readbackEntered?.resolve();
          await options.readbackGate.promise;
        }
        const final = await authorize();
        options.beforeFinalAuthorize?.(request.command.kind); final();
        const sourceDocument = currentDocument();
        if (request.command.kind === 'booking.submit') {
          submits++;
          const snapshot = portal.gesture(request.command);
          documentNumber++;
          if (options.afterSubmit) await options.afterSubmit();
          if (options.throwAfterSubmit) throw new Error('RAW_PROVIDER_SECRET');
          return response(request, snapshot, sourceDocument);
        }
        const snapshot = portal.gesture(request.command);
        documentNumber++;
        if (request.command.kind === 'slot.select' && options.afterSelect) await options.afterSelect();
        if (request.command.kind === 'slot.select' && options.throwBeforeSubmit) throw new Error('transport stopped');
        if (request.command.kind === 'appointment.readback' && options.throwAfterConfirmation)
          throw new Error('RAW_READBACK_SECRET');
        return response(request, snapshot, sourceDocument);
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
  const browserFixture = options.browserFixture ?? session(portal, options);
  const registry = new MonitoringRegistry();
  registry.register({ ...createSyntheticUsVisaChinaExecutionAdapter({ session: browserFixture.browser }),
    ...(options.executeReserved ? { executeReserved: options.executeReserved } : {}) });
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
      appointmentAbsent: true, identityDigest, subjectDigest, rosterDigest, termsDigest,
      termsVersion: 'terms-1' }, candidates: [candidate], result: 'complete' },
    maxObservationAgeMs: 60_000, binding: { adapter: 'us-visa-china', adapterVersion: 1,
      connectionId: 'connection-visa', connectionGeneration: 1, browserProfileId: 'profile-visa', subjectDigest },
    actionId: 'action-visa', attemptId: 'attempt-visa' });
}

function arm(f, at = now) {
  const grant = f.monitoring.proposeGrant({ id: 'grant-visa', workspaceId, ownerId, adapter: 'us-visa-china',
    adapterVersion: 1, connectionId: 'connection-visa', connectionGeneration: 1,
    browserProfileId: 'profile-visa', subjectDigest, scope: { bookingType: 'new_group_appointment',
      location: 'Beijing', timeZone: 'Asia/Shanghai', startDate: '2026-12-15', endDate: '2027-01-31',
      eligibleTimes: 'any_offered_working_time', selection: 'earliest', maximumEffects: 1,
      provider: 'visa-scheduling', providerSubject: 'synthetic-account', resourceId: 'group-appointment',
      identityDigest, rosterDigest, termsDigest }, maximumEffects: 1,
    expiresAt: new Date(Date.parse(at) + 86_400_000).toISOString() });
  f.monitoring.activateGrant({ ownerId, grantId: grant.id, digest: grant.digest, revision: grant.revision });
  f.monitoring.configureMonitor({ ownerId, id: 'monitor-visa', grantId: grant.id, workId: 'work', nextDueAt: at,
    maxObservationAgeMs: 60_000, intervalMs: 60_000, jitterMs: 0, requestBudget: 3,
    requestWindowMs: 300_000, backoffBaseMs: 60_000, backoffMaxMs: 600_000 });
  return grant;
}

test('a due page-derived visa monitor atomically dispatches exactly one execution without owner admission', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'visa-runtime-scheduled-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'store.db'); const key = randomBytes(32);
  const portal = new SyntheticPortalState({ scenario: 'calendar_match' });
  const server = await startSyntheticPortal({ state: portal, port: 0 });
  t.after(() => server.close());
  const browserFixture = await asynchronousHttpBrowser(server);
  t.after(() => browserFixture.close());
  const clock = () => new Date().toISOString();
  const f = build(path, key, portal, { browserFixture, clock });
  arm(f, clock());

  await f.runtime.tick();
  await f.runtime.drain();

  const jobs = f.store.serviceJobs(workspaceId, 0, 10).items;
  assert.deepEqual(jobs.map(job => job.kind), ['monitor', 'execute'], JSON.stringify({ jobs,
    state: f.store.state(workspaceId), journal: f.store.journal(workspaceId).map(record => record.event.type),
    commands: browserFixture.commands, navigationErrors: browserFixture.navigationErrors }));
  assert.deepEqual(jobs.map(job => job.status), ['finished', 'finished']);
  assert.equal(jobs[1].parameters.actionId, Object.keys(f.store.state(workspaceId).actions)[0]);
  assert.equal(jobs[1].result.reason, 'completed');
  assert.equal(f.store.serviceJobReceipt(workspaceId, jobs[1].id).source, 'kernel:monitor-action');
  assert.equal(f.store.serviceJobReceipt(workspaceId, jobs[1].id).requestId, `${jobs[0].id}:execute`);
  assert.equal(portal.mutationCount, 1);
  assert.equal(browserFixture.submits(), 1);
  assert.equal(f.store.state(workspaceId).monitors['monitor-visa'].status, 'stopped');
  assert.equal(f.monitoring.grant('grant-visa').status, 'consumed');
  const eventTypes = f.store.journal(workspaceId).map(record => record.event.type);
  const observationIndex = eventTypes.indexOf('monitor.observation_recorded');
  assert.deepEqual(eventTypes.slice(observationIndex, observationIndex + 5), [
    'monitor.observation_recorded', 'monitored_action.command_narrowed', 'monitored_action.grant_reserved',
    'action.started', 'monitor.stopped'
  ]);
  assert.equal(eventTypes.filter(type => type === 'action.started').length, 1);
  await f.runtime.shutdown(); f.store.close(); await browserFixture.close();
});

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

test('encrypted runtime completes exact visa review, confirmation, and readback through asynchronous HTTP form navigation', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'visa-runtime-http-navigation-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'store.db'); const key = randomBytes(32);
  const portal = new SyntheticPortalState({ scenario: 'calendar_match' });
  const server = await startSyntheticPortal({ state: portal, port: 0 });
  t.after(() => server.close());
  const advance = await fetch(`${server.origin}/gesture`, { method: 'POST', redirect: 'follow',
    headers: { origin: server.origin, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ kind: 'calendar.next_page' }) });
  assert.equal(advance.status, 200);
  const browserFixture = await asynchronousHttpBrowser(server);
  t.after(() => browserFixture.close());
  const f = build(path, key, portal, { browserFixture }); const action = reserve(f);
  f.runtime.admitAction({ requestId: 'execute-http-navigation-visa', kind: 'execute',
    actionId: action.id, digest: action.digest });
  await f.runtime.drain();
  const final = f.store.state(workspaceId).actions[action.id];
  assert.equal(final.status, 'accepted', JSON.stringify({ commands: browserFixture.commands,
    navigationErrors: browserFixture.navigationErrors, navigationEvents: browserFixture.navigationEvents,
    boundaryEvents: browserFixture.boundaryEvents, portal: portal.inspect(), action: final,
    grant: f.monitoring.grant('grant-visa') }));
  assert.equal(final.verification.status, 'satisfied');
  assert.deepEqual(browserFixture.commands,
    ['calendar.first_page', 'calendar.next_page', 'calendar.first_page', 'calendar.next_page',
      'booking.intent', 'slot.select', 'booking.submit', 'appointment.readback']);
  assert.equal(browserFixture.submits(), 1);
  assert.equal(portal.mutationCount, 1);
  assert.equal(portal.inspect().state, 'appointment');
  assert.equal(final.monitoredConfirmation.referenceDigest,
    portal.authoritativeReadback().booking.referenceDigest);
  assert.equal(f.monitoring.grant('grant-visa').status, 'consumed');
  await f.runtime.shutdown(); f.store.close(); await browserFixture.close();
});

test('ambiguous asynchronous HTTP submission restarts verification-only and never replays the form', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'visa-runtime-http-restart-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'store.db'); const key = randomBytes(32);
  const portal = new SyntheticPortalState({ scenario: 'calendar_match', ambiguousSubmission: true });
  const server = await startSyntheticPortal({ state: portal, port: 0 });
  await fetch(`${server.origin}/gesture`, { method: 'POST', redirect: 'follow',
    headers: { origin: server.origin, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ kind: 'calendar.next_page' }) });
  const firstBrowser = await asynchronousHttpBrowser(server);
  const first = build(path, key, portal, { browserFixture: firstBrowser }); const action = reserve(first);
  first.runtime.admitAction({ requestId: 'execute-http-ambiguous-visa', kind: 'execute',
    actionId: action.id, digest: action.digest });
  await first.runtime.drain();
  assert.equal(first.store.state(workspaceId).actions[action.id].status, 'unknown');
  assert.deepEqual(firstBrowser.commands,
    ['calendar.first_page', 'calendar.next_page', 'calendar.first_page', 'calendar.next_page',
      'booking.intent', 'slot.select', 'booking.submit']);
  assert.equal(portal.mutationCount, 1);
  const durablePortal = portal.exportDurableState();
  await first.runtime.shutdown(); first.store.close(); await firstBrowser.close(); await server.close();

  const restoredPortal = SyntheticPortalState.restore(durablePortal);
  const restartedServer = await startSyntheticPortal({ state: restoredPortal, port: 0 });
  t.after(() => restartedServer.close());
  const restartedBrowser = await asynchronousHttpBrowser(restartedServer);
  t.after(() => restartedBrowser.close());
  const restarted = build(path, Uint8Array.from(key), restoredPortal,
    { existing: true, browserFixture: restartedBrowser });
  restarted.runtime.admitAction({ requestId: 'no-replay-http-ambiguous-visa', kind: 'execute',
    actionId: action.id, digest: action.digest });
  await restarted.runtime.drain();
  assert.deepEqual(restartedBrowser.commands, []);
  const readback = restarted.runtime.admitAction({ requestId: 'readback-http-ambiguous-visa', kind: 'readback',
    actionId: action.id, digest: action.digest });
  await restarted.runtime.drain();
  assert.deepEqual(restartedBrowser.commands, ['appointment.readback']);
  assert.equal(restoredPortal.mutationCount, 1);
  assert.equal(restoredPortal.inspect().state, 'appointment');
  assert.equal(restarted.store.serviceJob(workspaceId, readback.job.id).result.reason, 'completed');
  assert.equal(restarted.store.state(workspaceId).actions[action.id].status, 'accepted');
  assert.equal(restarted.monitoring.grant('grant-visa').status, 'consumed');
  await restarted.runtime.shutdown(); restarted.store.close(); await restartedBrowser.close();
});

test('asynchronous HTTP destination timeout stays unknown and never submits after late navigation', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'visa-runtime-http-timeout-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'store.db'); const key = randomBytes(32);
  const portal = new SyntheticPortalState({ scenario: 'calendar_match' });
  const server = await startSyntheticPortal({ state: portal, port: 0 });
  t.after(() => server.close());
  await fetch(`${server.origin}/gesture`, { method: 'POST', redirect: 'follow',
    headers: { origin: server.origin, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ kind: 'calendar.next_page' }) });
  const selection = Promise.withResolvers();
  const browserFixture = await asynchronousHttpBrowser(server, {
    async beforeNavigate(kind) { if (kind === 'slot.select') await selection.promise; }
  });
  const f = build(path, key, portal, { browserFixture, timeoutMs: 300 }); const action = reserve(f);
  f.runtime.admitAction({ requestId: 'execute-http-timeout-visa', kind: 'execute',
    actionId: action.id, digest: action.digest });
  await f.runtime.drain();
  assert.equal(f.store.state(workspaceId).actions[action.id].status, 'unknown');
  assert.deepEqual(browserFixture.commands,
    ['calendar.first_page', 'calendar.next_page', 'calendar.first_page', 'calendar.next_page',
      'booking.intent', 'slot.select']);
  assert.equal(browserFixture.submits(), 0);
  assert.equal(portal.mutationCount, 0);
  const journalLength = f.store.journal(workspaceId).length;
  selection.resolve(); await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(f.store.journal(workspaceId).length, journalLength);
  assert.equal(browserFixture.submits(), 0);
  assert.equal(portal.mutationCount, 0);
  await f.runtime.shutdown(); f.store.close(); await browserFixture.close();
});

test('unexpected fresh HTTP destination fails the exact review contract without submission', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'visa-runtime-http-unexpected-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'store.db'); const key = randomBytes(32);
  const portal = new SyntheticPortalState({ scenario: 'calendar_match' });
  const server = await startSyntheticPortal({ state: portal, port: 0 });
  t.after(() => server.close());
  await fetch(`${server.origin}/gesture`, { method: 'POST', redirect: 'follow',
    headers: { origin: server.origin, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ kind: 'calendar.next_page' }) });
  const browserFixture = await asynchronousHttpBrowser(server, { destination(kind, html) {
    return kind === 'slot.select'
      ? html.replace('data-behalvo-page-state="booking_review"', 'data-behalvo-page-state="unknown"') : html;
  } });
  const f = build(path, key, portal, { browserFixture }); const action = reserve(f);
  f.runtime.admitAction({ requestId: 'execute-http-unexpected-visa', kind: 'execute',
    actionId: action.id, digest: action.digest });
  await f.runtime.drain();
  assert.equal(f.store.state(workspaceId).actions[action.id].status, 'failed');
  assert.equal(f.monitoring.grant('grant-visa').settlement.outcome, 'failed');
  assert.deepEqual(browserFixture.commands,
    ['calendar.first_page', 'calendar.next_page', 'calendar.first_page', 'calendar.next_page',
      'booking.intent', 'slot.select']);
  assert.equal(browserFixture.submits(), 0);
  assert.equal(portal.mutationCount, 0);
  await f.runtime.shutdown(); f.store.close(); await browserFixture.close();
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
  test(`a non-cooperative visa gesture releases the worker and discards late ${lateOutcome}`, { timeout: 2_000 }, async t => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
    const directory = mkdtempSync(join(tmpdir(), `visa-noncooperative-${lateOutcome}-`));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const path = join(directory, 'store.db'); const key = randomBytes(32);
    const portal = new SyntheticPortalState({ scenario: 'calendar_match' });
    portal.gesture({ kind: 'calendar.next_page' });
    const selectGate = Promise.withResolvers(), selectionEntered = Promise.withResolvers();
    const f = build(path, key, portal, { timeoutMs: 20, selectGate, selectionEntered }); const action = reserve(f);
    t.after(async () => { selectGate.resolve(); await f.runtime.shutdown(); f.store.close(); });
    f.runtime.admitAction({ requestId: `execute-stalled-visa-${lateOutcome}`, kind: 'execute',
      actionId: action.id, digest: action.digest });
    const drained = f.runtime.drain();
    await Promise.race([selectionEntered.promise, drained.then(() => {
      throw new Error('Execution ended before selection transport entry');
    })]);
    t.mock.timers.tick(20);
    await drained;
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
  });

for (const lateOutcome of ['resolve', 'reject'])
  test(`a non-cooperative visa readback releases the worker and discards late ${lateOutcome}`, { timeout: 2_000 }, async t => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
    const directory = mkdtempSync(join(tmpdir(), `visa-readback-${lateOutcome}-`));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const path = join(directory, 'store.db'); const key = randomBytes(32);
    const portal = new SyntheticPortalState({ scenario: 'calendar_match', ambiguousSubmission: true });
    portal.gesture({ kind: 'calendar.next_page' });
    const readbackGate = Promise.withResolvers(), readbackEntered = Promise.withResolvers();
    const f = build(path, key, portal, { timeoutMs: 50, readbackGate, readbackEntered }); const action = reserve(f);
    t.after(async () => { readbackGate.resolve(); await f.runtime.shutdown(); f.store.close(); });
    f.runtime.admitAction({ requestId: `execute-readback-${lateOutcome}`, kind: 'execute',
      actionId: action.id, digest: action.digest });
    await f.runtime.drain();
    assert.equal(f.store.state(workspaceId).actions[action.id].status, 'unknown');
    f.runtime.admitAction({ requestId: `stalled-readback-${lateOutcome}`, kind: 'readback',
      actionId: action.id, digest: action.digest });
    const drained = f.runtime.drain();
    await Promise.race([readbackEntered.promise, drained.then(() => {
      throw new Error('Execution ended before readback transport entry');
    })]);
    t.mock.timers.tick(50);
    await drained;
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

function revokeReserved(f) {
  const grant = f.monitoring.grant('grant-visa');
  return f.monitoring.revokeGrant({ ownerId, grantId: grant.id, digest: grant.digest,
    revision: grant.revision, reason: 'owner_revoked' });
}

for (const late of ['resolve', 'reject'])
  test(`owner revoke releases held selection and fences its late ${late}`, async t => {
    const directory = mkdtempSync(join(tmpdir(), 'visa-owner-stop-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const portal = new SyntheticPortalState({ scenario: 'calendar_match' });
    portal.gesture({ kind: 'calendar.next_page' });
    const selectGate = Promise.withResolvers(), selectionEntered = Promise.withResolvers();
    const f = build(join(directory, 'store.db'), randomBytes(32), portal, { selectGate, selectionEntered });
    t.after(async () => { selectGate.resolve(); await f.runtime.shutdown(); f.store.close(); });
    const action = reserve(f);
    const job = f.runtime.admitAction({ requestId: 'execute-owner-stop', kind: 'execute',
      actionId: action.id, digest: action.digest }).job;
    const drain = f.runtime.drain(); await selectionEntered.promise;
    revokeReserved(f);
    assert.equal(f.store.state(workspaceId).actions[action.id].status, 'unknown');
    assert.equal(f.store.serviceJob(workspaceId, job.id).result.reason, 'action_unknown');
    assert.equal(await Promise.race([drain.then(() => true),
      new Promise(resolve => setTimeout(() => resolve(false), 200))]), true, 'revoke releases a non-cooperative worker');
    assert.equal(f.runtime.snapshot().activeJobId, null);
    const version = f.store.state(workspaceId).version;
    if (late === 'resolve') selectGate.resolve(); else selectGate.reject(new Error('Synthetic late rejection'));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.store.state(workspaceId).version, version);
    f.runtime.admitAction({ requestId: 'execute-owner-stop-again', kind: 'execute',
      actionId: action.id, digest: action.digest });
    await f.runtime.drain();
    assert.equal(f.submits(), 0); assert.equal(portal.mutationCount, 0);
  });

test('owner revoke between async authority check and final gesture authorization denies the gesture', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'visa-final-stop-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const portal = new SyntheticPortalState({ scenario: 'calendar_match' });
  portal.gesture({ kind: 'calendar.next_page' });
  let f, revoked;
  f = build(join(directory, 'store.db'), randomBytes(32), portal, {
    beforeFinalAuthorize(kind) { if (kind === 'booking.submit') revoked = revokeReserved(f); }
  });
  t.after(async () => { await f.runtime.shutdown(); f.store.close(); });
  const action = reserve(f);
  f.runtime.admitAction({ requestId: 'execute-final-stop', kind: 'execute', actionId: action.id, digest: action.digest });
  await f.runtime.drain();
  assert.equal(revoked?.revokedAt, now);
  assert.equal(f.submits(), 0); assert.equal(portal.mutationCount, 0);
  assert.equal(f.store.state(workspaceId).actions[action.id].status, 'unknown');
});

test('owner revoke after submission retains unknown and explicit exact readback consumes revoked allowance', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'visa-post-submit-stop-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const portal = new SyntheticPortalState({ scenario: 'calendar_match' });
  portal.gesture({ kind: 'calendar.next_page' });
  const submitted = Promise.withResolvers(), confirmation = Promise.withResolvers();
  const f = build(join(directory, 'store.db'), randomBytes(32), portal, {
    async afterSubmit() { submitted.resolve(); await confirmation.promise; }
  });
  t.after(async () => { confirmation.resolve(); await f.runtime.shutdown(); f.store.close(); });
  const action = reserve(f);
  f.runtime.admitAction({ requestId: 'execute-post-submit-stop', kind: 'execute', actionId: action.id, digest: action.digest });
  const drain = f.runtime.drain(); await submitted.promise;
  revokeReserved(f); await drain;
  assert.equal(f.submits(), 1); assert.equal(portal.mutationCount, 1);
  const stopped = f.store.state(workspaceId);
  assert.equal(stopped.actions[action.id].status, 'unknown');
  assert.equal(stopped.actions[action.id].monitoredConfirmation, undefined);
  confirmation.resolve(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.store.state(workspaceId).version, stopped.version);
  const readback = f.runtime.admitAction({ requestId: 'readback-revoked', kind: 'readback',
    actionId: action.id, digest: action.digest }).job;
  await f.runtime.drain();
  assert.equal(f.store.serviceJob(workspaceId, readback.id).result.reason, 'completed');
  assert.equal(f.store.state(workspaceId).actions[action.id].verification.status, 'satisfied');
  assert.equal(f.monitoring.grant('grant-visa').status, 'consumed');
  assert.equal(f.monitoring.grant('grant-visa').revokedAt, now);
  assert.equal(f.submits(), 1); assert.equal(portal.mutationCount, 1);
});

test('owner revoke during asynchronous HTTP submission stays unknown then verifies without replay', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'visa-http-owner-stop-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const portal = new SyntheticPortalState({ scenario: 'calendar_match' });
  const server = await startSyntheticPortal({ state: portal, port: 0 });
  t.after(() => server.close());
  await fetch(`${server.origin}/gesture`, { method: 'POST', redirect: 'follow',
    headers: { origin: server.origin, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ kind: 'calendar.next_page' }) });
  const submitted = Promise.withResolvers(), navigation = Promise.withResolvers();
  const browserFixture = await asynchronousHttpBrowser(server, {
    async beforeInstall(kind) { if (kind === 'booking.submit') { submitted.resolve(); await navigation.promise; } }
  });
  t.after(async () => { navigation.resolve(); await browserFixture.close(); });
  const f = build(join(directory, 'store.db'), randomBytes(32), portal, { browserFixture });
  t.after(async () => { await f.runtime.shutdown(); f.store.close(); });
  const action = reserve(f);
  f.runtime.admitAction({ requestId: 'execute-http-owner-stop', kind: 'execute', actionId: action.id, digest: action.digest });
  const drain = f.runtime.drain(); await submitted.promise;
  revokeReserved(f); await drain;
  assert.equal(f.store.state(workspaceId).actions[action.id].status, 'unknown');
  const version = f.store.state(workspaceId).version;
  navigation.resolve(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.store.state(workspaceId).version, version);
  f.runtime.admitAction({ requestId: 'reexecute-http-owner-stop', kind: 'execute', actionId: action.id, digest: action.digest });
  await f.runtime.drain();
  const readback = f.runtime.admitAction({ requestId: 'readback-http-owner-stop', kind: 'readback',
    actionId: action.id, digest: action.digest }).job;
  await f.runtime.drain();
  assert.equal(f.store.serviceJob(workspaceId, readback.id).result.reason, 'completed');
  assert.equal(f.monitoring.grant('grant-visa').revokedAt, now);
  assert.equal(f.monitoring.grant('grant-visa').status, 'consumed');
  assert.equal(f.submits(), 1); assert.equal(portal.mutationCount, 1);
  assert.deepEqual(browserFixture.commands,
    ['calendar.first_page', 'calendar.next_page', 'calendar.first_page', 'calendar.next_page',
      'booking.intent', 'slot.select', 'booking.submit', 'appointment.readback']);
});

for (const late of ['resolve', 'reject'])
  test(`revoked non-cooperative adapter denies late confirmation and consumes late ${late}`, async t => {
    const directory = mkdtempSync(join(tmpdir(), 'visa-adapter-owner-stop-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const portal = new SyntheticPortalState({ scenario: 'calendar_match' });
    const entered = Promise.withResolvers(), held = Promise.withResolvers();
    const f = build(join(directory, 'store.db'), randomBytes(32), portal, {
      executeReserved(context) { entered.resolve(context); return held.promise; }
    });
    t.after(async () => { held.resolve({ status: 'unknown' }); await f.runtime.shutdown(); f.store.close(); });
    const action = reserve(f);
    f.runtime.admitAction({ requestId: 'execute-adapter-owner-stop', kind: 'execute', actionId: action.id, digest: action.digest });
    const drain = f.runtime.drain(); const context = await entered.promise;
    revokeReserved(f);
    assert.equal(await Promise.race([drain.then(() => true),
      new Promise(resolve => setTimeout(() => resolve(false), 200))]), true);
    const version = f.store.state(workspaceId).version;
    await assert.rejects(context.recordConfirmation({ referenceDigest: 'a'.repeat(64) }));
    if (late === 'resolve') held.resolve({ status: 'accepted', receipt: {} });
    else held.reject(new Error('Synthetic late adapter failure'));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.store.state(workspaceId).version, version);
    assert.equal(f.store.state(workspaceId).actions[action.id].status, 'unknown');
    assert.equal(f.store.state(workspaceId).actions[action.id].monitoredConfirmation, undefined);
    assert.equal(portal.mutationCount, 0);
  });

for (const mismatch of ['empty', 'wrong', 'incomplete'])
  test(`revoked reservation retains unknown on ${mismatch} readback`, async t => {
    const directory = mkdtempSync(join(tmpdir(), 'visa-revoked-readback-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const portal = new SyntheticPortalState({ scenario: 'appointment' });
    const f = build(join(directory, 'store.db'), randomBytes(32), portal, {
      readbackSnapshot(snapshot) {
        if (mismatch === 'empty') return { state: 'appointment' };
        const booking = { ...snapshot.booking };
        if (mismatch === 'wrong') booking.rosterDigest = 'f'.repeat(64);
        else delete booking.time;
        return { ...snapshot, booking };
      }
    });
    t.after(async () => { await f.runtime.shutdown(); f.store.close(); });
    const action = reserve(f); revokeReserved(f);
    const before = f.monitoring.grant('grant-visa');
    f.runtime.admitAction({ requestId: 'readback-revoked-mismatch', kind: 'readback', actionId: action.id, digest: action.digest });
    await f.runtime.drain();
    assert.equal(f.store.state(workspaceId).actions[action.id].status, 'unknown');
    assert.deepEqual(f.monitoring.grant('grant-visa'), before);
    assert.equal(f.submits(), 0); assert.equal(portal.mutationCount, 1, 'the seeded appointment is the only provider mutation');
  });
