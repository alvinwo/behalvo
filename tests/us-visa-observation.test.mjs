import test from 'node:test';
import { runServiceDemo } from '../dist/service-demo.js';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { chmodSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SYNTHETIC_PORTAL_ORIGIN, SyntheticPortalState, createSyntheticUsVisaChinaExecutionAdapter,
  startLocalService, startSyntheticPortal
} from '../dist/index.js';
import { OperationStoppedError } from '../dist/operations/execution-context.js';
import { requestControl } from './owner-control-http-helpers.mjs';
import { createSyntheticBrowserHarness, createSyntheticBrowserTransportHarness } from './helpers/synthetic-browser.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const identityDigest = hash('synthetic-owner');
const subjectDigest = hash('synthetic-account');
const rosterDigest = hash('synthetic-group-roster');
const termsDigest = hash('synthetic-terms');
const candidateA = { id: 'slot-2027-01-04-0900', date: '2027-01-04', time: '09:00', location: 'Beijing',
  timeZone: 'Asia/Shanghai', rosterDigest, evidenceDigest: hash('synthetic-slot-evidence') };
const candidateB = { id: 'slot-2027-01-05-1000', date: '2027-01-05', time: '10:00', location: 'Beijing',
  timeZone: 'Asia/Shanghai', rosterDigest, evidenceDigest: hash('synthetic-slot-evidence-later') };
const scope = { bookingType: 'new_group_appointment', location: 'Beijing', timeZone: 'Asia/Shanghai',
  startDate: '2026-12-15', endDate: '2027-01-31', eligibleTimes: 'any_offered_working_time',
  selection: 'earliest', maximumEffects: 1, provider: 'visa-scheduling', providerSubject: 'synthetic-account',
  resourceId: 'group-appointment', identityDigest, rosterDigest, termsDigest };
const grant = { id: 'grant-visa', workspaceId: 'workspace', ownerId: 'owner', adapter: 'us-visa-china',
  adapterVersion: 1, connectionId: 'connection-visa', connectionGeneration: 1,
  browserProfileId: 'profile-visa', subjectDigest, scope, maximumEffects: 1,
  expiresAt: '2027-01-31T15:59:59.999Z', createdAt: '2026-09-21T12:00:00.000Z', revision: 1,
  digest: '5'.repeat(64), status: 'active', activatedAt: '2026-09-21T12:01:00.000Z',
  installationGeneration: 'installation-visa' };
const connection = { id: 'connection-visa', provider: 'visa-scheduling', subject: 'synthetic-account',
  label: 'Synthetic visa', generation: 1, status: 'active' };
const fence = () => ({ serviceGeneration: 'service-visa', deadline: Date.now() + 10_000,
  signal: new AbortController().signal, async assertCurrent() {} });
const coverage = { contractVersion: 1, location: 'Beijing', timeZone: 'Asia/Shanghai',
  startDate: '2026-12-15', endDate: '2027-01-31', firstPage: 1, lastPage: 2,
  inspectedPages: [1, 2], paginationComplete: true, appointmentAbsent: true,
  identityDigest, subjectDigest, rosterDigest, termsDigest, termsVersion: 'terms-1' };

function duplicateCandidateForm(time = '08:00') {
  return `<form method="post" action="/gesture"><input type="hidden" name="kind" value="slot.select">` +
    `<input type="hidden" name="slotId" value="${candidateA.id}">` +
    `<button type="submit" data-behalvo-gesture="slot.select" data-behalvo-slot-id="${candidateA.id}" ` +
    `data-behalvo-date="${candidateA.date}" data-behalvo-time="${time}" data-behalvo-location="Beijing" ` +
    `data-behalvo-evidence-digest="${candidateA.evidenceDigest}">Duplicate slot</button></form>`;
}

function nextPageForm() {
  return '<form method="post" action="/gesture"><input type="hidden" name="kind" ' +
    'value="calendar.next_page"><button type="submit" data-behalvo-gesture="calendar.next_page">Next</button></form>';
}

function assertContractChanged(observation, checkpoint) {
  assert.deepEqual(observation, { observedAt: observation.observedAt, complete: false,
    coverage: { checkpoint }, candidates: [], result: 'contract_changed' });
}

