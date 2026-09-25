import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { validateMonitoredReservationJournal } from '../dist/monitoring/invariants.js';
import {
  monitoredActionCommandDigest, MonitoringRegistry, MonitoringService, Operator, recoverLocalService,
  observationDigest, reduce, ServiceRuntime, SqliteStore
} from '../dist/index.js';

const workspaceId = 'monitoring-service';
const ownerId = 'owner';
const base = Date.parse('2026-09-21T12:00:00.000Z');
const subjectDigest = 'd'.repeat(64);

function iso(milliseconds) { return new Date(milliseconds).toISOString(); }

function fixture(options = {}) {
  const clock = options.clock ?? { milliseconds: base };
  const store = options.store ?? new SqliteStore(':memory:', { serviceQueue: { upgradeExisting: false } });
  if (!options.existing) {
    store.createWorkspace(workspaceId, ownerId);
    new Operator(store, () => iso(clock.milliseconds)).createWork(workspaceId, ownerId, {
      id: 'work', title: 'Synthetic monitor', goal: 'Observe safely', threadId: 'thread'
    });
    store.append(workspaceId, store.state(workspaceId).version, [{ type: 'connection.registered', data: { connection: {
      id: 'connection-a', provider: options.reviewedPlan ? 'visa-scheduling' : 'synthetic-provider',
      subject: options.reviewedPlan ? 'synthetic-account' : 'synthetic-subject', label: 'Synthetic',
      generation: 1, status: 'active'
    } } }], { actorId: ownerId, recordedAt: iso(clock.milliseconds) });
  }
  const observations = options.observations ?? [];
  let inspectCalls = 0;
  const registry = new MonitoringRegistry();
  registry.register({
    id: 'synthetic.observe', version: 1,
    validateScope(value) { return value; },
    coverageSufficient(_scope, coverage) { return coverage?.complete === true; },
    selectCommand({ grant, observation }) {
      options.beforeSelection?.();
      const selected = observation.candidates[0];
      if (!selected) return undefined;
      return {
        kind: 'operation.execute', operationId: grant.adapter, operationVersion: String(grant.adapterVersion),
        connectionId: grant.connectionId, provider: options.reviewedPlan ? 'visa-scheduling' : 'synthetic-provider',
        subject: options.reviewedPlan ? 'synthetic-account' : 'synthetic-subject',
        connectionGeneration: 1, resourceId: 'resource', arguments: selected, affectedResourceIds: ['resource'],
        precondition: { state: {}, source: 'synthetic-monitor', observedAt: observation.observedAt },
        expectedResult: selected, subjectRevision: options.subjectRevision ?? 0, requestFingerprint: 'e'.repeat(64)
      };
    },
    async inspect(input) {
      inspectCalls++;
      const next = observations.shift();
      if (!next) throw new Error('No synthetic observation configured');
      return typeof next === 'function' ? next(input) : next;
    },
    ...(options.executeReserved ? { executeReserved: options.executeReserved } : {})
  });
  const monitoring = new MonitoringService(store, registry, {
    workspaceId, ownerId, installationGeneration: 'installation-a',
    clock: () => iso(clock.milliseconds), random: options.random ?? (() => 0.5),
    ...(options.resumeHandler ? { resumeHandler: options.resumeHandler } : {})
  });
  if (!options.existing) {
    const grant = monitoring.proposeGrant({
      id: 'grant-1', workspaceId, ownerId, adapter: 'synthetic.observe', adapterVersion: 1,
      connectionId: 'connection-a', connectionGeneration: 1, browserProfileId: 'profile-a', subjectDigest,
      scope: { operation: 'observe' }, maximumEffects: 1, expiresAt: iso(base + 86_400_000),
      ...(options.reviewedPlan ? { armPlan: options.reviewedPlan } : {})
    });
    monitoring.activateGrant({ ownerId, grantId: grant.id, digest: grant.digest, revision: grant.revision });
  }
  const counters = { model: 0, effect: 0 };
  const agent = { async processAdmittedOwnerTurn() { counters.model++; throw new Error('model must not run'); } };
  const operations = {
    async execute() { counters.effect++; throw new Error('effect must not run'); },
    async verify() { counters.effect++; throw new Error('provider readback must not run'); }
  };
  const runtime = new ServiceRuntime(store, agent, operations, {
    workspaceId, ownerId, instanceId: 'runtime-a', serviceGeneration: 'service-generation-a',
    clock: () => iso(clock.milliseconds), monitoring, timeoutMs: options.timeoutMs
  });
  return { store, registry, monitoring, runtime, observations, inspectCalls: () => inspectCalls, counters, clock };
}

function configure(f, extra = {}) {
  return f.monitoring.configureMonitor({ ownerId, id: extra.id ?? 'monitor-1', grantId: 'grant-1', workId: 'work',
    nextDueAt: extra.nextDueAt ?? iso(f.clock.milliseconds), maxObservationAgeMs: 60_000,
    intervalMs: extra.intervalMs ?? 60_000, jitterMs: extra.jitterMs ?? 5_000,
    requestBudget: extra.requestBudget ?? 3, requestWindowMs: extra.requestWindowMs ?? 300_000,
    backoffBaseMs: extra.backoffBaseMs ?? 60_000, backoffMaxMs: extra.backoffMaxMs ?? 600_000,
    ...(extra.control ? { control: extra.control } : {}) });
}

function complete(at, extra = {}) {
  return { observedAt: at, complete: true, coverage: { complete: true }, candidates: [], result: 'complete', ...extra };
}

function eligible(at) { return complete(at, { candidates: [{ city: 'Beijing' }] }); }

const reviewedPolling = { maxObservationAgeMs: 60_000, intervalMs: 2_000, jitterMs: 250,
  requestBudget: 30, requestWindowMs: 60_000, backoffBaseMs: 2_000, backoffMaxMs: 60_000 };
const reviewedPlan = { version: 1, fixtureId: 'visa-beijing-group-v1', monitorId: 'monitor-1', workId: 'work',
  workRevision: 1, termsVersion: 'terms-1', polling: reviewedPolling, stopPolicy: 'synthetic-visa-one-effect-v1' };

function currentFence() {
  return { serviceGeneration: 'service-generation-a', deadline: Date.now() + 10_000,
    signal: new AbortController().signal, async assertCurrent() {}, assertSettlementCurrent() {} };
}

function fillQueue(store, count, prefix = 'queued') {
  for (let index = 0; index < count; index++) store.admitOwnerTurnJob({
    workspaceId, source: 'owner:service', requestId: `${prefix}-${index}`, ownerId,
    envelope: { kind: 'owner_turn', threadId: 'thread', text: `Synthetic queued turn ${index}` },
    accepted: { threadId: 'thread', workId: 'work', model: { provider: 'fake', model: 'fake' },
      windowTokens: 1_000, outputReserve: 100, capability: 'prepare_only' },
    instanceId: 'queue-fixture', at: iso(base)
  });
}

async function enqueueScheduled(f) {
  configure(f, { jitterMs: 0 });
  f.monitoring.admitDueMonitors({ instanceId: 'scheduler', at: iso(f.clock.milliseconds), limit: 1 });
  const monitorJob = f.store.claimServiceJob(workspaceId, 'monitor-worker', iso(f.clock.milliseconds));
  await f.monitoring.runJob(monitorJob, currentFence());
  return f.store.serviceJobs(workspaceId).items.find(job => job.kind === 'execute');
}

test('overdue monitor checks coalesce into one durable single-flight job', () => {
  const f = fixture();
  try {
    configure(f, { nextDueAt: iso(base - 3_600_000) });
    const first = f.monitoring.admitDueMonitors({ instanceId: 'scheduler-a', at: iso(base), limit: 100 });
    const second = f.monitoring.admitDueMonitors({ instanceId: 'scheduler-b', at: iso(base), limit: 100 });
    assert.equal(first.queued, 1);
    assert.equal(second.queued, 0);
    assert.equal(f.store.serviceQueueCounts(workspaceId).queued, 1);
    const job = f.store.serviceJobs(workspaceId).items[0];
    assert.equal(job.kind, 'monitor');
    assert.equal(job.parameters.monitorId, 'monitor-1');
    assert.equal(f.store.claimServiceJob(workspaceId, 'worker-a', iso(base)).id, job.id);
    assert.equal(f.store.claimServiceJob(workspaceId, 'worker-b', iso(base)), undefined);
  } finally { f.store.close(); }
});

test('startup interrupts an old queued resume without browser I/O or recurrence', () => {
  const f = fixture();
  try {
    configure(f, { control: { version: 1, revision: 0, handoff: null, resume: null } });
    const grant = f.monitoring.grant('grant-1');
    const paused = f.monitoring.pauseMonitor({ ownerId, monitorId: 'monitor-1', digest: grant.digest,
      revision: grant.revision, controlRevision: 0, reason: 'owner_paused',
      binding: { profileId: 'profile-a', connectionGeneration: 1, epoch: 'a'.repeat(64),
        serviceGeneration: 'old-service', allowedOrigin: 'http://127.0.0.1:43117', tabId: 7 } });
    const settled = f.monitoring.settleMonitorHandoff({ monitorId: paused.id,
      handoffId: paused.control.handoff.id, state: 'confirmed' });
    const admitted = f.store.admitMonitorResumeJob({ workspaceId, source: 'owner:service', requestId: 'resume-old',
      ownerId, instanceId: 'old-instance', serviceGeneration: 'old-service',
      installationGeneration: grant.installationGeneration, at: iso(base), envelope: { kind: 'monitor', purpose: 'resume',
        monitorId: settled.id, grantId: grant.id, digest: grant.digest, revision: grant.revision,
        controlRevision: settled.control.revision, recoverHandoff: false } });
    assert.equal(admitted.job.status, 'queued');
    assert.deepEqual(f.store.inspectInterruptedServiceJobs(workspaceId, iso(base + 1)), { repaired: 1, interrupted: 0 });
    const recovered = f.store.serviceJob(workspaceId, admitted.job.id);
    assert.equal(recovered.status, 'interrupted');
    assert.equal(recovered.result.reason, 'process_interrupted');
    const monitor = f.store.state(workspaceId).monitors['monitor-1'];
    assert.equal(monitor.status, 'paused');
    assert.equal(monitor.nextDueAt, null);
    assert.equal(f.inspectCalls(), 0);
  } finally { f.store.close(); }
});

