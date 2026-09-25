import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { validateLocalServiceOptions } from '../dist/service/config.js';
import { SqliteStore, startLocalService } from '../dist/index.js';
import { createSyntheticMonitoringComposition } from '../dist/service/synthetic-monitoring.js';
import { serviceJobContext } from '../dist/storage/sqlite-codec.js';
import { validateStorage } from '../dist/storage/sqlite-schema.js';
import { requestControl } from './owner-control-http-helpers.mjs';

function options(overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'behalvo-monitoring-config-'));
  return {
    dbPath: join(root, 'service.db'), bootstrapDirectory: join(root, 'bootstrap'),
    workspaceId: 'workspace-monitoring', ownerId: 'owner-monitoring', upgradeStorage: true,
    assets: { html: '', javascript: '', css: '' },
    ...overrides
  };
}

async function compositionFixture(overrides = {}) {
  const store = new SqliteStore(':memory:', { serviceQueue: { upgradeExisting: true } });
  store.createWorkspace('workspace-composition', 'owner-composition');
  let revokes = 0; let reconciles = 0; let closes = 0;
  const transport = overrides.transport ?? {
    async inspect() { throw new Error('unexpected inspection'); },
    async gesture() { throw new Error('unexpected gesture'); },
    async revoke() { revokes++; }, async reconcileRevocation() { reconciles++; }, async close() { closes++; }
  };
  const composition = await createSyntheticMonitoringComposition({ store, workspaceId: 'workspace-composition',
    ownerId: 'owner-composition', serviceGeneration: 'service-composition', clock: () => '2026-09-23T12:00:00.000Z',
    options: { fixtureId: 'visa-beijing-group-v1', async createBrowserTransport() { return { transport, tabId: 7 }; } } });
  return { store, composition, transport, counts: () => ({ revokes, reconciles, closes }) };
}

async function pairAndArm(service, prefix) {
  const bootstrap = JSON.parse(readFileSync(service.bootstrapPath, 'utf8'));
  const paired = await requestControl(service.origin, 'POST', '/api/session/bootstrap', bootstrap.token, {});
  const token = paired.body.token;
  await requestControl(service.origin, 'POST', '/api/monitoring/synthetic/setup', token,
    { requestId: `${prefix}-setup`, fixtureId: 'visa-beijing-group-v1' });
  const proposed = await requestControl(service.origin, 'POST', '/api/grants', token,
    { requestId: `${prefix}-proposal`, fixtureId: 'visa-beijing-group-v1' });
  const grant = proposed.body.grant;
  const review = await requestControl(service.origin, 'POST', `/api/grants/${grant.id}/review`, token, {});
  const armed = await requestControl(service.origin, 'POST', `/api/grants/${grant.id}/arm`, token,
    { requestId: `${prefix}-arm`, digest: grant.digest, revision: grant.revision, armToken: review.body.armToken });
  assert.equal(armed.status, 200);
  return { token, grant, monitor: armed.body.monitor };
}

test('synthetic monitoring is explicit, encrypted, and excludes legacy browser compositions', () => {
  let calls = 0;
  const syntheticMonitoring = {
    fixtureId: 'visa-beijing-group-v1',
    createBrowserTransport: async () => { calls++; throw new Error('unused'); }
  };
  const key = new Uint8Array(32).fill(7);
  assert.equal(validateLocalServiceOptions(options({ syntheticMonitoring, encryptionKey: key })).syntheticMonitoring,
    syntheticMonitoring);
  assert.throws(() => validateLocalServiceOptions(options({ syntheticMonitoring })),
    /encrypted storage/i);
  assert.throws(() => validateLocalServiceOptions(options({ syntheticMonitoring, encryptionKey: key,
    syntheticOperations: true })), /configuration/i);
  assert.throws(() => validateLocalServiceOptions(options({ syntheticMonitoring, encryptionKey: key,
    browserSessions: [] })), /configuration/i);
  assert.equal(calls, 0);
});