function runningAction(candidate) {
  return { id: 'action-visa', workId: 'work', key: 'monitor:grant:observation', digest: 'd'.repeat(64),
    workRevision: 1, status: 'running', attemptId: 'attempt-visa',
    monitoredGrant: { id: grant.id, digest: grant.digest, revision: grant.revision },
    command: { kind: 'operation.execute', operationId: 'us-visa-china', operationVersion: '1',
      connectionId: connection.id, provider: connection.provider, subject: connection.subject,
      connectionGeneration: 1, resourceId: 'group-appointment',
      arguments: { bookingType: 'new_group_appointment', candidateId: candidate.id, date: candidate.date,
        time: candidate.time, location: candidate.location, timeZone: candidate.timeZone,
        rosterDigest, identityDigest, termsDigest, evidenceDigest: candidate.evidenceDigest },
      affectedResourceIds: ['group-appointment'],
      precondition: { source: 'us-visa-china:synthetic', observedAt: '2026-12-01T12:00:00.000Z',
        providerVersion: '1', state: { appointmentAbsent: true, identityDigest, rosterDigest, termsDigest,
          candidateEvidenceDigest: candidate.evidenceDigest } },
      expectedResult: { status: 'booked', date: candidate.date, time: candidate.time, location: 'Beijing',
        timeZone: 'Asia/Shanghai', rosterDigest }, subjectRevision: 0, requestFingerprint: 'f'.repeat(64) } };
}

async function fixedPortal(state) {
  const server = await startSyntheticPortal({ state });
  assert.equal(server.origin, SYNTHETIC_PORTAL_ORIGIN);
  return server;
}

test('compiled synthetic page observation is contiguous and every poll restarts from page one', async t => {
  const server = await fixedPortal(new SyntheticPortalState({ scenario: 'calendar_match' }));
  t.after(() => server.close());
  const fixture = await createSyntheticBrowserHarness(server, { identityDigest, subjectDigest });
  t.after(() => fixture.close());
  const adapter = createSyntheticUsVisaChinaExecutionAdapter({ session: fixture.browser });
  const first = await adapter.inspect({ monitor: {}, grant, connection, fence: fence() });
  const second = await adapter.inspect({ monitor: {}, grant, connection, fence: fence() });
  for (const observation of [first, second]) {
    assert.equal(observation.complete, true);
    assert.equal(observation.result, 'complete');
    assert.deepEqual(observation.coverage, coverage);
    assert.deepEqual(observation.candidates, [candidateA]);
  }
  assert.deepEqual(fixture.commands, ['calendar.first_page', 'calendar.next_page',
    'calendar.first_page', 'calendar.next_page', 'calendar.first_page', 'calendar.next_page',
    'calendar.first_page', 'calendar.next_page']);
  assert.deepEqual(fixture.navigationErrors, []);
  assert.equal(server.state.mutationCount, 0);
});

test('compiled page metadata drift and omission cannot produce a narrowing observation', async t => {
  const server = await fixedPortal(new SyntheticPortalState({ scenario: 'calendar_match' }));
  t.after(() => server.close());
  const drifted = await createSyntheticBrowserHarness(server, { identityDigest, subjectDigest,
    transformHtml: html => html.replaceAll(rosterDigest, '9'.repeat(64)) });
  const adapter = createSyntheticUsVisaChinaExecutionAdapter({ session: drifted.browser });
  const result = await adapter.inspect({ monitor: {}, grant, connection, fence: fence() });
  assert.equal(result.complete, false);
  assert.deepEqual(result.candidates, []);
  assert.equal(result.result, 'contract_changed');
  await drifted.close();

  const missing = await createSyntheticBrowserHarness(server, { identityDigest, subjectDigest,
    transformHtml: html => html.replace(/ data-behalvo-terms-digest="[a-f0-9]{64}"/, '') });
  const missingAdapter = createSyntheticUsVisaChinaExecutionAdapter({ session: missing.browser });
  const malformed = await missingAdapter.inspect({ monitor: {}, grant, connection, fence: fence() });
  assertContractChanged(malformed, 'unknown');
  assert.equal(missing.commands.filter(command => command.startsWith('booking.')).length, 0);
  await missing.close();
  assert.equal(server.state.mutationCount, 0);
});