test('owner pause atomically terminalizes queued and running observe or resume jobs', async t => {
  for (const purpose of ['observe', 'resume']) for (const status of ['queued', 'running']) await t.test(`${purpose}-${status}`, () => {
    const f = fixture({ resumeHandler: async () => { throw new Error('resume handler must not run'); } });
    try {
      configure(f, { control: { version: 1, revision: 0, handoff: null, resume: null } });
      const grant = f.monitoring.grant('grant-1');
      if (purpose === 'observe') {
        f.monitoring.admitDueMonitors({ instanceId: 'scheduler', at: iso(base), limit: 1 });
      } else {
        const paused = f.monitoring.pauseMonitor({ ownerId, monitorId: 'monitor-1', digest: grant.digest,
          revision: grant.revision, controlRevision: 0, reason: 'owner_paused',
          binding: { profileId: 'profile-a', connectionGeneration: 1, epoch: 'a'.repeat(64),
            serviceGeneration: 'service-generation-a', allowedOrigin: 'http://127.0.0.1:43117', tabId: 7 } });
        const settled = f.monitoring.settleMonitorHandoff({ monitorId: paused.id,
          handoffId: paused.control.handoff.id, state: 'confirmed' });
        f.store.admitMonitorResumeJob({ workspaceId, source: 'owner:service', requestId: `resume-${status}`,
          ownerId, instanceId: 'runtime-a', serviceGeneration: 'service-generation-a',
          installationGeneration: grant.installationGeneration, at: iso(base), envelope: { kind: 'monitor', purpose: 'resume',
            monitorId: settled.id, grantId: grant.id, digest: grant.digest, revision: grant.revision,
            controlRevision: settled.control.revision, recoverHandoff: false } });
      }
      const queued = f.store.serviceJobs(workspaceId).items.at(-1);
      const job = status === 'running' ? f.store.claimServiceJob(workspaceId, 'worker', iso(base)) : queued;
      const current = f.store.state(workspaceId).monitors['monitor-1'];
      const paused = f.monitoring.pauseMonitorForOwner({ ownerId, source: 'owner:service',
        requestId: `pause-${purpose}-${status}`, monitorId: current.id, digest: grant.digest,
        revision: grant.revision, controlRevision: current.control.revision, reason: 'owner_paused',
        binding: { profileId: 'profile-a', connectionGeneration: 1, epoch: 'b'.repeat(64),
          serviceGeneration: 'service-generation-a', allowedOrigin: 'http://127.0.0.1:43117', tabId: 7 } });
      assert.equal(paused.monitor.status, 'paused');
      assert.equal(paused.monitor.inFlightJobId, null);
      const stopped = f.store.serviceJob(workspaceId, job.id);
      assert.equal(stopped.status, 'stopped');
      assert.equal(stopped.result.reason, 'monitor_paused');
    } finally { f.store.close(); }
  });
});

test('resume drift before handler execution terminalizes the claim and remains paused', async t => {
  let handlerCalls = 0;
  const f = fixture({ resumeHandler: async () => { handlerCalls++; } });
  t.after(() => f.store.close());
  configure(f, { control: { version: 1, revision: 0, handoff: null, resume: null } });
  const grant = f.monitoring.grant('grant-1');
  const paused = f.monitoring.pauseMonitor({ ownerId, monitorId: 'monitor-1', digest: grant.digest,
    revision: grant.revision, controlRevision: 0, reason: 'owner_paused',
    binding: { profileId: 'profile-a', connectionGeneration: 1, epoch: 'a'.repeat(64),
      serviceGeneration: 'service-generation-a', allowedOrigin: 'http://127.0.0.1:43117', tabId: 7 } });
  const settled = f.monitoring.settleMonitorHandoff({ monitorId: paused.id,
    handoffId: paused.control.handoff.id, state: 'confirmed' });
  const admitted = f.store.admitMonitorResumeJob({ workspaceId, source: 'owner:service', requestId: 'resume-drift',
    ownerId, instanceId: 'runtime-a', serviceGeneration: 'service-generation-a',
    installationGeneration: grant.installationGeneration, at: iso(base), envelope: { kind: 'monitor', purpose: 'resume',
      monitorId: settled.id, grantId: grant.id, digest: grant.digest, revision: grant.revision,
      controlRevision: settled.control.revision, recoverHandoff: false } });
  const running = f.store.claimServiceJob(workspaceId, 'worker', iso(base));
  const evidenceRef = f.store.putArtifact(workspaceId, 'Changed before resume execution.');
  const state = f.store.state(workspaceId);
  f.store.append(workspaceId, state.version, [{ type: 'work.phase_changed', data: {
    id: 'work', phase: 'waiting_external', evidenceRef } }], { recordedAt: iso(base) });
  await f.monitoring.runJob(running, currentFence());
  assert.equal(handlerCalls, 0);
  const stopped = f.store.serviceJob(workspaceId, admitted.job.id);
  assert.equal(stopped.status, 'stopped');
  assert.equal(stopped.result.reason, 'monitor_resume_rejected');
  const monitor = f.store.state(workspaceId).monitors['monitor-1'];
  assert.equal(monitor.status, 'paused');
  assert.equal(monitor.inFlightJobId, null);
  assert.equal(monitor.control.resume, null);
});

test('owner pause aborts a held inspection and its late continuation cannot finish', async t => {
  let begin; let finish;
  const started = new Promise(resolve => { begin = resolve; });
  const held = new Promise(resolve => { finish = resolve; });
  const f = fixture({ observations: [async () => { begin(); return held; }] });
  t.after(() => f.store.close());
  configure(f, { control: { version: 1, revision: 0, handoff: null, resume: null } });
  f.monitoring.admitDueMonitors({ instanceId: 'scheduler', at: iso(base), limit: 1 });
  const running = f.store.claimServiceJob(workspaceId, 'worker', iso(base));
  const run = f.monitoring.runJob(running, currentFence());
  await started;
  const grant = f.monitoring.grant('grant-1');
  const paused = f.monitoring.pauseMonitorForOwner({ ownerId, source: 'owner:service', requestId: 'pause-held',
    monitorId: 'monitor-1', digest: grant.digest, revision: grant.revision, controlRevision: 0,
    reason: 'owner_paused', binding: { profileId: 'profile-a', connectionGeneration: 1, epoch: 'a'.repeat(64),
      serviceGeneration: 'service-generation-a', allowedOrigin: 'http://127.0.0.1:43117', tabId: 7 } });
  finish(complete(iso(base)));
  await assert.rejects(run);
  assert.equal(paused.monitor.status, 'paused');
  assert.equal(f.store.serviceJob(workspaceId, running.id).status, 'stopped');
  assert.equal(f.store.state(workspaceId).monitors['monitor-1'].status, 'paused');
});

test('legacy service schema preserves old jobs and requires an explicit atomic monitor upgrade', t => {
  const directory = mkdtempSync(join(tmpdir(), 'behalvo-monitor-schema-'));
  const path = join(directory, 'legacy.db');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const initial = new SqliteStore(path, { serviceQueue: { upgradeExisting: false } });
  fixture({ store: initial });
  initial.close();

  const db = new DatabaseSync(path);
  db.exec(`DROP INDEX service_jobs_pending;
    DROP INDEX service_jobs_one_running;
    DROP TABLE monitor_installation;
    ALTER TABLE service_jobs RENAME TO service_jobs_current;
    CREATE TABLE service_jobs (
      position INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
      workspace_id TEXT NOT NULL, receipt_id TEXT NOT NULL, kind TEXT NOT NULL,
      status TEXT NOT NULL, admitted_at TEXT NOT NULL, started_at TEXT, finished_at TEXT,
      claim_id TEXT, instance_id TEXT, attempt_id TEXT, job_json TEXT NOT NULL,
      UNIQUE(workspace_id,receipt_id),
      FOREIGN KEY(workspace_id,receipt_id) REFERENCES service_requests(workspace_id,receipt_id),
      CHECK(kind IN ('owner_turn','execute','readback','reminder')),
      CHECK(status IN ('queued','running','finished','stopped','interrupted')),
      CHECK((status='queued' AND started_at IS NULL AND finished_at IS NULL AND claim_id IS NULL AND instance_id IS NULL)
        OR (status='running' AND started_at IS NOT NULL AND finished_at IS NULL AND claim_id IS NOT NULL AND instance_id IS NOT NULL)
        OR (status IN ('finished','stopped','interrupted') AND started_at IS NOT NULL AND finished_at IS NOT NULL AND claim_id IS NOT NULL AND instance_id IS NOT NULL))
    );
    INSERT INTO service_jobs SELECT * FROM service_jobs_current;
    DROP TABLE service_jobs_current;
    CREATE INDEX service_jobs_pending ON service_jobs(workspace_id,status,position);
    CREATE UNIQUE INDEX service_jobs_one_running ON service_jobs(workspace_id) WHERE status='running';`);
  db.close();

  const legacyStore = new SqliteStore(path, { serviceQueue: { upgradeExisting: false } });
  const legacy = fixture({ store: legacyStore, existing: true });
  assert.throws(() => configure(legacy), /upgrade/i);
  legacyStore.close();

  const upgradedStore = new SqliteStore(path, { serviceQueue: { upgradeExisting: true } });
  const upgraded = fixture({ store: upgradedStore, existing: true });
  try {
    const grant = upgraded.monitoring.grant('grant-1');
    upgraded.monitoring.reconcileInstallation({ ownerId, grantId: grant.id, digest: grant.digest, revision: grant.revision });
    configure(upgraded);
    assert.equal(upgraded.monitoring.admitDueMonitors({ instanceId: 'scheduler', at: iso(base), limit: 1 }).queued, 1);
  } finally { upgradedStore.close(); }
});

test('pre-marker monitor schema remains readable and upgrades to explicit inactive reconciliation', t => {
  const directory = mkdtempSync(join(tmpdir(), 'behalvo-monitor-marker-schema-'));
  const path = join(directory, 'previous.db');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const initial = new SqliteStore(path, { serviceQueue: { upgradeExisting: false } });
  fixture({ store: initial });
  initial.close();
  const db = new DatabaseSync(path);
  db.exec('DROP TABLE monitor_installation');
  db.close();

  const readable = new SqliteStore(path, { serviceQueue: { upgradeExisting: false } });
  const previous = fixture({ store: readable, existing: true });
  assert.throws(() => configure(previous), /upgrade/i);
  readable.close();

  const upgradedStore = new SqliteStore(path, { serviceQueue: { upgradeExisting: true } });
  const upgraded = fixture({ store: upgradedStore, existing: true });
  try {
    const grant = upgraded.monitoring.grant('grant-1');
    assert.equal(grant.status, 'blocked');
    upgraded.monitoring.reconcileInstallation({ ownerId, grantId: grant.id, digest: grant.digest, revision: grant.revision });
    configure(upgraded);
    assert.equal(upgraded.monitoring.admitDueMonitors({ instanceId: 'scheduler', at: iso(base), limit: 1 }).queued, 1);
  } finally { upgradedStore.close(); }
});