test('composed automatic checkpoint durably pauses then retires the exact browser epoch', async t => {
  const root = mkdtempSync(join(tmpdir(), 'behalvo-monitoring-checkpoint-')); chmodSync(root, 0o700);
  let now = Date.parse('2026-09-23T12:00:00.000Z'); let context; let revokes = 0;
  const service = await startLocalService({ dbPath: join(root, 'service.db'),
    bootstrapDirectory: join(root, 'bootstrap'), workspaceId: 'workspace-checkpoint', ownerId: 'owner-checkpoint',
    upgradeStorage: true, assets: { html: '', javascript: '', css: '' }, port: 0,
    encryptionKey: new Uint8Array(32).fill(18), clock: () => now, syntheticMonitoring: {
      fixtureId: 'visa-beijing-group-v1', async createBrowserTransport(value) { context = value; return { tabId: 7,
        transport: { async inspect(request) { return { protocolVersion: 1, kind: 'result', requestId: request.requestId,
          profileId: request.profileId, connectionGeneration: request.connectionGeneration, epoch: request.epoch,
          serviceGeneration: request.serviceGeneration, origin: request.origin, tabId: request.tabId,
          sequence: request.sequence, documentId: 'checkpoint-document', pageState: 'login', snapshot: { state: 'login' } }; },
          async gesture() { throw new Error('checkpoint must not gesture'); }, async revoke() { revokes++; },
          async reconcileRevocation() {}, async close() {} } }; }
    } });
  t.after(() => service.shutdown());
  const armed = await pairAndArm(service, 'checkpoint');
  now += 3_000;
  let detail;
  for (let attempt = 0; attempt < 300; attempt++) {
    detail = (await requestControl(service.origin, 'GET', `/api/monitors/${armed.monitor.id}`, armed.token)).body;
    if (detail.status === 'paused') break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(detail.status, 'paused');
  assert.equal(detail.pauseReason, 'session_expired');
  assert.equal(detail.handoff.state, 'confirmed');
  assert.equal(revokes, 1);
  assert.equal(detail.handoff.id.length > 0, true);
  assert.equal(context.binding.profileId, detail.id.replace('monitor', `profile-${context.installationGeneration}`));
});

test('partial startup failure shuts down the composed browser before releasing storage', async t => {
  const blocker = createServer((_req, res) => res.end());
  await new Promise((resolve, reject) => blocker.once('error', reject).listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => blocker.close(resolve)));
  const address = blocker.address();
  const root = mkdtempSync(join(tmpdir(), 'behalvo-monitoring-startup-cleanup-')); chmodSync(root, 0o700);
  let revokes = 0; let closes = 0;
  await assert.rejects(() => startLocalService({ dbPath: join(root, 'service.db'),
    bootstrapDirectory: join(root, 'bootstrap'), workspaceId: 'workspace-cleanup', ownerId: 'owner-cleanup',
    upgradeStorage: true, assets: { html: '', javascript: '', css: '' }, port: address.port,
    encryptionKey: new Uint8Array(32).fill(19), syntheticMonitoring: {
      fixtureId: 'visa-beijing-group-v1', async createBrowserTransport() { return { tabId: 7, transport: {
        async inspect() { throw new Error('unused'); }, async gesture() { throw new Error('unused'); },
        async revoke() { revokes++; }, async reconcileRevocation() {}, async close() { closes++; }
      } }; }
    } }), /startup|listen|address/i);
  assert.equal(revokes, 1);
  assert.equal(closes, 1);
});