test('final compiled reread rejects duplicate candidate identity and evidence before observation or execution', async () => {
  for (const mode of ['observation', 'execution']) {
    const state = new SyntheticPortalState({ scenario: 'slot_race' });
    const server = await fixedPortal(state);
    let installations = 0;
    const fixture = await createSyntheticBrowserHarness(server, { identityDigest, subjectDigest,
      transformHtml(html) {
        installations++;
        return installations === 3 ? html.replace('</main>', `${duplicateCandidateForm()}</main>`) : html;
      } });
    try {
      const adapter = createSyntheticUsVisaChinaExecutionAdapter({ session: fixture.browser });
      if (mode === 'observation') {
        const result = await adapter.inspect({ monitor: {}, grant, connection, fence: fence() });
        assertContractChanged(result, 'candidate_set_changed');
      } else {
        await assert.rejects(adapter.executeReserved({ action: runningAction(candidateA), grant, connection,
          fence: fence(), intentId: 'intent-duplicate-reread', async recordConfirmation() {} }),
        /preflight|candidate|evidence|contract/i);
      }
      assert.equal(fixture.commands.some(command => command === 'slot.select' || command.startsWith('booking.')), false);
      assert.equal(state.mutationCount, 0);
    } finally { await fixture.close(); await server.close(); }
  }
});

test('final compiled reread rejects terminal and intermediate pagination contradictions', async () => {
  const cases = [
    { scenario: 'slot_race', installation: 3, from: 'data-behalvo-has-next="false"',
      to: 'data-behalvo-has-next="true"', checkpoint: 'pagination_changed', addNext: true },
    { scenario: 'calendar_match', installation: 4, from: 'data-behalvo-has-next="true"',
      to: 'data-behalvo-has-next="false"', checkpoint: 'unknown' }
  ];
  for (const item of cases) {
    const state = new SyntheticPortalState({ scenario: item.scenario });
    const server = await fixedPortal(state);
    let installations = 0;
    const fixture = await createSyntheticBrowserHarness(server, { identityDigest, subjectDigest,
      transformHtml(html) {
        if (++installations !== item.installation) return html;
        const changed = html.replace(item.from, item.to);
        return item.addNext ? changed.replace('</main>', `${nextPageForm()}</main>`) : changed;
      } });
    try {
      const adapter = createSyntheticUsVisaChinaExecutionAdapter({ session: fixture.browser });
      const result = await adapter.inspect({ monitor: {}, grant, connection, fence: fence() });
      assertContractChanged(result, item.checkpoint);
      assert.equal(fixture.commands.some(command => command === 'slot.select' || command.startsWith('booking.')), false);
      assert.equal(state.mutationCount, 0);
    } finally { await fixture.close(); await server.close(); }
  }
});

for (const phase of ['gesture', 'gesture.commit']) {
  test(`calendar contract changes during ${phase} stay typed and never click`, async () => {
    const state = new SyntheticPortalState({ scenario: 'calendar_match' });
    const server = await fixedPortal(state);
    let changed = false; let changedRoot;
    const fixture = await createSyntheticBrowserHarness(server, { identityDigest, subjectDigest,
      beforeContentRequest(request, root) {
        if (!changed && request.kind === phase) {
          changedRoot = root; delete root.behalvoTermsDigest; changed = true;
        }
      } });
    try {
      const adapter = createSyntheticUsVisaChinaExecutionAdapter({ session: fixture.browser });
      const observation = await adapter.inspect({ monitor: {}, grant, connection, fence: fence() });
      assertContractChanged(observation, 'unknown');
      assert.equal(changed, true);
      assert.deepEqual(fixture.commands, []);
      if (phase === 'gesture') assert.equal(fixture.contentRequests.includes('gesture.commit'), false);
      assert.deepEqual(fixture.navigationErrors, []);
      assert.equal(state.mutationCount, 0);
      changedRoot.behalvoTermsDigest = termsDigest;
      const later = await adapter.inspect({ monitor: {}, grant, connection, fence: fence() });
      assert.equal(later.complete, true);
      assert.deepEqual(later.candidates, [candidateA]);
    } finally { await fixture.close(); await server.close(); }
  });
}