test('reducer rejects terminal-stop provenance without terminal grant and active recurrence without successor', t => {
  const f = fixture();
  t.after(() => f.store.close());
  configure(f, { jitterMs: 0 });
  let state = f.store.state(workspaceId);
  assert.throws(() => f.store.append(workspaceId, state.version, [{ type: 'monitor.stopped', data: {
    id: 'monitor-1', reason: 'grant_terminal', stoppedAt: iso(base)
  } }], { recordedAt: iso(base) }), /grant|terminal|stop/i);

  f.monitoring.admitDueMonitors({ instanceId: 'scheduler', at: iso(base), limit: 1 });
  state = f.store.state(workspaceId);
  const item = state.monitors['monitor-1'];
  assert.throws(() => f.store.append(workspaceId, state.version, [{ type: 'monitor.observation_recorded', data: {
    id: item.id, jobId: item.inFlightJobId,
    observation: { observedAt: iso(base), complete: true, coverage: { complete: true }, result: 'complete' },
    status: 'active', nextDueAt: null, consecutiveFailures: 0, backoffMs: 0, pauseReason: null,
    recordedAt: iso(base)
  } }], { recordedAt: iso(base) }), /next|observation|provenance|monitor|timestamp/i);
});

test('routine complete observation schedules one bounded jittered successor without model/provider/effect dispatch', async t => {
  const f = fixture({ random: () => 1, observations: [complete(iso(base))] });
  t.after(() => f.store.close());
  configure(f);
  await f.runtime.tick();
  await f.runtime.drain();

  const monitor = f.store.state(workspaceId).monitors['monitor-1'];
  assert.equal(monitor.status, 'active');
  assert.equal(monitor.nextDueAt, iso(base + 65_000));
  assert.equal(monitor.lastCompleteObservationAt, iso(base));
  assert.deepEqual(monitor.lastCompleteCoverage, { complete: true });
  assert.equal(monitor.consecutiveFailures, 0);
  assert.equal(f.inspectCalls(), 1);
  assert.deepEqual(f.counters, { model: 0, effect: 0 });
  assert.equal(f.store.serviceQueueCounts(workspaceId).running, 0);
  assert.equal(f.store.serviceJobs(workspaceId).items[0].status, 'finished');
});

test('request budget defers to the next window and never catches up in a burst', async t => {
  const f = fixture({ observations: [complete(iso(base))] });
  t.after(() => f.store.close());
  configure(f, { requestBudget: 1, intervalMs: 60_000, jitterMs: 0, requestWindowMs: 300_000 });
  await f.runtime.tick(); await f.runtime.drain();
  f.clock.milliseconds = base + 60_000;

  const result = f.monitoring.admitDueMonitors({ instanceId: 'scheduler', at: iso(f.clock.milliseconds), limit: 100 });
  assert.equal(result.queued, 0);
  assert.equal(result.budgetDeferred, 1);
  assert.equal(f.store.state(workspaceId).monitors['monitor-1'].nextDueAt, iso(base + 300_000));
  assert.equal(f.store.serviceJobs(workspaceId).items.length, 1);
});

test('provider failures back off exponentially within the configured bound', async t => {
  const unavailable = at => ({ observedAt: at, complete: false, coverage: {}, candidates: [], result: 'provider_unavailable' });
  const f = fixture({ observations: [unavailable(iso(base)), unavailable(iso(base + 60_000))] });
  t.after(() => f.store.close());
  configure(f, { jitterMs: 0, backoffBaseMs: 60_000, backoffMaxMs: 90_000 });
  await f.runtime.tick(); await f.runtime.drain();
  let monitor = f.store.state(workspaceId).monitors['monitor-1'];
  assert.equal(monitor.consecutiveFailures, 1);
  assert.equal(monitor.backoffMs, 60_000);
  assert.equal(monitor.nextDueAt, iso(base + 60_000));

  f.clock.milliseconds = base + 60_000;
  await f.runtime.tick(); await f.runtime.drain();
  monitor = f.store.state(workspaceId).monitors['monitor-1'];
  assert.equal(monitor.consecutiveFailures, 2);
  assert.equal(monitor.backoffMs, 90_000);
  assert.equal(monitor.nextDueAt, iso(base + 150_000));
  assert.equal(f.inspectCalls(), 2);
});

test('negative jitter keeps short failure retry strictly in the future', async t => {
  const unavailable = { observedAt: iso(base), complete: false, coverage: {}, candidates: [], result: 'provider_unavailable' };
  const f = fixture({ random: () => 0, observations: [unavailable] });
  t.after(() => f.store.close());
  configure(f, { intervalMs: 60_000, jitterMs: 60_000, backoffBaseMs: 1_000, backoffMaxMs: 60_000 });
  await f.runtime.tick(); await f.runtime.drain();

  const monitor = f.store.state(workspaceId).monitors['monitor-1'];
  assert.equal(monitor.nextDueAt, iso(base + 1));
  await f.runtime.tick(); await f.runtime.drain();
  assert.equal(f.inspectCalls(), 1);
  assert.equal(f.store.serviceJobs(workspaceId).items.length, 1);
});

test('unexpected inspection failure becomes bounded provider backoff and releases the worker', async t => {
  const f = fixture({ observations: [() => { throw new Error('synthetic provider unavailable'); }] });
  t.after(() => f.store.close());
  configure(f, { jitterMs: 0, backoffBaseMs: 60_000, backoffMaxMs: 90_000 });
  await f.runtime.tick(); await f.runtime.drain();

  const monitor = f.store.state(workspaceId).monitors['monitor-1'];
  assert.equal(monitor.status, 'active');
  assert.equal(monitor.consecutiveFailures, 1);
  assert.equal(monitor.backoffMs, 60_000);
  assert.equal(monitor.nextDueAt, iso(base + 60_000));
  assert.equal(f.store.serviceQueueCounts(workspaceId).running, 0);
  assert.equal(f.store.serviceJobs(workspaceId).items[0].status, 'finished');
});

test('shutdown interrupts an active monitor without replaying or retaining its worker claim', async t => {
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const f = fixture({ observations: [({ fence }) => new Promise((_resolve, reject) => {
    entered();
    fence.signal.addEventListener('abort', () => reject(new Error('monitor aborted')), { once: true });
  })] });
  t.after(() => f.store.close());
  configure(f, { jitterMs: 0 });
  await f.runtime.tick();
  const draining = f.runtime.drain();
  await started;
  await f.runtime.shutdown();
  await Promise.allSettled([draining]);

  assert.equal(f.store.state(workspaceId).monitors['monitor-1'].inFlightJobId, null);
  assert.equal(f.store.serviceQueueCounts(workspaceId).running, 0);
  assert.equal(f.store.serviceJobs(workspaceId).items[0].status, 'interrupted');
  assert.equal(f.inspectCalls(), 1);
});

test('inspection deadline releases a worker when the provider ignores cancellation and discards late settlement', async t => {
  for (const late of ['resolve', 'reject']) {
    let entered;
    let resolveInspection;
    let rejectInspection;
    const started = new Promise(resolve => { entered = resolve; });
    const held = new Promise((resolve, reject) => { resolveInspection = resolve; rejectInspection = reject; });
    const f = fixture({ timeoutMs: 20, observations: [() => { entered(); return held; }] });
    t.after(async () => { await f.runtime.shutdown(); f.store.close(); });
    configure(f, { jitterMs: 0 });
    await f.runtime.tick();
    await started;

    await Promise.race([
      f.runtime.drain(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('monitor worker did not honor deadline')), 250))
    ]);
    const job = f.store.serviceJobs(workspaceId).items[0];
    assert.equal(job.status, 'interrupted');
    assert.equal(f.store.state(workspaceId).monitors['monitor-1'].inFlightJobId, null);
    assert.equal(f.runtime.snapshot().activeJobId, null);
    assert.equal(f.runtime.snapshot().faulted, false);
    const version = f.store.state(workspaceId).version;

    if (late === 'resolve') resolveInspection(complete(iso(base)));
    else rejectInspection(new Error('late provider rejection'));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.store.serviceJob(workspaceId, job.id).status, 'interrupted');
    assert.equal(f.store.state(workspaceId).monitors['monitor-1'].lastObservation, null);
    assert.equal(f.store.state(workspaceId).version, version);
  }
});

test('typed local deadline wins before abort signal in repeated deterministic fence races', async () => {
  for (let attempt = 0; attempt < 80; attempt++) {
    const f = fixture({ observations: [complete(iso(base))] });
    try {
      configure(f, { jitterMs: 0 });
      assert.equal(f.monitoring.admitDueMonitors({ instanceId: 'scheduler', at: iso(base), limit: 1 }).queued, 1);
      const job = f.store.claimServiceJob(workspaceId, `worker-${attempt}`, iso(base));
      const controller = new AbortController();
      const before = f.store.state(workspaceId).version;

      await assert.rejects(f.monitoring.runJob(job, {
        serviceGeneration: 'service-generation-a', deadline: Date.now() - 1, signal: controller.signal,
        async assertCurrent() {}, assertSettlementCurrent() {}
      }), error => error?.name === 'OperationDeadlineError');

      assert.equal(controller.signal.aborted, false);
      assert.equal(f.inspectCalls(), 0);
      assert.equal(f.store.state(workspaceId).version, before);
      assert.equal(f.store.serviceJob(workspaceId, job.id).status, 'running');
    } finally { f.store.close(); }
  }
});