test('failed resume candidate retirement is durable and explicitly reconciled after restart', async () => {
  const store = new SqliteStore(':memory:', { serviceQueue: { upgradeExisting: true } });
  store.createWorkspace('workspace-candidate', 'owner-candidate');
  let context; let revokes = 0;
  const first = await createSyntheticMonitoringComposition({ store, workspaceId: 'workspace-candidate',
    ownerId: 'owner-candidate', serviceGeneration: 'service-candidate-a', clock: () => '2026-09-23T12:00:00.000Z',
    options: { fixtureId: 'visa-beijing-group-v1', async createBrowserTransport(value) { context = value; return { tabId: 7,
      transport: { async inspect(request) { return { protocolVersion: 1, kind: 'result', requestId: request.requestId,
        profileId: request.profileId, connectionGeneration: request.connectionGeneration, epoch: request.epoch,
        serviceGeneration: request.serviceGeneration, origin: request.origin, tabId: request.tabId,
        sequence: request.sequence, documentId: 'candidate-appointment', pageState: 'appointment', snapshot: {
          state: 'appointment', complete: true, booking: { referenceDigest: '9'.repeat(64), status: 'booked',
            rosterDigest: value.binding.rosterDigest, date: '2027-01-05', time: '09:00', location: 'Beijing',
            timeZone: 'Asia/Shanghai' } } }; }, async gesture() { throw new Error('resume must not gesture'); },
        async revoke() { revokes++; if (revokes >= 2) throw new Error('lost candidate retirement acknowledgement'); },
        async reconcileRevocation() {}, async close() {} } }; } } });
  let second;
  try {
    first.setup('candidate-setup');
    const proposed = first.propose('candidate-proposal', 'candidate-grant');
    const armed = first.arm('candidate-arm', proposed.grant.id, proposed.grant.digest, proposed.grant.revision);
    const paused = first.service.pauseMonitor({ ownerId: 'owner-candidate', monitorId: armed.monitor.id,
      digest: armed.grant.digest, revision: armed.grant.revision, controlRevision: 0, reason: 'owner_paused',
      binding: { ...first.session.epoch, tabId: 7 } });
    await first.session.transferToHuman('owner_paused');
    const settled = first.service.settleMonitorHandoff({ monitorId: paused.id,
      handoffId: paused.control.handoff.id, state: 'confirmed' });
    const admitted = store.admitMonitorResumeJob({ workspaceId: 'workspace-candidate', source: 'owner:service',
      requestId: 'candidate-resume', ownerId: 'owner-candidate', instanceId: 'runtime-a',
      serviceGeneration: 'service-candidate-a', installationGeneration: armed.grant.installationGeneration,
      at: '2026-09-23T12:00:00.000Z', envelope: { kind: 'monitor', purpose: 'resume', monitorId: settled.id,
        grantId: armed.grant.id, digest: armed.grant.digest, revision: armed.grant.revision,
        controlRevision: settled.control.revision, recoverHandoff: false } });
    const running = store.claimServiceJob('workspace-candidate', 'worker-a', '2026-09-23T12:00:00.000Z');
    await first.service.runJob(running, { serviceGeneration: 'service-candidate-a', deadline: Date.now() + 10_000,
      signal: new AbortController().signal, async assertCurrent() {}, assertSettlementCurrent() {} });
    const durable = store.state('workspace-candidate').monitors[armed.monitor.id];
    assert.equal(store.serviceJob('workspace-candidate', admitted.job.id).status, 'stopped');
    assert.equal(durable.control.handoff.state, 'failed');
    assert.notEqual(durable.control.handoff.binding.epoch, paused.control.handoff.binding.epoch);
    const failedEpoch = durable.control.handoff.binding.epoch;
    await first.session.shutdown();
    const reconciled = [];
    second = await createSyntheticMonitoringComposition({ store, workspaceId: 'workspace-candidate',
      ownerId: 'owner-candidate', serviceGeneration: 'service-candidate-b', clock: () => '2026-09-23T12:00:01.000Z',
      options: { fixtureId: 'visa-beijing-group-v1', async createBrowserTransport(value) { return { tabId: 7,
        transport: { async inspect(request) { return { protocolVersion: 1, kind: 'result', requestId: request.requestId,
          profileId: request.profileId, connectionGeneration: request.connectionGeneration, epoch: request.epoch,
          serviceGeneration: request.serviceGeneration, origin: request.origin, tabId: request.tabId,
          sequence: request.sequence, documentId: 'candidate-calendar', pageState: 'calendar', snapshot: {
            state: 'calendar', contractVersion: 1, location: 'Beijing', timeZone: 'Asia/Shanghai',
            startDate: '2026-12-15', endDate: '2027-01-31', identityDigest: value.binding.identityDigest,
            subjectDigest: value.binding.subjectDigest, rosterDigest: value.binding.rosterDigest,
            termsDigest: value.binding.termsDigest, termsVersion: value.binding.termsVersion,
            appointmentAbsent: true, page: 1, hasNext: false, candidates: [] } }; },
          async gesture() { throw new Error('resume must not gesture'); }, async revoke() {},
          async reconcileRevocation(epoch, tabId) { reconciled.push({ epoch, tabId }); }, async close() {} } }; } } });
    const beforeRecovery = store.state('workspace-candidate').monitors[armed.monitor.id];
    const recovery = store.admitMonitorResumeJob({ workspaceId: 'workspace-candidate', source: 'owner:service',
      requestId: 'candidate-recovery', ownerId: 'owner-candidate', instanceId: 'runtime-b',
      serviceGeneration: 'service-candidate-b', installationGeneration: armed.grant.installationGeneration,
      at: '2026-09-23T12:00:01.000Z', envelope: { kind: 'monitor', purpose: 'resume', monitorId: beforeRecovery.id,
        grantId: armed.grant.id, digest: armed.grant.digest, revision: armed.grant.revision,
        controlRevision: beforeRecovery.control.revision, recoverHandoff: true } });
    const recoveryJob = store.claimServiceJob('workspace-candidate', 'worker-b', '2026-09-23T12:00:01.000Z');
    await second.service.runJob(recoveryJob, { serviceGeneration: 'service-candidate-b', deadline: Date.now() + 10_000,
      signal: new AbortController().signal, async assertCurrent() {}, assertSettlementCurrent() {} });
    assert.equal(store.serviceJob('workspace-candidate', recovery.job.id).status, 'finished');
    assert.equal(store.state('workspace-candidate').monitors[armed.monitor.id].status, 'active');
    assert.equal(reconciled.length, 1);
    assert.equal(reconciled[0].epoch.epoch, failedEpoch);
  } finally { await second?.session.shutdown(); await first.session.shutdown(); store.close(); }
});

