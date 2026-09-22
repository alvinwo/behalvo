import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  MonitoringRegistry, MonitoringService, Operator, ServiceRuntime, SqliteStore
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
      id: 'connection-a', provider: 'synthetic-provider', subject: 'synthetic-subject', label: 'Synthetic',
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
      const selected = observation.candidates[0];
      if (!selected) return undefined;
      return {
        kind: 'operation.execute', operationId: grant.adapter, operationVersion: String(grant.adapterVersion),
        connectionId: grant.connectionId, provider: 'synthetic-provider', subject: 'synthetic-subject',
        connectionGeneration: 1, resourceId: 'resource', arguments: selected, affectedResourceIds: ['resource'],
        precondition: { state: {}, source: 'synthetic-monitor', observedAt: observation.observedAt },
        expectedResult: selected, subjectRevision: 0, requestFingerprint: 'e'.repeat(64)
      };
    },
    async inspect(input) {
      inspectCalls++;
      const next = observations.shift();
      if (!next) throw new Error('No synthetic observation configured');
      return typeof next === 'function' ? next(input) : next;
    }
  });
  const monitoring = new MonitoringService(store, registry, {
    workspaceId, ownerId, installationGeneration: 'installation-a',
    clock: () => iso(clock.milliseconds), random: options.random ?? (() => 0.5)
  });
  if (!options.existing) {
    const grant = monitoring.proposeGrant({
      id: 'grant-1', workspaceId, ownerId, adapter: 'synthetic.observe', adapterVersion: 1,
      connectionId: 'connection-a', connectionGeneration: 1, browserProfileId: 'profile-a', subjectDigest,
      scope: { operation: 'observe' }, maximumEffects: 1, expiresAt: iso(base + 86_400_000)
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
    backoffBaseMs: extra.backoffBaseMs ?? 60_000, backoffMaxMs: extra.backoffMaxMs ?? 600_000 });
}

function complete(at, extra = {}) {
  return { observedAt: at, complete: true, coverage: { complete: true }, candidates: [], result: 'complete', ...extra };
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
  release(complete(iso(base)));
  assert.equal(released, true, 'grant revocation must release a non-cooperative inspector');
  assert.equal(f.runtime.snapshot().faulted, false);
  assert.equal(f.store.serviceJob(workspaceId, terminal.id).status, 'stopped');
  assert.equal(f.store.state(workspaceId).monitors['monitor-1'].lastObservation, null);
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