test('owner revocation atomically stops a running monitor and discards its late observation', async t => {
  let entered;
  let release;
  const started = new Promise(resolve => { entered = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  const f = fixture({ observations: [async () => { entered(); return held; }] });
  t.after(async () => { await f.runtime.shutdown(); f.store.close(); });
  configure(f, { jitterMs: 0 });
  await f.runtime.tick();
  const draining = f.runtime.drain();
  await started;

  const before = f.monitoring.grant('grant-1');
  f.monitoring.revokeGrant({ ownerId, grantId: before.id, digest: before.digest,
    revision: before.revision, reason: 'owner_revoked' });
  const terminal = f.store.serviceJobs(workspaceId).items[0];
  assert.equal(terminal.status, 'stopped');
  assert.equal(f.store.state(workspaceId).monitors['monitor-1'].inFlightJobId, null);
  assert.equal(f.store.state(workspaceId).monitors['monitor-1'].status, 'stopped');

  const released = await Promise.race([draining.then(() => true),
    new Promise(resolve => setTimeout(() => resolve(false), 250))]);
  release(eligible(iso(base)));
  assert.equal(released, true, 'grant revocation must release a non-cooperative inspector');
  assert.equal(f.runtime.snapshot().faulted, false);
  assert.equal(f.store.serviceJob(workspaceId, terminal.id).status, 'stopped');
  assert.equal(f.store.state(workspaceId).monitors['monitor-1'].lastObservation, null);
  assert.deepEqual(f.store.state(workspaceId).actions, {});
  assert.equal(f.store.serviceJobs(workspaceId).items.some(job => job.kind === 'execute'), false);
});

test('expiry terminalizes a queued monitor without faulting or inspecting', async t => {
  const f = fixture({ observations: [complete(iso(base + 86_400_000))] });
  t.after(async () => { await f.runtime.shutdown(); f.store.close(); });
  configure(f, { jitterMs: 0 });
  assert.equal(f.monitoring.admitDueMonitors({ instanceId: 'scheduler', at: iso(base), limit: 1 }).queued, 1);
  f.clock.milliseconds = base + 86_400_000;
  await f.runtime.drain();

  assert.equal(f.runtime.snapshot().faulted, false);
  assert.equal(f.inspectCalls(), 0);
  assert.equal(f.store.state(workspaceId).monitoredActionGrants['grant-1'].status, 'expired');
  assert.equal(f.store.state(workspaceId).monitors['monitor-1'].inFlightJobId, null);
  assert.equal(f.store.serviceJobs(workspaceId).items[0].status, 'stopped');
});

test('owner revocation terminalizes a queued monitor before any inspection', async t => {
  const f = fixture({ observations: [complete(iso(base))] });
  t.after(async () => { await f.runtime.shutdown(); f.store.close(); });
  configure(f, { jitterMs: 0 });
  assert.equal(f.monitoring.admitDueMonitors({ instanceId: 'scheduler', at: iso(base), limit: 1 }).queued, 1);
  const grant = f.monitoring.grant('grant-1');
  f.monitoring.revokeGrant({ ownerId, grantId: grant.id, digest: grant.digest,
    revision: grant.revision, reason: 'owner_revoked' });
  assert.equal(f.store.serviceJobs(workspaceId).items[0].status, 'stopped');
  assert.equal(f.store.state(workspaceId).monitors['monitor-1'].inFlightJobId, null);
  await f.runtime.drain();
  assert.equal(f.inspectCalls(), 0);
  assert.equal(f.runtime.snapshot().faulted, false);
});

test('expiry terminalizes a running monitor and discards its late observation', async t => {
  let entered;
  let release;
  const started = new Promise(resolve => { entered = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  const f = fixture({ observations: [() => { entered(); return held; }] });
  t.after(async () => { await f.runtime.shutdown(); f.store.close(); });
  configure(f, { jitterMs: 0 });
  await f.runtime.tick();
  const draining = f.runtime.drain();
  await started;
  f.clock.milliseconds = base + 86_400_000;
  assert.throws(() => configure(f, { id: 'monitor-2' }), /expired/i);
  assert.equal(f.store.serviceJobs(workspaceId).items[0].status, 'stopped');
  release(complete(iso(f.clock.milliseconds)));
  await draining;
  assert.equal(f.store.state(workspaceId).monitors['monitor-1'].lastObservation, null);
  assert.equal(f.runtime.snapshot().faulted, false);
});

test('inspection completion after grant expiry is discarded and terminalizes without another scheduler tick', async t => {
  let entered;
  let release;
  const started = new Promise(resolve => { entered = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  const f = fixture({ observations: [() => { entered(); return held; }] });
  t.after(async () => { await f.runtime.shutdown(); f.store.close(); });
  configure(f, { jitterMs: 0 });
  await f.runtime.tick();
  const draining = f.runtime.drain();
  await started;
  f.clock.milliseconds = base + 86_400_000;
  release(complete(iso(f.clock.milliseconds)));
  await draining;

  assert.equal(f.store.state(workspaceId).monitoredActionGrants['grant-1'].status, 'expired');
  assert.equal(f.store.state(workspaceId).monitors['monitor-1'].lastObservation, null);
  assert.equal(f.store.serviceJobs(workspaceId).items[0].status, 'stopped');
  assert.equal(f.runtime.snapshot().faulted, false);
});

test('terminalized monitor job provenance survives encrypted backup verification',
    { skip: process.platform === 'win32' }, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'behalvo-monitor-terminal-'));
  const key = randomBytes(32);
  const path = join(directory, 'source.db');
  const backup = join(directory, 'backup.db');
  const store = new SqliteStore(path, { encryptionKey: key, serviceQueue: { upgradeExisting: false } });
  const f = fixture({ store });
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  t.after(async () => { await f.runtime.shutdown(); f.store.close(); });
  configure(f, { jitterMs: 0 });
  f.monitoring.admitDueMonitors({ instanceId: 'scheduler', at: iso(base), limit: 1 });
  const grant = f.monitoring.grant('grant-1');
  f.monitoring.revokeGrant({ ownerId, grantId: grant.id, digest: grant.digest,
    revision: grant.revision, reason: 'owner_revoked' });
  await f.store.backup(backup);

  const restored = new SqliteStore(backup, { encryptionKey: Uint8Array.from(key), readOnly: true });
  try {
    assert.equal(restored.serviceJobs(workspaceId).items[0].status, 'stopped');
    assert.equal(restored.state(workspaceId).monitors['monitor-1'].inFlightJobId, null);
  } finally { restored.close(); }
});

test('encrypted backup rejects a live monitor job whose journal binding was consumed independently',
    { skip: process.platform === 'win32' }, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'behalvo-monitor-binding-'));
  const key = randomBytes(32);
  const path = join(directory, 'source.db');
  const store = new SqliteStore(path, { encryptionKey: key, serviceQueue: { upgradeExisting: false } });
  const f = fixture({ store });
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  t.after(async () => { await f.runtime.shutdown(); f.store.close(); });
  configure(f, { jitterMs: 0, backoffBaseMs: 60_000 });
  f.monitoring.admitDueMonitors({ instanceId: 'scheduler', at: iso(base), limit: 1 });
  const state = f.store.state(workspaceId);
  const job = f.store.serviceJobs(workspaceId).items[0];
  f.store.append(workspaceId, state.version, [{ type: 'monitor.interrupted', data: {
    id: 'monitor-1', jobId: job.id, nextDueAt: iso(base + 60_000), interruptedAt: iso(base)
  } }], { recordedAt: iso(base) });

  await assert.rejects(f.store.backup(join(directory, 'invalid.db')), /private file operation failed/i);
});

test('encrypted backup rejects an in-flight monitor binding without a live service job',
    { skip: process.platform === 'win32' }, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'behalvo-monitor-orphan-binding-'));
  const key = randomBytes(32);
  const path = join(directory, 'source.db');
  const store = new SqliteStore(path, { encryptionKey: key, serviceQueue: { upgradeExisting: false } });
  const f = fixture({ store });
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  t.after(async () => { await f.runtime.shutdown(); f.store.close(); });
  configure(f, { jitterMs: 0 });
  const state = f.store.state(workspaceId);
  const monitor = state.monitors['monitor-1'];
  f.store.append(workspaceId, state.version, [{ type: 'monitor.poll_started', data: {
    id: monitor.id, jobId: 'orphan-job', dueAt: monitor.nextDueAt, startedAt: iso(base),
    requestWindowStartedAt: monitor.requestWindowStartedAt, requestsInWindow: 1
  } }], { recordedAt: iso(base) });

  await assert.rejects(f.store.backup(join(directory, 'invalid.db')), /private file operation failed/i);
});

for (const result of ['session_expired', 'needs_human', 'rate_limited', 'contract_changed']) {
  test(`${result} pauses recurrence and releases the worker`, async t => {
    const f = fixture({ observations: [{ observedAt: iso(base), complete: false, coverage: {}, candidates: [], result }] });
    t.after(() => f.store.close());
    configure(f);
    await f.runtime.tick(); await f.runtime.drain();
    const monitor = f.store.state(workspaceId).monitors['monitor-1'];
    assert.equal(monitor.status, 'paused');
    assert.equal(monitor.pauseReason, result);
    assert.equal(monitor.nextDueAt, null);
    assert.equal(f.store.serviceQueueCounts(workspaceId).running, 0);
    assert.equal(f.store.serviceJobs(workspaceId).items[0].status, 'stopped');
    assert.deepEqual(f.counters, { model: 0, effect: 0 });
  });
}

test('atomic scheduled dispatch rolls every reservation and queue write back on a commit fault', async t => {
  const f = fixture({ observations: [eligible(iso(base))] });
  t.after(() => f.store.close());
  configure(f, { jitterMs: 0 });
  assert.equal(f.monitoring.admitDueMonitors({ instanceId: 'scheduler', at: iso(base), limit: 1 }).queued, 1);
  const monitorJob = f.store.claimServiceJob(workspaceId, 'worker', iso(base));
  const original = f.store.completeMonitorJobAndAdmitAction.bind(f.store);
  f.store.completeMonitorJobAndAdmitAction = (...args) => original(args[0], args[1], args[2],
    () => { throw new Error('synthetic commit fault'); });

  await assert.rejects(f.monitoring.runJob(monitorJob, currentFence()), /synthetic commit fault/);

  assert.equal(f.store.serviceJobs(workspaceId).items.length, 1);
  assert.equal(f.store.serviceJob(workspaceId, monitorJob.id).status, 'running');
  assert.deepEqual(f.store.state(workspaceId).actions, {});
  assert.equal(f.monitoring.grant('grant-1').status, 'active');
  assert.equal(f.store.state(workspaceId).monitors['monitor-1'].inFlightJobId, monitorJob.id);
  assert.equal(f.store.journal(workspaceId).some(record => record.event.type === 'monitor.observation_recorded'), false);
  assert.equal(f.store.findServiceReceipt({ workspaceId, source: 'kernel:monitor-action',
    requestId: `${monitorJob.id}:execute` }, { kind: 'execute', actionId: 'missing', digest: 'missing' }), undefined);
});