for (const phase of ['gesture', 'gesture.commit']) {
  for (const invalidation of ['trusted fence revocation', 'abort']) {
    test(`compiled ${phase} contract rejection preserves ${invalidation} precedence`, async () => {
      const state = new SyntheticPortalState({ scenario: 'calendar_match' });
      const server = await fixedPortal(state);
      const controller = new AbortController();
      const revoked = new Error('trusted fence revoked during typed page rejection');
      let current = true; let invalidated = false; let postInvalidationChecks = 0;
      const trustedFence = { serviceGeneration: 'service-visa', deadline: Date.now() + 10_000,
        signal: controller.signal,
        async assertCurrent() {
          if (!current || controller.signal.aborted) postInvalidationChecks++;
          if (!current) throw revoked;
        } };
      const fixture = await createSyntheticBrowserHarness(server, { identityDigest, subjectDigest,
        beforeContentRequest(request, root) {
          if (!invalidated && request.kind === phase) {
            delete root.behalvoTermsDigest;
            invalidated = true;
            if (invalidation === 'trusted fence revocation') current = false;
            else controller.abort();
          }
        } });
      try {
        const adapter = createSyntheticUsVisaChinaExecutionAdapter({ session: fixture.browser });
        let failure;
        try { await adapter.inspect({ monitor: {}, grant, connection, fence: trustedFence }); }
        catch (error) { failure = error; }
        assert.equal(invalidated, true);
        if (invalidation === 'trusted fence revocation') assert.equal(failure, revoked);
        else assert.equal(failure instanceof OperationStoppedError, true);
        assert.equal(postInvalidationChecks, 1);
        assert.deepEqual(fixture.commands, []);
        if (phase === 'gesture') assert.equal(fixture.contentRequests.includes('gesture.commit'), false);
        assert.deepEqual(fixture.navigationErrors, []);
        assert.equal(state.mutationCount, 0);
      } finally { await fixture.close(); await server.close(); }
    });
  }
}

test('rendered 403 and 429 navigation destinations remain typed checkpoint observations', async () => {
  for (const [scenario, result] of [['forbidden', 'needs_human'], ['rate_limited', 'rate_limited']]) {
    const state = new SyntheticPortalState({ scenario: 'calendar_empty' });
    const server = await fixedPortal(state);
    const fixture = await createSyntheticBrowserHarness(server, { identityDigest, subjectDigest,
      beforeDestination() { state.setScenario(scenario); } });
    try {
      const adapter = createSyntheticUsVisaChinaExecutionAdapter({ session: fixture.browser });
      const observation = await adapter.inspect({ monitor: {}, grant, connection, fence: fence() });
      assert.deepEqual(observation, { observedAt: observation.observedAt, complete: false,
        coverage: { checkpoint: scenario }, candidates: [], result });
      assert.deepEqual(fixture.commands, ['calendar.first_page']);
      assert.deepEqual(fixture.navigationErrors, []);
      assert.equal(state.mutationCount, 0);
    } finally { await fixture.close(); await server.close(); }
  }
});

test('compiled checkpoint pages preserve distinct paused observation classes', async () => {
  const cases = [
    ['login', 'session_expired'], ['session_expired', 'session_expired'],
    ['security_question', 'needs_human'], ['challenge', 'needs_human'], ['forbidden', 'needs_human'],
    ['rate_limited', 'rate_limited'], ['terms_changed', 'contract_changed'], ['unknown', 'contract_changed']
  ];
  for (const [scenario, result] of cases) {
    const server = await fixedPortal(new SyntheticPortalState({ scenario }));
    const fixture = await createSyntheticBrowserHarness(server, { identityDigest, subjectDigest });
    try {
      const adapter = createSyntheticUsVisaChinaExecutionAdapter({ session: fixture.browser });
      const observation = await adapter.inspect({ monitor: {}, grant, connection, fence: fence() });
      assert.deepEqual(observation, {
        observedAt: observation.observedAt,
        complete: false, coverage: { checkpoint: scenario }, candidates: [], result
      });
      assert.deepEqual(fixture.commands, []);
      assert.equal(server.state.mutationCount, 0);
    } finally { await fixture.close(); await server.close(); }
  }
});