test('reviewed arm plan rejects changed work or connection and is enforced at later admission boundaries', async () => {
  const changedBeforeArm = await compositionFixture();
  try {
    changedBeforeArm.composition.setup('setup-arm-drift');
    const proposed = changedBeforeArm.composition.propose('proposal-arm-drift', 'grant-arm-drift');
    const evidenceRef = changedBeforeArm.store.putArtifact('workspace-composition', 'Changed after review.');
    let state = changedBeforeArm.store.state('workspace-composition');
    changedBeforeArm.store.append('workspace-composition', state.version, [{ type: 'work.phase_changed', data: {
      id: 'synthetic-visa-work', phase: 'waiting_external', evidenceRef } }], { recordedAt: '2026-09-23T12:00:00.000Z' });
    assert.throws(() => changedBeforeArm.composition.arm('arm-drift', proposed.grant.id,
      proposed.grant.digest, proposed.grant.revision), /plan|work|binding/i);
  } finally { await changedBeforeArm.composition.session.shutdown(); changedBeforeArm.store.close(); }

  const changedConnection = await compositionFixture();
  try {
    changedConnection.composition.setup('setup-connection-drift');
    const proposed = changedConnection.composition.propose('proposal-connection-drift', 'grant-connection-drift');
    const state = changedConnection.store.state('workspace-composition');
    changedConnection.store.append('workspace-composition', state.version,
      [{ type: 'connection.revoked', data: { id: 'synthetic-visa-connection', generation: 2 } }],
      { recordedAt: '2026-09-23T12:00:00.000Z' });
    assert.throws(() => changedConnection.composition.arm('arm-connection-drift', proposed.grant.id,
      proposed.grant.digest, proposed.grant.revision), /plan|connection|binding/i);
  } finally { await changedConnection.composition.session.shutdown(); changedConnection.store.close(); }

  const laterDrift = await compositionFixture();
  try {
    laterDrift.composition.setup('setup-later-drift');
    const proposed = laterDrift.composition.propose('proposal-later-drift', 'grant-later-drift');
    laterDrift.composition.arm('arm-later-drift', proposed.grant.id, proposed.grant.digest, proposed.grant.revision);
    const evidenceRef = laterDrift.store.putArtifact('workspace-composition', 'Changed after activation.');
    let state = laterDrift.store.state('workspace-composition');
    laterDrift.store.append('workspace-composition', state.version, [{ type: 'work.phase_changed', data: {
      id: 'synthetic-visa-work', phase: 'waiting_external', evidenceRef } }], { recordedAt: '2026-09-23T12:00:00.000Z' });
    assert.deepEqual(laterDrift.composition.service.admitDueMonitors({ instanceId: 'scheduler',
      at: '2026-09-23T12:00:03.000Z', limit: 1 }), { queued: 0, budgetDeferred: 0, unchanged: 1, full: false });
  } finally { await laterDrift.composition.session.shutdown(); laterDrift.store.close(); }

  const resumeDrift = await compositionFixture();
  try {
    resumeDrift.composition.setup('setup-resume-drift');
    const proposed = resumeDrift.composition.propose('proposal-resume-drift', 'grant-resume-drift');
    const armed = resumeDrift.composition.arm('arm-resume-drift', proposed.grant.id,
      proposed.grant.digest, proposed.grant.revision);
    const paused = resumeDrift.composition.service.pauseMonitor({ ownerId: 'owner-composition',
      monitorId: armed.monitor.id, digest: armed.grant.digest, revision: armed.grant.revision, controlRevision: 0,
      reason: 'owner_paused', binding: { ...resumeDrift.composition.session.epoch, tabId: 7 } });
    const settled = resumeDrift.composition.service.settleMonitorHandoff({ monitorId: paused.id,
      handoffId: paused.control.handoff.id, state: 'confirmed' });
    const evidenceRef = resumeDrift.store.putArtifact('workspace-composition', 'Changed while human owned.');
    const state = resumeDrift.store.state('workspace-composition');
    resumeDrift.store.append('workspace-composition', state.version, [{ type: 'work.phase_changed', data: {
      id: 'synthetic-visa-work', phase: 'waiting_external', evidenceRef } }], { recordedAt: '2026-09-23T12:00:00.000Z' });
    assert.throws(() => resumeDrift.store.admitMonitorResumeJob({ workspaceId: 'workspace-composition',
      source: 'owner:service', requestId: 'resume-drift', ownerId: 'owner-composition', instanceId: 'runtime',
      serviceGeneration: 'service-composition', installationGeneration: armed.grant.installationGeneration,
      at: '2026-09-23T12:00:00.000Z', envelope: { kind: 'monitor', purpose: 'resume', monitorId: settled.id,
        grantId: armed.grant.id, digest: armed.grant.digest, revision: armed.grant.revision,
        controlRevision: settled.control.revision, recoverHandoff: false } }), /plan|work|binding|resume/i);
  } finally { await resumeDrift.composition.session.shutdown(); resumeDrift.store.close(); }
});