test('a full FIFO leaves no completed observation, reserved allowance, or orphan action', async t => {
  const f = fixture({ observations: [eligible(iso(base))] });
  t.after(() => f.store.close());
  configure(f, { jitterMs: 0 });
  f.monitoring.admitDueMonitors({ instanceId: 'scheduler', at: iso(base), limit: 1 });
  const monitorJob = f.store.claimServiceJob(workspaceId, 'worker', iso(base));
  fillQueue(f.store, 64, 'capacity');

  await assert.rejects(f.monitoring.runJob(monitorJob, currentFence()), error => error?.code === 'full');

  assert.equal(f.store.serviceQueueCounts(workspaceId).queued, 64);
  assert.equal(f.store.serviceJob(workspaceId, monitorJob.id).status, 'running');
  assert.deepEqual(f.store.state(workspaceId).actions, {});
  assert.equal(f.monitoring.grant('grant-1').status, 'active');
  assert.equal(f.store.state(workspaceId).monitors['monitor-1'].lastObservation, null);
  assert.equal(f.store.journal(workspaceId).some(record => record.event.type === 'monitor.observation_recorded'), false);
});

test('scheduled dispatch duplicate lookup precedes capacity and returns one exact execute job', async t => {
  const f = fixture({ observations: [eligible(iso(base))] });
  t.after(() => f.store.close());
  configure(f, { jitterMs: 0 });
  f.monitoring.admitDueMonitors({ instanceId: 'scheduler', at: iso(base), limit: 1 });
  const monitorJob = f.store.claimServiceJob(workspaceId, 'worker', iso(base));
  let captured;
  const original = f.store.completeMonitorJobAndAdmitAction.bind(f.store);
  f.store.completeMonitorJobAndAdmitAction = (...args) => { captured = args; return original(...args); };
  await f.monitoring.runJob(monitorJob, currentFence());
  const first = f.store.serviceJobs(workspaceId).items.find(job => job.kind === 'execute');
  fillQueue(f.store, 63, 'duplicate-capacity');

  assert.throws(() => original(captured[0], captured[1], {
    ...captured[2], binding: { ...captured[2].binding, installationGeneration: 'different-installation' }
  }), error => error?.code === 'conflict', 'the deterministic request binds exact installation evidence');

  const replay = original(...captured);

  assert.equal(f.store.serviceQueueCounts(workspaceId).queued, 64);
  assert.equal(replay.duplicate, true);
  assert.equal(replay.job.id, first.id);
  assert.equal(replay.receipt.id, f.store.serviceJobReceipt(workspaceId, first.id).id);
  assert.equal(f.store.serviceJobs(workspaceId, 0, 100).items.filter(job => job.kind === 'execute').length, 1);
  assert.equal(f.store.journal(workspaceId).filter(record => record.event.type === 'action.started').length, 1);
});

test('encrypted backup authenticates the scheduled monitor execution binding',
    { skip: process.platform === 'win32' }, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'behalvo-monitor-dispatch-backup-'));
  const key = randomBytes(32);
  const path = join(directory, 'source.db');
  const backup = join(directory, 'backup.db');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const store = new SqliteStore(path, { encryptionKey: key, serviceQueue: { upgradeExisting: false } });
  const f = fixture({ store, observations: [eligible(iso(base))] });
  configure(f, { jitterMs: 0 });
  f.monitoring.admitDueMonitors({ instanceId: 'scheduler', at: iso(base), limit: 1 });
  const monitorJob = store.claimServiceJob(workspaceId, 'worker', iso(base));
  await f.monitoring.runJob(monitorJob, currentFence());

  await store.backup(backup);
  store.close();
  const restored = new SqliteStore(backup, { encryptionKey: Uint8Array.from(key), readOnly: true });
  try {
    const jobs = restored.serviceJobs(workspaceId).items;
    assert.deepEqual(jobs.map(job => [job.kind, job.status]), [['monitor', 'finished'], ['execute', 'queued']]);
    assert.equal(restored.serviceJobReceipt(workspaceId, jobs[1].id).source, 'kernel:monitor-action');
  } finally { restored.close(); }
});

test('queued scheduled execution survives restart while a claimed interruption becomes unknown without redispatch', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'behalvo-monitor-dispatch-restart-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const initialStatus of ['queued', 'running']) await t.test(initialStatus, async () => {
    const path = join(directory, `${initialStatus}.db`);
    const firstStore = new SqliteStore(path, { serviceQueue: { upgradeExisting: false } });
    const first = fixture({ store: firstStore, observations: [eligible(iso(base))] });
    configure(first, { jitterMs: 0 });
    first.monitoring.admitDueMonitors({ instanceId: 'scheduler', at: iso(base), limit: 1 });
    const monitorJob = firstStore.claimServiceJob(workspaceId, 'monitor-worker', iso(base));
    await first.monitoring.runJob(monitorJob, currentFence());
    const executeJob = firstStore.serviceJobs(workspaceId).items.find(job => job.kind === 'execute');
    const actionId = executeJob.parameters.actionId;
    if (initialStatus === 'running') firstStore.claimServiceJob(workspaceId, 'crashed-executor', iso(base));
    firstStore.close();

    let executions = 0;
    const reopened = new SqliteStore(path, { serviceQueue: { upgradeExisting: false } });
    const restarted = fixture({ store: reopened, existing: true, executeReserved: async () => {
      executions++; return { status: 'failed' };
    } });
    assert.deepEqual(reopened.rebuild(workspaceId), reopened.state(workspaceId));
    assert.equal(executions, 0, 'projection replay never dispatches');
    try {
      restarted.runtime.start();
      await restarted.runtime.drain();
      const finalJob = reopened.serviceJob(workspaceId, executeJob.id);
      const action = reopened.state(workspaceId).actions[actionId];
      if (initialStatus === 'queued') {
        assert.equal(executions, 1);
        assert.equal(finalJob.status, 'stopped');
        assert.equal(finalJob.result.reason, 'action_failed');
        assert.equal(action.status, 'failed');
      } else {
        assert.equal(executions, 0);
        assert.equal(finalJob.status, 'stopped');
        assert.equal(finalJob.result.reason, 'action_unknown');
        assert.equal(action.status, 'unknown');
      }
      assert.equal(restarted.monitoring.grant('grant-1').status, 'blocked');
      assert.notEqual(restarted.monitoring.grant('grant-1').reservationAttemptId, undefined);
      assert.equal(reopened.state(workspaceId).monitors['monitor-1'].status, 'stopped');
      assert.equal(restarted.monitoring.admitDueMonitors({ instanceId: 'scheduler', at: iso(base + 86_400_000), limit: 1 }).queued, 0);
      assert.equal(executions, initialStatus === 'queued' ? 1 : 0, 'terminal allowance must not retry');
    } finally {
      await restarted.runtime.shutdown(); reopened.close();
    }
  });
});

test('exclusive recovery preserves only an exact unclaimed scheduled execution and later drains it once', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'behalvo-monitor-exclusive-recovery-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const initialStatus of ['queued', 'running']) await t.test(initialStatus, async () => {
    const path = join(directory, `${initialStatus}.db`);
    const firstStore = new SqliteStore(path, { serviceQueue: { upgradeExisting: false } });
    const first = fixture({ store: firstStore, observations: [eligible(iso(base))] });
    const executeJob = await enqueueScheduled(first);
    const actionId = executeJob.parameters.actionId;
    if (initialStatus === 'running') firstStore.claimServiceJob(workspaceId, 'crashed-executor', iso(base));
    firstStore.close();

    const recovery = recoverLocalService({ dbPath: path, workspaceId, exclusiveMaintenance: true });
    let executions = 0;
    const reopened = new SqliteStore(path, { serviceQueue: { upgradeExisting: false } });
    const restarted = fixture({ store: reopened, existing: true, executeReserved: async () => {
      executions++; return { status: 'failed' };
    } });
    try {
      assert.deepEqual(recovery, { jobsInterrupted: 0, jobsRepaired: initialStatus === 'queued' ? 0 : 1,
        actionsUnknown: 0 });
      assert.equal(reopened.state(workspaceId).actions[actionId].status,
        initialStatus === 'queued' ? 'running' : 'unknown');
      restarted.runtime.start();
      await restarted.runtime.drain();
      assert.equal(executions, initialStatus === 'queued' ? 1 : 0);
      assert.equal(reopened.state(workspaceId).actions[actionId].status,
        initialStatus === 'queued' ? 'failed' : 'unknown');
      assert.equal(reopened.serviceJob(workspaceId, executeJob.id).result.reason,
        initialStatus === 'queued' ? 'action_failed' : 'action_unknown');
    } finally {
      await restarted.runtime.shutdown(); reopened.close();
    }
  });
});

test('queued work cancellation or revision drift terminalizes without dispatch or releasing allowance', async t => {
  for (const phase of ['cancelled', 'waiting_external']) await t.test(phase, async () => {
    let executions = 0;
    const f = fixture({ observations: [eligible(iso(base))], executeReserved: async () => {
      executions++; return { status: 'failed' };
    } });
    const executeJob = await enqueueScheduled(f);
    const actionId = executeJob.parameters.actionId;
    new Operator(f.store, () => iso(base)).setWorkPhase(workspaceId, ownerId, 'work', phase);
    try {
      f.runtime.start(); await f.runtime.drain();
      assert.equal(executions, 0);
      assert.equal(f.store.state(workspaceId).actions[actionId].status, 'failed');
      assert.equal(f.store.serviceJob(workspaceId, executeJob.id).result.reason, 'action_failed');
      assert.equal(f.monitoring.grant('grant-1').status, 'blocked');
      assert.equal(f.monitoring.grant('grant-1').settlement.outcome, 'failed');
    } finally { await f.runtime.shutdown(); f.store.close(); }
  });
});