test('read-only disappearance rejects candidate A and a later fresh poll may return distinct candidate B', async t => {
  const state = new SyntheticPortalState({ scenario: 'calendar_match' });
  const server = await fixedPortal(state); t.after(() => server.close());
  let firstPages = 0;
  const fixture = await createSyntheticBrowserHarness(server, { identityDigest, subjectDigest,
    beforeNavigate(kind) {
      if (kind === 'calendar.first_page' && ++firstPages === 2)
        state.withdrawCandidateBeforeReservation();
    } });
  t.after(() => fixture.close());
  const adapter = createSyntheticUsVisaChinaExecutionAdapter({ session: fixture.browser });
  const disappeared = await adapter.inspect({ monitor: {}, grant, connection, fence: fence() });
  assert.deepEqual(disappeared, { observedAt: disappeared.observedAt, complete: false,
    coverage: { preflight: 'candidate_disappeared_before_reservation', evidenceDigest: candidateA.evidenceDigest },
    candidates: [], result: 'provider_unavailable' });
  assert.equal(fixture.commands.some(command => command === 'slot.select' || command.startsWith('booking.')), false);
  assert.equal(state.mutationCount, 0);

  state.publishLaterCandidate();
  const later = await adapter.inspect({ monitor: {}, grant, connection, fence: fence() });
  assert.equal(later.complete, true);
  assert.deepEqual(later.coverage, coverage);
  assert.deepEqual(later.candidates, [candidateB]);
  assert.equal(state.mutationCount, 0);
});

test('reserved execution rereads page evidence and never selects a replacement candidate', async t => {
  const state = new SyntheticPortalState({ scenario: 'calendar_later_match' });
  const server = await fixedPortal(state); t.after(() => server.close());
  const fixture = await createSyntheticBrowserHarness(server, { identityDigest, subjectDigest });
  t.after(() => fixture.close());
  const adapter = createSyntheticUsVisaChinaExecutionAdapter({ session: fixture.browser });
  await assert.rejects(adapter.executeReserved({ action: runningAction(candidateA), grant, connection,
    fence: fence(), intentId: 'intent-reserved-a', async recordConfirmation() {} }),
  /preflight|candidate|drift|disappear/i);
  assert.equal(fixture.commands.some(command => command === 'slot.select' || command.startsWith('booking.')), false);
  assert.equal(state.mutationCount, 0);
});