test('synthetic proposal is unique while live and legally replaces a terminal unreserved grant', async () => {
  const f = await compositionFixture();
  try {
    f.composition.setup('setup-replacement');
    const first = f.composition.propose('proposal-first', 'grant-first');
    assert.throws(() => f.composition.propose('proposal-overlap', 'grant-overlap'), /existing|authority|grant/i);
    const armed = f.composition.arm('arm-first', first.grant.id, first.grant.digest, first.grant.revision);
    f.composition.service.revokeGrantForOwner({ ownerId: 'owner-composition', source: 'owner:service',
      requestId: 'revoke-first', grantId: armed.grant.id, digest: armed.grant.digest,
      revision: armed.grant.revision, kind: 'monitoring_revoke' });
    const replacement = f.composition.propose('proposal-replacement', 'grant-replacement');
    const rearmed = f.composition.arm('arm-replacement', replacement.grant.id,
      replacement.grant.digest, replacement.grant.revision);
    assert.equal(rearmed.grant.status, 'active');
    assert.equal(rearmed.monitor.grantId, replacement.grant.id);
  } finally { await f.composition.session.shutdown(); f.store.close(); }
});

test('terminal replacement preserves historical poll provenance across encrypted backup and reopen',
    { skip: process.platform === 'win32' }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'behalvo-monitoring-replacement-history-')); chmodSync(root, 0o700);
  const path = join(root, 'service.db'); const key = new Uint8Array(32).fill(27);
  const store = new SqliteStore(path, { encryptionKey: key, serviceQueue: { upgradeExisting: true } });
  store.createWorkspace('workspace-history', 'owner-history');
  const composition = await createSyntheticMonitoringComposition({ store, workspaceId: 'workspace-history',
    ownerId: 'owner-history', serviceGeneration: 'service-history', clock: () => '2026-09-23T12:00:00.000Z',
    options: { fixtureId: 'visa-beijing-group-v1', async createBrowserTransport() { return { tabId: 7, transport: {
      async inspect(request) { return { protocolVersion: 1, kind: 'result', requestId: request.requestId,
        profileId: request.profileId, connectionGeneration: request.connectionGeneration, epoch: request.epoch,
        serviceGeneration: request.serviceGeneration, origin: request.origin, tabId: request.tabId,
        sequence: request.sequence, documentId: 'history-login', pageState: 'login', snapshot: { state: 'login' } }; },
      async gesture() { throw new Error('checkpoint poll must not gesture'); }, async revoke() {},
      async reconcileRevocation() {}, async close() {}
    } }; } } });
  let firstJobId; let replacementGrantId;
  try {
    composition.setup('history-setup');
    const first = composition.propose('history-proposal-first', 'history-grant-first');
    const armed = composition.arm('history-arm-first', first.grant.id, first.grant.digest, first.grant.revision);
    assert.equal(composition.service.admitDueMonitors({ instanceId: 'history-scheduler',
      at: '2026-09-23T12:00:03.000Z', limit: 1 }).queued, 1);
    const running = store.claimServiceJob('workspace-history', 'history-worker', '2026-09-23T12:00:03.000Z');
    firstJobId = running.id;
    await composition.service.runJob(running, { serviceGeneration: 'service-history', deadline: Date.now() + 10_000,
      signal: new AbortController().signal, async assertCurrent() {}, assertSettlementCurrent() {} });
    assert.equal(store.serviceJob('workspace-history', firstJobId).status, 'stopped');
    composition.service.revokeGrantForOwner({ ownerId: 'owner-history', source: 'owner:service',
      requestId: 'history-revoke-first', grantId: armed.grant.id, digest: armed.grant.digest,
      revision: armed.grant.revision, kind: 'monitoring_revoke' });
    const replacement = composition.propose('history-proposal-replacement', 'history-grant-replacement');
    replacementGrantId = replacement.grant.id;
    composition.arm('history-arm-replacement', replacement.grant.id,
      replacement.grant.digest, replacement.grant.revision);
    await store.backup(join(root, 'verified-backup.db'));
  } finally {
    await composition.session.shutdown();
    store.close();
  }

  const reopened = new SqliteStore(path, { encryptionKey: key, serviceQueue: { upgradeExisting: false } });
  assert.equal(reopened.serviceJob('workspace-history', firstJobId).parameters.grantId, 'history-grant-first');
  assert.equal(reopened.state('workspace-history').monitors['synthetic-visa-monitor'].grantId, replacementGrantId);
  reopened.close();

  const db = new DatabaseSync(path);
  const cipher = validateStorage(db, key);
  const row = db.prepare('SELECT * FROM service_jobs WHERE id=?').get(firstJobId);
  const tampered = JSON.parse(cipher.open(row.job_json, serviceJobContext(row)));
  tampered.parameters.grantId = replacementGrantId;
  db.prepare('UPDATE service_jobs SET job_json=? WHERE id=?')
    .run(cipher.seal(JSON.stringify(tampered), serviceJobContext(row)), firstJobId);
  db.close();
  const tamperedStore = new SqliteStore(path, { encryptionKey: key, serviceQueue: { upgradeExisting: false } });
  try {
    await assert.rejects(tamperedStore.backup(join(root, 'tampered-backup.db')), /private file operation failed/i);
  } finally { tamperedStore.close(); }
});