test('pre-intent connection rejection atomically terminalizes the exact action and execute job', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'behalvo-monitor-pre-intent-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'connection.db');
  let executions = 0;
  const store = new SqliteStore(path, { serviceQueue: { upgradeExisting: false } });
  const f = fixture({ store, observations: [eligible(iso(base))], executeReserved: async () => {
    executions++; return { status: 'failed' };
  } });
  const executeJob = await enqueueScheduled(f);
  const actionId = executeJob.parameters.actionId;
  const state = store.state(workspaceId);
  store.append(workspaceId, state.version,
    [{ type: 'connection.revoked', data: { id: 'connection-a', generation: 2 } }], { recordedAt: iso(base) });
  try {
    f.runtime.start(); await f.runtime.drain();
    assert.equal(executions, 0);
    assert.equal(store.state(workspaceId).actions[actionId].status, 'failed');
    assert.equal(store.serviceJob(workspaceId, executeJob.id).result.reason, 'action_failed');
    assert.equal(f.monitoring.grant('grant-1').status, 'blocked');
    assert.equal(f.monitoring.grant('grant-1').settlement.outcome, 'failed');
    assert.deepEqual(store.rebuild(workspaceId), store.state(workspaceId));
  } finally { await f.runtime.shutdown(); store.close(); }
  const reopened = new SqliteStore(path, { serviceQueue: { upgradeExisting: false } });
  try {
    assert.equal(reopened.state(workspaceId).actions[actionId].status, 'failed');
    assert.equal(reopened.serviceJob(workspaceId, executeJob.id).result.reason, 'action_failed');
  } finally { reopened.close(); }
});

test('pre-intent inactive installation terminalizes instead of orphaning a running action', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'behalvo-monitor-installation-stop-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const sourcePath = join(directory, 'source.db'); const copiedPath = join(directory, 'copied.db');
  const firstStore = new SqliteStore(sourcePath, { serviceQueue: { upgradeExisting: false } });
  const first = fixture({ store: firstStore, observations: [eligible(iso(base))] });
  const executeJob = await enqueueScheduled(first); const actionId = executeJob.parameters.actionId;
  firstStore.close(); copyFileSync(sourcePath, copiedPath);
  let executions = 0;
  const copiedStore = new SqliteStore(copiedPath, { serviceQueue: { upgradeExisting: false } });
  const restarted = fixture({ store: copiedStore, existing: true, executeReserved: async () => {
    executions++; return { status: 'failed' };
  } });
  try {
    assert.equal(copiedStore.monitorInstallation().active, false);
    restarted.runtime.start(); await restarted.runtime.drain();
    assert.equal(executions, 0);
    assert.equal(copiedStore.state(workspaceId).actions[actionId].status, 'failed');
    assert.equal(copiedStore.serviceJob(workspaceId, executeJob.id).result.reason, 'action_failed');
    assert.equal(restarted.monitoring.grant('grant-1').settlement.outcome, 'failed');
  } finally { await restarted.runtime.shutdown(); copiedStore.close(); }
});

test('a later unbound job cannot downgrade an action with prior durable intent', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'behalvo-monitor-prior-intent-'));
  const path = join(directory, 'prior-intent.db');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let executions = 0;
  const store = new SqliteStore(path, { serviceQueue: { upgradeExisting: false } });
  const f = fixture({ store, observations: [eligible(iso(base))], executeReserved: async () => {
    executions++; return { status: 'failed' };
  } });
  const firstJob = await enqueueScheduled(f);
  const actionId = firstJob.parameters.actionId;
  const action = store.state(workspaceId).actions[actionId];
  const firstClaim = store.claimServiceJob(workspaceId, 'first-executor', iso(base));
  store.recordMonitoredActionIntent(workspaceId, firstClaim.claim, {
    actionId, grantId: 'grant-1', attemptId: action.attemptId,
    intentId: 'prior-durable-intent', evidence: 'Synthetic prior durable intent', at: iso(base)
  });
  store.completeServiceJob(workspaceId, firstClaim.claim, 'interrupted', {
    reason: 'process_interrupted', recordIds: []
  }, iso(base));
  const laterJob = store.admitActionJob({ workspaceId, ownerId, source: 'owner:service',
    requestId: 'later-unbound-execution', envelope: { kind: 'execute', actionId, digest: action.digest },
    instanceId: 'runtime-a', at: iso(base) }).job;

  f.runtime.start(); await f.runtime.drain();
  assert.equal(executions, 0);
  assert.equal(store.serviceJob(workspaceId, laterJob.id).result.reason, 'action_ineligible');
  assert.equal(store.state(workspaceId).actions[actionId].status, 'unknown');
  assert.equal(store.state(workspaceId).actions[actionId].monitoredIntent.intentId, 'prior-durable-intent');
  assert.equal(store.state(workspaceId).monitoredActionGrants['grant-1'].settlement.outcome, 'unknown');
  await f.runtime.shutdown(); store.close();

  const recovery = recoverLocalService({ dbPath: path, workspaceId, exclusiveMaintenance: true });
  assert.deepEqual(recovery, { jobsInterrupted: 0, jobsRepaired: 0, actionsUnknown: 0 });
  const reopened = new SqliteStore(path, { serviceQueue: { upgradeExisting: false } });
  try {
    const recovered = reopened.state(workspaceId).actions[actionId];
    assert.equal(recovered.status, 'unknown');
    assert.equal(recovered.monitoredIntent.intentId, 'prior-durable-intent');
    assert.equal(reopened.state(workspaceId).monitoredActionGrants['grant-1'].status, 'blocked');
    assert.equal(reopened.serviceJob(workspaceId, firstJob.id).result.reason, 'process_interrupted');
    assert.equal(reopened.serviceJob(workspaceId, laterJob.id).result.reason, 'action_ineligible');
    assert.deepEqual(reopened.rebuild(workspaceId), reopened.state(workspaceId));
  } finally { reopened.close(); }
});

test('scheduled admission rechecks fresh observation time after policy selection', async t => {
  const clock = { milliseconds: base };
  const f = fixture({ clock, observations: [eligible(iso(base))], beforeSelection() { clock.milliseconds += 60_001; } });
  t.after(() => f.store.close()); configure(f, { jitterMs: 0 });
  f.monitoring.admitDueMonitors({ instanceId: 'scheduler', at: iso(base), limit: 1 });
  const monitorJob = f.store.claimServiceJob(workspaceId, 'monitor-worker', iso(base));

  await assert.rejects(f.monitoring.runJob(monitorJob, currentFence()), /fresh|stale/i);
  assert.deepEqual(f.store.state(workspaceId).actions, {});
  assert.equal(f.store.serviceJobs(workspaceId).items.some(job => job.kind === 'execute'), false);
  assert.equal(f.monitoring.grant('grant-1').status, 'active');
});

test('scheduled admission rechecks observation freshness at the atomic commit guard', async t => {
  const clock = { milliseconds: base };
  let selectionFinished = false;
  const f = fixture({ clock, observations: [eligible(iso(base))],
    beforeSelection() { clock.milliseconds = base + 60_000; selectionFinished = true; },
    random() { if (selectionFinished) clock.milliseconds++; return 0.5; } });
  t.after(() => f.store.close()); configure(f, { jitterMs: 0 });
  f.monitoring.admitDueMonitors({ instanceId: 'scheduler', at: iso(base), limit: 1 });
  const monitorJob = f.store.claimServiceJob(workspaceId, 'monitor-worker', iso(base));

  await assert.rejects(f.monitoring.runJob(monitorJob, currentFence()), /fresh|stale/i);
  assert.equal(f.store.serviceJob(workspaceId, monitorJob.id).status, 'running');
  assert.equal(f.store.state(workspaceId).monitors['monitor-1'].inFlightJobId, monitorJob.id);
  assert.equal(f.store.state(workspaceId).monitors['monitor-1'].lastObservation, null);
  assert.deepEqual(f.store.state(workspaceId).actions, {});
  assert.equal(f.store.serviceJobs(workspaceId).items.some(job => job.kind === 'execute'), false);
  assert.equal(f.monitoring.grant('grant-1').status, 'active');
});

test('scheduled admission checks freshness after final projection construction', async t => {
  const clock = { milliseconds: base };
  const f = fixture({ clock, observations: [eligible(iso(base))],
    beforeSelection() { clock.milliseconds = base + 60_000; } });
  t.after(() => f.store.close()); configure(f, { jitterMs: 0 });
  f.monitoring.admitDueMonitors({ instanceId: 'scheduler', at: iso(base), limit: 1 });
  const monitorJob = f.store.claimServiceJob(workspaceId, 'monitor-worker', iso(base));
  const originalState = f.store.state.bind(f.store);
  let projectionCrossings = 0;
  f.store.state = (...args) => {
    const state = originalState(...args);
    const action = Object.values(state.actions).find(item =>
      item.monitoredGrant?.id === 'grant-1' && item.status === 'running');
    if (projectionCrossings === 0 && action && state.monitors['monitor-1']?.status === 'stopped') {
      clock.milliseconds++;
      projectionCrossings++;
    }
    return state;
  };

  await assert.rejects(f.monitoring.runJob(monitorJob, currentFence()), /fresh|stale/i);
  assert.equal(projectionCrossings, 1);
  assert.equal(f.store.serviceJob(workspaceId, monitorJob.id).status, 'running');
  assert.equal(originalState(workspaceId).monitors['monitor-1'].lastObservation, null);
  assert.deepEqual(originalState(workspaceId).actions, {});
  assert.equal(f.store.serviceJobs(workspaceId).items.some(job => job.kind === 'execute'), false);
  assert.equal(f.monitoring.grant('grant-1').status, 'active');
});

test('reviewed work drift during asynchronous inspection cannot reserve at a newer revision', async t => {
  let inspectionStarted; let releaseInspection;
  const started = new Promise(resolve => { inspectionStarted = resolve; });
  const held = new Promise(resolve => { releaseInspection = resolve; });
  const f = fixture({ reviewedPlan, observations: [async () => { inspectionStarted(); return held; }] });
  t.after(() => f.store.close());
  configure(f, reviewedPolling);
  f.monitoring.admitDueMonitors({ instanceId: 'scheduler', at: iso(base), limit: 1 });
  const monitorJob = f.store.serviceJobs(workspaceId).items[0];
  const drain = f.runtime.drain();
  await started;
  new Operator(f.store, () => iso(base)).setWorkPhase(workspaceId, ownerId, 'work', 'waiting_external');
  releaseInspection(eligible(iso(base)));
  await drain;

  assert.deepEqual(f.store.state(workspaceId).actions, {});
  assert.equal(f.store.serviceJobs(workspaceId).items.some(job => job.kind === 'execute'), false);
  assert.equal(f.store.serviceJob(workspaceId, monitorJob.id).status, 'interrupted');
  assert.equal(f.monitoring.grant('grant-1').status, 'active');
});