test('paired monitor resume reads the real compiled portal through framed native boundaries', async t => {
  const portal = await startSyntheticPortal({ state: new SyntheticPortalState({ scenario: 'calendar_empty' }), port: 43117 });
  t.after(() => portal.close());
  const browser = await createSyntheticBrowserTransportHarness(portal);
  t.after(() => browser.close());
  const root = mkdtempSync(join(tmpdir(), 'behalvo-monitoring-compiled-')); chmodSync(root, 0o700);
  const service = await startLocalService({ dbPath: join(root, 'service.db'),
    bootstrapDirectory: join(root, 'bootstrap'), workspaceId: 'workspace-compiled', ownerId: 'owner-compiled',
    upgradeStorage: true, assets: { html: '', javascript: '', css: '' }, port: 0,
    encryptionKey: new Uint8Array(32).fill(11), syntheticMonitoring: {
      fixtureId: 'visa-beijing-group-v1', async createBrowserTransport() {
        return { transport: browser.transport, tabId: browser.tabId };
      }
    } });
  t.after(() => service.shutdown());
  const bootstrap = JSON.parse(readFileSync(service.bootstrapPath, 'utf8'));
  const paired = await requestControl(service.origin, 'POST', '/api/session/bootstrap', bootstrap.token, {});
  const token = paired.body.token;
  assert.equal((await requestControl(service.origin, 'POST', '/api/monitoring/synthetic/setup', token,
    { requestId: 'compiled-setup', fixtureId: 'visa-beijing-group-v1' })).status, 200);
  const proposed = await requestControl(service.origin, 'POST', '/api/grants', token,
    { requestId: 'compiled-proposal', fixtureId: 'visa-beijing-group-v1' });
  const grant = proposed.body.grant;
  const review = await requestControl(service.origin, 'POST', `/api/grants/${grant.id}/review`, token, {});
  const armed = await requestControl(service.origin, 'POST', `/api/grants/${grant.id}/arm`, token,
    { requestId: 'compiled-arm', digest: grant.digest, revision: grant.revision, armToken: review.body.armToken });
  const paused = await requestControl(service.origin, 'POST', `/api/monitors/${armed.body.monitor.id}/pause`, token,
    { requestId: 'compiled-pause', digest: grant.digest, revision: grant.revision, controlRevision: 0 });
  assert.equal(paused.body.monitor.handoff.state, 'confirmed');
  const resumed = await requestControl(service.origin, 'POST', `/api/monitors/${armed.body.monitor.id}/resume`, token,
    { requestId: 'compiled-resume', digest: grant.digest, revision: grant.revision,
      controlRevision: paused.body.monitor.controlRevision, recoverHandoff: false });
  assert.equal(resumed.status, 202);
  let detail;
  for (let attempt = 0; attempt < 100; attempt++) {
    detail = (await requestControl(service.origin, 'GET', `/api/monitors/${armed.body.monitor.id}`, token)).body;
    if (detail.status === 'active') break;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.equal(detail.status, 'active');
  assert.ok(browser.contentRequests.includes('session.activate'));
  assert.deepEqual(browser.contentRequests.slice(-3), ['recognize', 'document.bind', 'inspect']);
  assert.equal(portal.state.mutationCount, 0);
});

test('composed service demo books one later candidate after restart, handoff, and a pre-reservation race', async () => {
  const before = readdirSync(tmpdir()).filter(name => name.startsWith('behalvo-service-demo-')).sort();
  const result = await runServiceDemo({ quiet: true });

  assert.equal(result.synthetic, true);
  assert.equal(result.fixedPortalOrigin, 'http://127.0.0.1:43117');
  assert.equal(result.emptyPoll.complete, true);
  assert.equal(result.emptyPoll.candidateCount, 0);
  assert.equal(result.overdueRestart.coalescedJobs, 1);
  assert.equal(result.handoff.pauseReason, 'needs_human');
  assert.equal(result.handoff.resumedFromFreshPage, true);
  assert.equal(result.race.kind, 'pre_reservation_candidate_disappeared');
  assert.equal(result.race.reservations, 0);
  assert.equal(result.race.providerMutations, 0);
  assert.notEqual(result.race.candidateId, result.booking.candidateId);
  assert.equal(result.booking.providerMutations, 1);
  assert.equal(result.booking.status, 'accepted');
  assert.equal(result.booking.verification, 'satisfied');
  assert.equal(result.booking.readbackStatus, 'booked');
  assert.equal(result.final.grantStatus, 'consumed');
  assert.equal(result.final.monitorStatus, 'stopped');
  assert.equal(result.final.activeMonitorJobs, 0);
  assert.equal(result.laterRestart.additionalObservations, 0);
  assert.equal(result.laterRestart.additionalGestures, 0);
  assert.equal(result.rebuild.matches, true);
  assert.deepEqual(result.rebuild.countersAfter, result.rebuild.countersBefore);
  assert.equal(result.browser.compiledManifestContent, true);
  assert.equal(result.browser.compiledBackground, true);
  assert.equal(result.browser.framedNativeTransport, true);
  assert.equal(result.browser.serviceOwnedSession, true);
  assert.deepEqual(readdirSync(tmpdir()).filter(name => name.startsWith('behalvo-service-demo-')).sort(), before);
});

test('service demo cleans its owned root and preserves a valid caller root when portal startup fails', async t => {
  const blocker = createServer();
  await new Promise((resolve, reject) => {
    blocker.once('error', reject);
    blocker.listen(43117, '127.0.0.1', resolve);
  });
  t.after(() => new Promise(resolve => blocker.close(resolve)));
  const before = readdirSync(tmpdir()).filter(name => name.startsWith('behalvo-service-demo-')).sort();
  await assert.rejects(runServiceDemo({ quiet: true }), /EADDRINUSE|address already in use/i);
  assert.deepEqual(readdirSync(tmpdir()).filter(name => name.startsWith('behalvo-service-demo-')).sort(), before);

  const callerRoot = mkdtempSync(join(tmpdir(), 'behalvo-demo-retained-'));
  t.after(() => rmSync(callerRoot, { recursive: true, force: true }));
  const callerMode = lstatSync(callerRoot).mode & 0o777;
  await assert.rejects(runServiceDemo({ rootDirectory: callerRoot, quiet: true }),
    /EADDRINUSE|address already in use/i);
  assert.equal(lstatSync(callerRoot).mode & 0o777, callerMode);
  assert.deepEqual(readdirSync(callerRoot), []);
});