test('composed service shares the generated identity and arms only through paired exact review', async t => {
  const root = mkdtempSync(join(tmpdir(), 'behalvo-monitoring-service-')); chmodSync(root, 0o700);
  const dbPath = join(root, 'service.db'); const encryptionKey = new Uint8Array(32).fill(9);
  let context; let closes = 0; let revokes = 0; let failNextRevoke = false;
  let now = Date.parse('2026-09-23T12:00:00.000Z');
  let appointmentAbsent = true; let bindingDrift = false; const inspectSequences = []; const reconciled = [];
  const service = await startLocalService({ dbPath,
    bootstrapDirectory: join(root, 'bootstrap'), workspaceId: 'workspace-monitoring', ownerId: 'owner-monitoring',
    upgradeStorage: true, assets: { html: '', javascript: '', css: '' }, port: 0,
    encryptionKey, clock: () => now, syntheticMonitoring: {
      fixtureId: 'visa-beijing-group-v1', async createBrowserTransport(value) {
        context = value;
        return { tabId: 7, transport: {
          async inspect(request) {
            inspectSequences.push(request.sequence);
            const snapshot = appointmentAbsent ? { state: 'calendar', contractVersion: 1, location: 'Beijing',
              timeZone: 'Asia/Shanghai', startDate: '2026-12-15', endDate: '2027-01-31',
              identityDigest: context.binding.identityDigest, subjectDigest: context.binding.subjectDigest,
              rosterDigest: bindingDrift ? '8'.repeat(64) : context.binding.rosterDigest,
              termsDigest: context.binding.termsDigest,
              termsVersion: context.binding.termsVersion, appointmentAbsent: true, page: 1,
              hasNext: false, candidates: [] } : { state: 'appointment', complete: true, booking: {
                referenceDigest: '9'.repeat(64), status: 'booked', rosterDigest: context.binding.rosterDigest,
                date: '2027-01-05', time: '09:00', location: 'Beijing', timeZone: 'Asia/Shanghai' } };
            return { protocolVersion: 1, kind: 'result', requestId: request.requestId,
              profileId: request.profileId, connectionGeneration: request.connectionGeneration,
              epoch: request.epoch, serviceGeneration: request.serviceGeneration, origin: request.origin,
              tabId: request.tabId, sequence: request.sequence, documentId: 'resume-document',
              pageState: snapshot.state, snapshot };
          }, async gesture() { throw new Error('resume must not gesture'); },
          async revoke() { revokes++; if (failNextRevoke) { failNextRevoke = false; throw new Error('lost revoke acknowledgement'); } },
          async reconcileRevocation(epoch, tabId) { reconciled.push({ epoch, tabId }); },
          async close() { closes++; }
        } };
      }
    } });
  t.after(() => service.shutdown());
  assert.match(context.serviceGeneration, /^[0-9a-f-]{36}$/);
  assert.ok(context.installationGeneration);
  assert.equal(context.binding.profileId, `synthetic-visa-profile-${context.installationGeneration}`);
  const bootstrap = JSON.parse(readFileSync(service.bootstrapPath, 'utf8'));
  const paired = await requestControl(service.origin, 'POST', '/api/session/bootstrap', bootstrap.token, {});
  const token = paired.body.token;
  const setup = await requestControl(service.origin, 'POST', '/api/monitoring/synthetic/setup', token,
    { requestId: 'setup-1', fixtureId: 'visa-beijing-group-v1' });
  assert.equal(setup.status, 200); assert.equal(setup.body.duplicate, false);
  assert.equal(setup.body.receipt.requestId, 'setup-1');
  const setupDuplicate = await requestControl(service.origin, 'POST', '/api/monitoring/synthetic/setup', token,
    { requestId: 'setup-1', fixtureId: 'visa-beijing-group-v1' });
  assert.equal(setupDuplicate.status, 200); assert.equal(setupDuplicate.body.duplicate, true);
  const proposed = await requestControl(service.origin, 'POST', '/api/grants', token,
    { requestId: 'proposal-1', fixtureId: 'visa-beijing-group-v1' });
  assert.equal(proposed.status, 200);
  assert.equal(proposed.body.receipt.requestId, 'proposal-1');
  const proposedDuplicate = await requestControl(service.origin, 'POST', '/api/grants', token,
    { requestId: 'proposal-1', fixtureId: 'visa-beijing-group-v1' });
  assert.equal(proposedDuplicate.status, 200); assert.equal(proposedDuplicate.body.duplicate, true);
  const grant = proposed.body.grant;
  const review = await requestControl(service.origin, 'POST', `/api/grants/${grant.id}/review`, token, {});
  assert.equal(review.status, 200); assert.equal(review.body.canArm, true);
  const ordinary = await requestControl(service.origin, 'POST', `/api/grants/${grant.id}/arm`, token,
    { requestId: 'arm-wrong', digest: grant.digest, revision: grant.revision,
      armToken: token });
  assert.equal(ordinary.status, 409);
  now += 120_001;
  const expired = await requestControl(service.origin, 'POST', `/api/grants/${grant.id}/arm`, token,
    { requestId: 'arm-expired', digest: grant.digest, revision: grant.revision,
      armToken: review.body.armToken });
  assert.equal(expired.status, 409);
  const freshReview = await requestControl(service.origin, 'POST', `/api/grants/${grant.id}/review`, token, {});
  const armed = await requestControl(service.origin, 'POST', `/api/grants/${grant.id}/arm`, token,
    { requestId: 'arm-1', digest: grant.digest, revision: grant.revision, armToken: freshReview.body.armToken });
  assert.equal(armed.status, 200); assert.equal(armed.body.grant.status, 'active');
  assert.equal(armed.body.receipt.requestId, 'arm-1');
  assert.equal(armed.body.monitor.polling.intervalMs, 2000);
  assert.equal((await requestControl(service.origin, 'POST', `/api/grants/${grant.id}/arm`, token,
    { requestId: 'arm-1', digest: grant.digest, revision: grant.revision, armToken: freshReview.body.armToken })).body.duplicate, true);
  assert.equal((await requestControl(service.origin, 'POST', `/api/grants/${grant.id}/arm`, token,
    { requestId: 'arm-replay', digest: grant.digest, revision: grant.revision,
      armToken: freshReview.body.armToken })).status, 409);
  const paused = await requestControl(service.origin, 'POST', `/api/monitors/${armed.body.monitor.id}/pause`, token,
    { requestId: 'pause-1', digest: grant.digest, revision: grant.revision, controlRevision: 0 });
  assert.equal(paused.status, 200);
  assert.equal(paused.body.monitor.status, 'paused');
  assert.equal(paused.body.monitor.handoff.state, 'confirmed');
  assert.equal(revokes, 1);
  const pauseDuplicate = await requestControl(service.origin, 'POST', `/api/monitors/${armed.body.monitor.id}/pause`, token,
    { requestId: 'pause-1', digest: grant.digest, revision: grant.revision, controlRevision: 0 });
  assert.equal(pauseDuplicate.status, 200);
  assert.equal(pauseDuplicate.body.duplicate, true);
  assert.equal(pauseDuplicate.body.receipt.requestId, 'pause-1');
  assert.equal(revokes, 1);
  const resumed = await requestControl(service.origin, 'POST', `/api/monitors/${armed.body.monitor.id}/resume`, token,
    { requestId: 'resume-1', digest: grant.digest, revision: grant.revision,
      controlRevision: paused.body.monitor.controlRevision, recoverHandoff: false });
  assert.equal(resumed.status, 202); assert.equal(resumed.body.duplicate, false);
  let resumedMonitor;
  for (let attempt = 0; attempt < 100; attempt++) {
    const detail = await requestControl(service.origin, 'GET', `/api/monitors/${armed.body.monitor.id}`, token);
    resumedMonitor = detail.body;
    if (resumedMonitor.status === 'active') break;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.equal(resumedMonitor.status, 'active');
  assert.deepEqual(inspectSequences, [1, 2]);
  const resumedJob = await requestControl(service.origin, 'GET', `/api/jobs/${resumed.body.job.id}`, token);
  assert.equal(resumedJob.body.monitoring.resumeReason, 'preflight_passed');
  assert.equal(resumedJob.body.monitoring.resumeEvidence.appointmentAbsent, true);
  assert.equal(resumedJob.body.monitoring.resumeEvidence.pageState, 'calendar');
  assert.match(resumedJob.body.monitoring.resumeEvidence.evidenceDigest, /^[a-f0-9]{64}$/);
  appointmentAbsent = false;
  failNextRevoke = true;
  const pausedAgain = await requestControl(service.origin, 'POST', `/api/monitors/${armed.body.monitor.id}/pause`, token,
    { requestId: 'pause-2', digest: grant.digest, revision: grant.revision,
      controlRevision: resumedMonitor.controlRevision });
  assert.equal(pausedAgain.status, 200);
  assert.equal(pausedAgain.body.monitor.handoff.state, 'failed');
  const blockedResume = await requestControl(service.origin, 'POST', `/api/monitors/${armed.body.monitor.id}/resume`, token,
    { requestId: 'resume-needs-recovery', digest: grant.digest, revision: grant.revision,
      controlRevision: pausedAgain.body.monitor.controlRevision, recoverHandoff: false });
  assert.equal(blockedResume.status, 409);
  const deniedResume = await requestControl(service.origin, 'POST', `/api/monitors/${armed.body.monitor.id}/resume`, token,
    { requestId: 'resume-manual-booking', digest: grant.digest, revision: grant.revision,
      controlRevision: pausedAgain.body.monitor.controlRevision, recoverHandoff: true });
  assert.equal(deniedResume.status, 202);
  let deniedMonitor;
  for (let attempt = 0; attempt < 100; attempt++) {
    const detail = await requestControl(service.origin, 'GET', `/api/monitors/${armed.body.monitor.id}`, token);
    deniedMonitor = detail.body;
    if (deniedMonitor.resume === null) break;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.equal(deniedMonitor.status, 'paused');
  assert.deepEqual(inspectSequences, [1, 2, 1, 2]);
  const manualJob = await requestControl(service.origin, 'GET', `/api/jobs/${deniedResume.body.job.id}`, token);
  assert.equal(manualJob.body.result.reason, 'monitor_resume_rejected');
  assert.equal(manualJob.body.monitoring.resumeReason, 'existing_appointment');
  assert.equal(reconciled.length, 1);
  assert.equal(reconciled[0].tabId, 7);
  assert.equal(reconciled[0].epoch.profileId, context.binding.profileId);
  appointmentAbsent = true; bindingDrift = true;
  const driftedResume = await requestControl(service.origin, 'POST', `/api/monitors/${armed.body.monitor.id}/resume`, token,
    { requestId: 'resume-binding-drift', digest: grant.digest, revision: grant.revision,
      controlRevision: deniedMonitor.controlRevision, recoverHandoff: false });
  assert.equal(driftedResume.status, 202);
  let driftedMonitor;
  for (let attempt = 0; attempt < 100; attempt++) {
    driftedMonitor = (await requestControl(service.origin, 'GET', `/api/monitors/${armed.body.monitor.id}`, token)).body;
    if (driftedMonitor.resume === null) break;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.equal(driftedMonitor.status, 'paused');
  const driftedJob = await requestControl(service.origin, 'GET', `/api/jobs/${driftedResume.body.job.id}`, token);
  assert.equal(driftedJob.body.monitoring.resumeReason, 'binding_changed');
  assert.deepEqual(inspectSequences, [1, 2, 1, 2, 1, 2]);
  const stopped = await requestControl(service.origin, 'POST', `/api/monitors/${armed.body.monitor.id}/stop`, token,
    { requestId: 'stop-1', digest: grant.digest, revision: grant.revision,
      controlRevision: driftedMonitor.controlRevision });
  assert.equal(stopped.status, 200);
  assert.equal(stopped.body.grant.status, 'revoked');
  assert.equal(stopped.body.receipt.requestId, 'stop-1');
  const stoppedDuplicate = await requestControl(service.origin, 'POST', `/api/monitors/${armed.body.monitor.id}/stop`, token,
    { requestId: 'stop-1', digest: grant.digest, revision: grant.revision,
      controlRevision: driftedMonitor.controlRevision });
  assert.equal(stoppedDuplicate.status, 200);
  assert.equal(stoppedDuplicate.body.duplicate, true);
  assert.equal(await service.shutdown(), true); assert.equal(closes, 1);
  const reopened = new SqliteStore(dbPath, { encryptionKey, serviceQueue: { upgradeExisting: false } });
  try { await reopened.backup(join(root, 'verified-backup.db')); } finally { reopened.close(); }
});