test('direct reservation cannot adopt a work revision newer than the reviewed plan', t => {
  const f = fixture({ reviewedPlan });
  t.after(() => f.store.close());
  configure(f, reviewedPolling);
  new Operator(f.store, () => iso(base)).setWorkPhase(workspaceId, ownerId, 'work', 'waiting_external');

  assert.throws(() => f.monitoring.reserve({ grantId: 'grant-1', workId: 'work', observation: eligible(iso(base)),
    maxObservationAgeMs: 60_000, binding: { adapter: 'synthetic.observe', adapterVersion: 1,
      connectionId: 'connection-a', connectionGeneration: 1, browserProfileId: 'profile-a', subjectDigest } }),
  /plan|review|work|binding/i);
  assert.deepEqual(f.store.state(workspaceId).actions, {});
  assert.equal(f.monitoring.grant('grant-1').status, 'active');
});

function reviewedReservation(f, extra = {}) {
  const grant = f.monitoring.grant('grant-1');
  return { grantId: grant.id, workId: 'work', monitorId: 'monitor-1', observation: eligible(iso(base)),
    maxObservationAgeMs: 60_000, binding: { adapter: grant.adapter, adapterVersion: grant.adapterVersion,
      connectionId: grant.connectionId, connectionGeneration: grant.connectionGeneration,
      browserProfileId: grant.browserProfileId, subjectDigest: grant.subjectDigest }, ...extra };
}

for (const [name, extra] of [
  ['another current work', { workId: 'work-b' }],
  ['widened freshness with stale evidence', { maxObservationAgeMs: 120_000, observation: eligible(iso(base - 90_000)) }],
  ['changed freshness with fresh evidence', { maxObservationAgeMs: 30_000 }],
  ['omitted monitor', { monitorId: undefined }],
  ['wrong monitor', { monitorId: 'other-monitor' }]
]) test(`reviewed reservation rejects ${name} without consuming authority`, t => {
  const options = { reviewedPlan };
  const f = fixture(options);
  t.after(() => f.store.close());
  configure(f, reviewedPolling);
  new Operator(f.store, () => iso(base)).createWork(workspaceId, ownerId, {
    id: 'work-b', title: 'Other current work', goal: 'Separate authority', threadId: 'thread-b'
  });
  if (extra.monitorId === 'other-monitor') {
    const other = f.monitoring.proposeGrant({ id: 'other-grant', workspaceId, ownerId,
      ...reviewedReservation(f).binding, scope: { operation: 'observe' }, maximumEffects: 1,
      expiresAt: iso(base + 86_400_000) });
    f.monitoring.activateGrant({ ownerId, grantId: other.id, digest: other.digest, revision: other.revision });
    f.monitoring.configureMonitor({ ownerId, id: 'other-monitor', grantId: other.id, workId: 'work-b',
      nextDueAt: iso(base), ...reviewedPolling });
    // A legacy reservation may leave its monitor active; stopping that unrelated monitor is not our authority.
    const action = f.monitoring.reserve(reviewedReservation(f, {
      grantId: other.id, workId: 'work-b', monitorId: undefined }));
    f.store.finishActionAttempt(workspaceId, action.id, action.attemptId, 'failed', 'Synthetic failed attempt',
      { recordedAt: iso(base) });
    options.subjectRevision = 1;
  }
  const before = f.store.state(workspaceId), journal = f.store.journal(workspaceId);
  assert.throws(() => f.monitoring.reserve(reviewedReservation(f, extra)), /plan|review|binding/i);
  assert.deepEqual(f.store.state(workspaceId), before);
  assert.deepEqual(f.store.journal(workspaceId), journal);
});

function reviewedReservationEvents(f, workId = 'work') {
  const input = reviewedReservation(f), grant = f.monitoring.grant(input.grantId);
  const command = f.monitoring.evaluate(grant.id, input.observation, {
    maxObservationAgeMs: input.maxObservationAgeMs, binding: input.binding });
  const work = f.store.state(workspaceId).works[workId], digest = observationDigest(input.observation);
  const action = { id: 'planned-action', workId, workRevision: work.revision, key: `monitor:${grant.id}:${digest}`,
    command, digest: monitoredActionCommandDigest(workspaceId, workId, work.revision, grant, command),
    status: 'approved', monitoredGrant: { id: grant.id, digest: grant.digest, revision: grant.revision } };
  return [
    { type: 'monitored_action.command_narrowed', data: { grantId: grant.id, action } },
    { type: 'monitored_action.grant_reserved', data: { id: grant.id, digest: grant.digest, revision: grant.revision,
      actionId: action.id, attemptId: 'planned-attempt', observationDigest: digest, reservedAt: iso(base) } },
    { type: 'action.started', data: { id: action.id, attemptId: 'planned-attempt' } },
    { type: 'monitor.stopped', data: { id: 'monitor-1', reason: 'grant_reserved', stoppedAt: iso(base) } }
  ];
}

test('reviewed reservation reducer and locked append reject another current work', t => {
  const f = fixture({ reviewedPlan });
  t.after(() => f.store.close());
  configure(f, reviewedPolling);
  new Operator(f.store, () => iso(base)).createWork(workspaceId, ownerId, {
    id: 'work-b', title: 'Other current work', goal: 'Separate authority', threadId: 'thread-b'
  });
  const before = f.store.state(workspaceId), events = reviewedReservationEvents(f, 'work-b');
  assert.throws(() => reduce(before, events[0], before.version + 1), /plan|review|binding/i);
  assert.throws(() => f.store.append(workspaceId, before.version, events), /plan|review|binding/i);
  assert.deepEqual(f.store.state(workspaceId), before);
});

for (const mutation of ['missing', 'wrong-id', 'wrong-reason', 'wrong-time', 'noncontiguous'])
  test(`reviewed reservation journal rejects ${mutation} planned stop`, t => {
    const f = fixture({ reviewedPlan });
    t.after(() => f.store.close());
    configure(f, reviewedPolling);
    const before = f.store.state(workspaceId), events = reviewedReservationEvents(f);
    if (mutation === 'missing') events.pop();
    if (mutation === 'wrong-id') events[3].data.id = 'other-monitor';
    if (mutation === 'wrong-reason') events[3].data.reason = 'owner_stopped';
    if (mutation === 'wrong-time') events[3].data.stoppedAt = iso(base + 1);
    if (mutation === 'noncontiguous') events.splice(3, 0, { type: 'work.created', data: {
      id: 'unrelated', title: 'Unrelated', goal: 'Separate event', threadId: 'thread-b'
    } });
    assert.throws(() => validateMonitoredReservationJournal(events, before), /plan|monitor|stop/i);
    assert.throws(() => f.store.append(workspaceId, before.version, events), /plan|monitor|stop/i);
    // Whole-history validation must also discover the plan from its proposal event, without a projection.
    assert.throws(() => validateMonitoredReservationJournal([
      ...f.store.journal(workspaceId).map(record => record.event), ...events
    ]), /plan|monitor|stop/i);
    assert.deepEqual(f.store.state(workspaceId), before);
  });

test('reviewed reservation stops the exact monitor atomically and survives replay', t => {
  const f = fixture({ reviewedPlan });
  t.after(() => f.store.close());
  configure(f, reviewedPolling);
  const action = f.monitoring.reserve(reviewedReservation(f));
  const state = f.store.state(workspaceId);
  assert.equal(action.workId, 'work');
  assert.equal(action.workRevision, 1);
  assert.equal(action.status, 'running');
  assert.equal(state.monitoredActionGrants['grant-1'].reservedActionId, action.id);
  assert.equal(state.monitors['monitor-1'].status, 'stopped');
  assert.equal(state.monitors['monitor-1'].nextDueAt, null);
  assert.deepEqual(f.store.journal(workspaceId).slice(-4).map(record => record.event.type), [
    'monitored_action.command_narrowed', 'monitored_action.grant_reserved', 'action.started', 'monitor.stopped'
  ]);
  assert.deepEqual(f.store.rebuild(workspaceId), state);
});

function pauseReviewedMonitor(f) {
  const grant = f.monitoring.grant('grant-1');
  f.monitoring.pauseMonitor({ ownerId, monitorId: 'monitor-1', digest: grant.digest,
    revision: grant.revision, controlRevision: 0, reason: 'owner_paused',
    binding: { profileId: 'profile-a', connectionGeneration: 1, epoch: 'a'.repeat(64),
      serviceGeneration: 'service-generation-a', allowedOrigin: 'http://127.0.0.1:43117', tabId: 7 } });
}

for (const drift of ['revoked', 'regenerated', 'rebound'])
  test(`reviewed reservation durably terminalizes ${drift} connection drift`, t => {
    let selections = 0;
    const f = fixture({ reviewedPlan, beforeSelection() { selections++; } });
    t.after(() => f.store.close());
    configure(f, reviewedPolling);
    const state = f.store.state(workspaceId);
    f.store.append(workspaceId, state.version, [drift === 'revoked'
      ? { type: 'connection.revoked', data: { id: 'connection-a', generation: 2 } }
      : { type: 'connection.registered', data: { connection: { ...state.connections['connection-a'],
        generation: 2, ...(drift === 'rebound' ? { subject: 'other-synthetic-account' } : {}) } } }]);
    assert.throws(() => f.monitoring.reserve(reviewedReservation(f)), /drift|connection|plan/i);
    const current = f.store.state(workspaceId);
    assert.equal(current.monitoredActionGrants['grant-1'].status, 'revoked');
    assert.equal(current.monitoredActionGrants['grant-1'].revocationReason, 'material_drift');
    assert.equal(current.monitors['monitor-1'].status, 'stopped');
    assert.deepEqual(current.actions, {});
    assert.equal(selections, 0);
    assert.deepEqual(f.store.rebuild(workspaceId), current);
  });

for (const lifecycle of ['paused', 'queued', 'running', 'stopped'])
  for (const boundary of ['direct', 'reducer', 'append'])
    test(`reviewed lifecycle rejects ${lifecycle} reservation at ${boundary} boundary`, t => {
      let selections = 0;
      const f = fixture({ reviewedPlan, beforeSelection() { selections++; } });
      t.after(() => f.store.close());
      configure(f, { ...reviewedPolling, control: { version: 1, revision: 0, handoff: null, resume: null } });
      const events = reviewedReservationEvents(f);
      if (lifecycle === 'paused') pauseReviewedMonitor(f);
      else if (lifecycle === 'stopped') f.store.append(workspaceId, f.store.state(workspaceId).version, [
        { type: 'monitor.stopped', data: { id: 'monitor-1', reason: 'owner_stopped', stoppedAt: iso(base) } }
      ]);
      else {
        f.monitoring.admitDueMonitors({ instanceId: 'scheduler', at: iso(base), limit: 1 });
        if (lifecycle === 'running') f.store.claimServiceJob(workspaceId, 'monitor-worker', iso(base));
        assert.equal(f.store.serviceJobs(workspaceId).items[0].status, lifecycle);
      }
      const before = f.store.state(workspaceId), journal = f.store.journal(workspaceId);
      const jobs = f.store.serviceJobs(workspaceId);
      selections = 0;
      if (boundary === 'direct') {
        assert.throws(() => f.monitoring.reserve(reviewedReservation(f)), /monitor|reservation|plan/i);
        assert.equal(selections, 0, 'Unavailable monitor must be rejected before policy evaluation');
      } else if (boundary === 'reducer')
        assert.throws(() => reduce(before, events[0], before.version + 1), /monitor|reservation|plan/i);
      else assert.throws(() => f.store.append(workspaceId, before.version, events), /monitor|reservation|plan/i);
      assert.deepEqual(f.store.state(workspaceId), before);
      assert.deepEqual(f.store.journal(workspaceId), journal);
      assert.deepEqual(f.store.serviceJobs(workspaceId), jobs);
    });

test('reviewed lifecycle rechecks ownership after direct policy selection', t => {
  const f = fixture({ reviewedPlan, beforeSelection() { pauseReviewedMonitor(f); } });
  t.after(() => f.store.close());
  configure(f, { ...reviewedPolling, control: { version: 1, revision: 0, handoff: null, resume: null } });
  assert.throws(() => f.monitoring.reserve(reviewedReservation(f)), /monitor|reservation|plan/i);
  const state = f.store.state(workspaceId);
  assert.equal(state.monitors['monitor-1'].status, 'paused');
  assert.equal(state.monitoredActionGrants['grant-1'].status, 'active');
  assert.deepEqual(state.actions, {});
});

test('reviewed lifecycle permits scheduled reservation while atomically completing its owned job', async t => {
  const f = fixture({ reviewedPlan, observations: [eligible(iso(base))] });
  t.after(() => f.store.close());
  configure(f, reviewedPolling);
  f.monitoring.admitDueMonitors({ instanceId: 'scheduler', at: iso(base), limit: 1 });
  const job = f.store.claimServiceJob(workspaceId, 'monitor-worker', iso(base));
  assert.equal(f.store.state(workspaceId).monitors['monitor-1'].inFlightJobId, job.id);
  await f.monitoring.runJob(job, currentFence());
  const state = f.store.state(workspaceId);
  assert.equal(f.store.serviceJob(workspaceId, job.id).status, 'finished');
  assert.equal(state.monitors['monitor-1'].status, 'stopped');
  assert.equal(state.monitors['monitor-1'].inFlightJobId, null);
  assert.equal(state.monitoredActionGrants['grant-1'].status, 'blocked');
  assert.equal(f.store.serviceJobs(workspaceId).items.filter(item => item.kind === 'execute').length, 1);
  assert.deepEqual(f.store.rebuild(workspaceId), state);
});

test('reducer rejects reviewed-plan monitor configuration and reservation mismatches', t => {
  const f = fixture({ reviewedPlan });
  t.after(() => f.store.close());
  const state = f.store.state(workspaceId);
  const grant = state.monitoredActionGrants['grant-1'];
  const monitor = { id: reviewedPlan.monitorId, workspaceId, grantId: grant.id, workId: reviewedPlan.workId,
    adapter: grant.adapter, adapterVersion: grant.adapterVersion, connectionId: grant.connectionId,
    connectionGeneration: grant.connectionGeneration, browserProfileId: grant.browserProfileId,
    subjectDigest: grant.subjectDigest, ...reviewedPolling, status: 'active', nextDueAt: iso(base + 2_000),
    requestWindowStartedAt: iso(base), requestsInWindow: 0, lastObservation: null,
    lastCompleteObservationAt: null, lastCompleteCoverage: null, consecutiveFailures: 0, backoffMs: 0,
    pauseReason: null, inFlightJobId: null };

  for (const mismatch of [{ ...monitor, id: 'different-monitor' }, { ...monitor, intervalMs: 4_000 }])
    assert.throws(() => reduce(state, { type: 'monitor.configured', data: { monitor: mismatch } }, state.version + 1),
      /plan|monitor|configuration/i);

  new Operator(f.store, () => iso(base)).setWorkPhase(workspaceId, ownerId, 'work', 'waiting_external');
  const drifted = f.store.state(workspaceId);
  assert.throws(() => reduce(drifted, { type: 'monitor.configured', data: { monitor } }, drifted.version + 1),
    /plan|work|configuration/i);
  const command = f.monitoring.evaluate(grant.id, eligible(iso(base)), { maxObservationAgeMs: 60_000,
    binding: { adapter: grant.adapter, adapterVersion: grant.adapterVersion, connectionId: grant.connectionId,
      connectionGeneration: grant.connectionGeneration, browserProfileId: grant.browserProfileId,
      subjectDigest: grant.subjectDigest } });
  const digest = observationDigest(eligible(iso(base)));
  const action = { id: 'drifted-action', workId: 'work', key: `monitor:${grant.id}:${digest}`, command,
    digest: monitoredActionCommandDigest(workspaceId, 'work', drifted.works.work.revision, grant, command),
    workRevision: drifted.works.work.revision, status: 'approved',
    monitoredGrant: { id: grant.id, digest: grant.digest, revision: grant.revision } };
  assert.throws(() => reduce(drifted,
    { type: 'monitored_action.command_narrowed', data: { grantId: grant.id, action } }, drifted.version + 1),
  /plan|review|work|binding/i);
});

test('atomic admission rejects internally current input that abandoned the reviewed work revision', async t => {
  const f = fixture({ reviewedPlan, observations: [eligible(iso(base))] });
  t.after(() => f.store.close());
  configure(f, reviewedPolling);
  f.monitoring.admitDueMonitors({ instanceId: 'scheduler', at: iso(base), limit: 1 });
  const monitorJob = f.store.claimServiceJob(workspaceId, 'monitor-worker', iso(base));
  const original = f.store.completeMonitorJobAndAdmitAction.bind(f.store);
  let captured;
  f.store.completeMonitorJobAndAdmitAction = (...args) => {
    captured = args;
    return undefined;
  };
  await f.monitoring.runJob(monitorJob, currentFence());
  f.store.completeMonitorJobAndAdmitAction = original;

  new Operator(f.store, () => iso(base)).setWorkPhase(workspaceId, ownerId, 'work', 'waiting_external');
  const current = f.store.state(workspaceId);
  const grant = current.monitoredActionGrants['grant-1'];
  const action = { ...captured[2].action, workRevision: current.works.work.revision };
  action.digest = monitoredActionCommandDigest(workspaceId, action.workId, action.workRevision,
    grant, action.command);
  const driftedInput = { ...captured[2], expectedVersion: current.version, action,
    binding: { ...captured[2].binding, workRevision: action.workRevision } };

  assert.throws(() => original(captured[0], captured[1], driftedInput),
    error => error?.code === 'conflict' && /arm plan/i.test(error.message));

  assert.deepEqual(f.store.state(workspaceId).actions, {});
  assert.equal(f.store.serviceJobs(workspaceId).items.some(job => job.kind === 'execute'), false);
  assert.equal(f.store.serviceJob(workspaceId, monitorJob.id).status, 'running');
  assert.equal(f.monitoring.grant('grant-1').status, 'active');
});

test('scheduled admission rolls back when the original lifecycle is cancelled at the commit boundary', async t => {
  const controller = new AbortController();
  const f = fixture({ observations: [eligible(iso(base))], beforeSelection() { controller.abort(); } });
  t.after(() => f.store.close()); configure(f, { jitterMs: 0 });
  f.monitoring.admitDueMonitors({ instanceId: 'scheduler', at: iso(base), limit: 1 });
  const monitorJob = f.store.claimServiceJob(workspaceId, 'monitor-worker', iso(base));
  const fence = { serviceGeneration: 'service-generation-a', deadline: Date.now() + 10_000,
    signal: controller.signal,
    async assertCurrent() {},
    assertSettlementCurrent() {} };

  await assert.rejects(f.monitoring.runJob(monitorJob, fence), /stopped at cancellation or deadline/);
  assert.deepEqual(f.store.state(workspaceId).actions, {});
  assert.equal(f.store.serviceJobs(workspaceId).items.some(job => job.kind === 'execute'), false);
  assert.equal(f.monitoring.grant('grant-1').status, 'active');
});

test('queued monitor survives restart and a crashed running check is interrupted without replay', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'behalvo-monitor-restart-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const state of ['queued', 'running']) await t.test(state, async () => {
    const path = join(directory, `${state}.db`);
    const firstStore = new SqliteStore(path, { serviceQueue: { upgradeExisting: false } });
    const first = fixture({ store: firstStore });
    configure(first);
    first.monitoring.admitDueMonitors({ instanceId: 'scheduler', at: iso(base), limit: 100 });
    const admitted = firstStore.serviceJobs(workspaceId).items[0];
    if (state === 'running') firstStore.claimServiceJob(workspaceId, 'crashed-worker', iso(base));
    firstStore.close();

    const reopened = new SqliteStore(path, { serviceQueue: { upgradeExisting: false } });
    const restarted = fixture({ store: reopened, existing: true, observations: [complete(iso(base))] });
    try {
      restarted.runtime.start();
      await restarted.runtime.drain();
      const job = reopened.serviceJob(workspaceId, admitted.id);
      assert.equal(job.status, state === 'queued' ? 'finished' : 'interrupted');
      assert.equal(restarted.inspectCalls(), state === 'queued' ? 1 : 0);
      assert.equal(reopened.state(workspaceId).monitors['monitor-1'].inFlightJobId, null);
    } finally {
      await restarted.runtime.shutdown(); reopened.close();
    }
  });
});
