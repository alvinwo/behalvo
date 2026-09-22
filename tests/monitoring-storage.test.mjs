import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { chmodSync, copyFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  MonitoringRegistry, MonitoringService, Operator, SqliteStore, monitoredActionCommandDigest, observationDigest
} from '../dist/index.js';

const workspaceId = 'monitoring-storage';
const ownerId = 'owner';
const now = '2026-09-21T12:00:00.000Z';
const subjectDigest = 'b'.repeat(64);

function adapter() {
  return {
    id: 'synthetic.reserve', version: 1,
    validateScope(value) { return value; },
    coverageSufficient(_scope, coverage) { return coverage?.complete === true; },
    selectCommand({ grant, observation }) {
      const selected = observation.candidates[0];
      if (!selected) return undefined;
      return {
        kind: 'operation.execute', operationId: grant.adapter, operationVersion: String(grant.adapterVersion),
        connectionId: grant.connectionId, provider: 'synthetic-provider', subject: 'synthetic-subject',
        connectionGeneration: grant.connectionGeneration, resourceId: 'resource', arguments: selected,
        affectedResourceIds: ['resource'], precondition: { state: { available: true }, source: 'synthetic-monitor',
          observedAt: observation.observedAt }, expectedResult: selected, subjectRevision: 0,
        requestFingerprint: 'c'.repeat(64)
      };
    }
  };
}

async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'behalvo-monitoring-storage-'));
  chmodSync(directory, 0o700);
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'monitoring.db');
  const store = new SqliteStore(path, {
    serviceQueue: { upgradeExisting: false }, ...(options.key ? { encryptionKey: options.key } : {})
  });
  store.createWorkspace(workspaceId, ownerId);
  const operator = new Operator(store, () => now);
  operator.createWork(workspaceId, ownerId, {
    id: 'work', title: 'Synthetic monitor', goal: 'Reserve once', threadId: 'thread'
  });
  store.append(workspaceId, store.state(workspaceId).version, [{ type: 'connection.registered', data: { connection: {
    id: 'connection-a', provider: 'synthetic-provider', subject: 'synthetic-subject', label: 'Synthetic',
    generation: 1, status: 'active'
  } } }], { actorId: ownerId, recordedAt: now });
  const registry = new MonitoringRegistry(); registry.register(adapter());
  const service = new MonitoringService(store, registry, {
    workspaceId, ownerId, installationGeneration: options.installationGeneration ?? 'installation-a', clock: () => now
  });
  const proposed = service.proposeGrant({
    id: 'grant-1', workspaceId, ownerId, adapter: 'synthetic.reserve', adapterVersion: 1,
    connectionId: 'connection-a', connectionGeneration: 1, browserProfileId: 'profile-a',
    subjectDigest, scope: { operation: 'reserve' }, maximumEffects: 1,
    expiresAt: '2026-09-22T12:00:00.000Z'
  });
  if (!options.pending)
    service.activateGrant({ ownerId, grantId: proposed.id, digest: proposed.digest, revision: proposed.revision });
  return { directory, path, store, registry, service, grant: proposed };
}

function observation(candidate = { value: 'first' }) {
  return { observedAt: now, complete: true, coverage: { complete: true }, candidates: [candidate], result: 'complete' };
}

function binding(extra = {}) {
  return { adapter: 'synthetic.reserve', adapterVersion: 1, connectionId: 'connection-a',
    connectionGeneration: 1, browserProfileId: 'profile-a', subjectDigest, ...extra };
}

function recordVerification(store, actionId, status, options = {}) {
  const action = store.state(workspaceId).actions[actionId];
  store.append(workspaceId, store.state(workspaceId).version, [{ type: 'action.verification_recorded', data: {
    id: actionId, verification: { status, recordedAt: options.recordedAt ?? now, observation: {
      connectionId: action.command.connectionId, provider: action.command.provider, subject: action.command.subject,
      connectionGeneration: action.command.connectionGeneration, resourceId: action.command.resourceId,
      source: 'synthetic-readback', observedAt: options.observedAt ?? now, state: { verified: status },
      ...(options.observation ?? {})
    } }
  } }], { recordedAt: options.recordedAt ?? now });
}

function reservationEvents(f, { extraAction, keyDigest = observationDigest(observation()),
  reservationDigest = observationDigest(observation()), includeStart = true } = {}) {
  const grant = f.store.state(workspaceId).monitoredActionGrants['grant-1'];
  const work = f.store.state(workspaceId).works.work;
  const command = f.service.evaluate(grant.id, observation(), { maxObservationAgeMs: 60_000, binding: binding() });
  const action = { id: 'action-malformed', workId: work.id, key: `monitor:${grant.id}:${keyDigest}`,
    command, digest: monitoredActionCommandDigest(workspaceId, work.id, work.revision, grant, command),
    workRevision: work.revision, status: 'approved', monitoredGrant: {
      id: grant.id, digest: grant.digest, revision: grant.revision
    }, ...(extraAction ?? {}) };
  return [
    { type: 'monitored_action.command_narrowed', data: { grantId: grant.id, action } },
    { type: 'monitored_action.grant_reserved', data: { id: grant.id, digest: grant.digest, revision: grant.revision,
      actionId: action.id, attemptId: 'attempt-malformed', observationDigest: reservationDigest, reservedAt: now } },
    ...(includeStart ? [{ type: 'action.started', data: { id: action.id, attemptId: 'attempt-malformed' } }] : [])
  ];
}

test('the sole allowance and action.started commit atomically under concurrency', async t => {
  const f = await fixture(t);
  t.after(() => f.store.close());
  const secondStore = new SqliteStore(f.path, { serviceQueue: { upgradeExisting: false } });
  t.after(() => secondStore.close());
  const secondRegistry = new MonitoringRegistry(); secondRegistry.register(adapter());
  const second = new MonitoringService(secondStore, secondRegistry, {
    workspaceId, ownerId, installationGeneration: 'installation-a', clock: () => now
  });

  const attempts = [
    () => f.service.reserve({ grantId: 'grant-1', workId: 'work', observation: observation({ value: 'first' }),
      maxObservationAgeMs: 60_000, binding: binding(), actionId: 'action-a', attemptId: 'attempt-a' }),
    () => second.reserve({ grantId: 'grant-1', workId: 'work', observation: observation({ value: 'second' }),
      maxObservationAgeMs: 60_000, binding: binding(), actionId: 'action-b', attemptId: 'attempt-b' })
  ];
  const results = attempts.map(run => { try { return { value: run() }; } catch (error) { return { error }; } });
  assert.equal(results.filter(result => result.value).length, 1);
  assert.equal(results.filter(result => result.error).length, 1);
  const state = f.store.state(workspaceId);
  const running = Object.values(state.actions).filter(action => action.status === 'running');
  assert.equal(running.length, 1);
  const grant = state.monitoredActionGrants['grant-1'];
  assert.equal(grant.status, 'blocked');
  assert.equal(grant.reservedActionId, running[0].id);
  const relevant = f.store.journal(workspaceId).filter(record =>
    ['monitored_action.grant_reserved', 'action.started'].includes(record.event.type));
  assert.deepEqual(relevant.map(record => record.event.type),
    ['monitored_action.grant_reserved', 'action.started']);
  assert.equal(relevant[0].seq + 1, relevant[1].seq);
});

test('a failed reservation transaction leaves neither an action start nor spent capacity', async t => {
  const f = await fixture(t);
  t.after(() => f.store.close());
  const before = f.store.state(workspaceId);
  assert.throws(() => f.service.reserve({ grantId: 'grant-1', workId: 'work', observation: observation(),
    maxObservationAgeMs: 60_000, binding: binding(), actionId: 'action-rollback', attemptId: 'attempt-rollback',
    beforeCommit() { throw new Error('synthetic crash before commit'); } }), /synthetic crash/);
  assert.deepEqual(f.store.state(workspaceId), before);
  assert.equal(f.store.journal(workspaceId).some(record => record.event.type === 'action.started'), false);

  const action = f.service.reserve({ grantId: 'grant-1', workId: 'work', observation: observation(),
    maxObservationAgeMs: 60_000, binding: binding(), actionId: 'action-after-crash', attemptId: 'attempt-after-crash' });
  assert.equal(action.status, 'running');
});

test('monitored reservation journal rejects unknown action fields, digest mismatch, and a missing start atomically', async t => {
  for (const options of [
    { extraAction: { injected: true } },
    { reservationDigest: 'f'.repeat(64) },
    { includeStart: false }
  ]) {
    const f = await fixture(t);
    const events = reservationEvents(f, options);
    const before = f.store.state(workspaceId);
    assert.throws(() => f.store.append(workspaceId, before.version, events, { recordedAt: now }),
      /action|observation|reservation|start|monitored/i);
    assert.deepEqual(f.store.state(workspaceId), before);
    f.store.close();
  }
});

test('unknown and negative readback retain the reservation across restart and new IDs', async t => {
  const f = await fixture(t);
  const action = f.service.reserve({ grantId: 'grant-1', workId: 'work', observation: observation(),
    maxObservationAgeMs: 60_000, binding: binding(), actionId: 'action-original', attemptId: 'attempt-original' });
  f.store.finishActionAttempt(workspaceId, action.id, action.attemptId, 'unknown', 'Synthetic unknown outcome', { recordedAt: now });
  const settled = f.service.settleGrant({ grantId: 'grant-1', actionId: action.id, outcome: 'unknown' });
  assert.equal(settled.status, 'blocked');
  f.store.close();

  const reopened = new SqliteStore(f.path, { serviceQueue: { upgradeExisting: false } });
  t.after(() => reopened.close());
  const registry = new MonitoringRegistry(); registry.register(adapter());
  const restarted = new MonitoringService(reopened, registry, {
    workspaceId, ownerId, installationGeneration: 'installation-a', clock: () => now
  });
  assert.throws(() => restarted.reserve({ grantId: 'grant-1', workId: 'work', observation: observation({ value: 'new' }),
    maxObservationAgeMs: 60_000, binding: binding(), actionId: 'action-new', attemptId: 'attempt-new' }),
  /allowance|reserved|blocked|active/i);
  assert.equal(reopened.state(workspaceId).monitoredActionGrants['grant-1'].reservedActionId, 'action-original');
});

test('verified readback monotonically upgrades an unresolved settlement without releasing its reservation', async t => {
  const f = await fixture(t);
  const action = f.service.reserve({ grantId: 'grant-1', workId: 'work', observation: observation(),
    maxObservationAgeMs: 60_000, binding: binding(), actionId: 'action-upgrade', attemptId: 'attempt-upgrade' });
  f.store.finishActionAttempt(workspaceId, action.id, action.attemptId, 'accepted', 'Synthetic accepted outcome',
    { recordedAt: now });
  assert.equal(f.service.settleGrant({ grantId: 'grant-1', actionId: action.id,
    outcome: 'accepted_unverified' }).status, 'blocked');
  f.store.close();

  const reopened = new SqliteStore(f.path, { serviceQueue: { upgradeExisting: false } });
  t.after(() => reopened.close());
  const registry = new MonitoringRegistry(); registry.register(adapter());
  const restarted = new MonitoringService(reopened, registry, {
    workspaceId, ownerId, installationGeneration: 'installation-a', clock: () => now
  });
  recordVerification(reopened, action.id, 'satisfied');
  const consumed = restarted.settleGrant({ grantId: 'grant-1', actionId: action.id, outcome: 'accepted_verified' });
  assert.equal(consumed.status, 'consumed');
  assert.equal(consumed.reservedActionId, action.id);
  assert.equal(consumed.reservationAttemptId, action.attemptId);
  const version = reopened.state(workspaceId).version;
  assert.equal(restarted.settleGrant({ grantId: 'grant-1', actionId: action.id,
    outcome: 'accepted_verified' }).status, 'consumed');
  assert.equal(reopened.state(workspaceId).version, version);
});

test('satisfied reconciliation monotonically upgrades an unknown settlement without resubmission', async t => {
  const f = await fixture(t);
  t.after(() => f.store.close());
  const action = f.service.reserve({ grantId: 'grant-1', workId: 'work', observation: observation(),
    maxObservationAgeMs: 60_000, binding: binding(), actionId: 'action-unknown-upgrade', attemptId: 'attempt-unknown-upgrade' });
  f.store.finishActionAttempt(workspaceId, action.id, action.attemptId, 'unknown', 'Synthetic unknown outcome',
    { recordedAt: now });
  f.service.settleGrant({ grantId: 'grant-1', actionId: action.id, outcome: 'unknown' });
  const evidenceRef = f.store.putArtifact(workspaceId, 'Synthetic reconciliation evidence');
  f.store.append(workspaceId, f.store.state(workspaceId).version,
    [{ type: 'action.reconciled', data: { id: action.id, status: 'accepted', evidenceRef } }], { recordedAt: now });
  recordVerification(f.store, action.id, 'satisfied');

  const consumed = f.service.settleGrant({ grantId: 'grant-1', actionId: action.id, outcome: 'accepted_verified' });
  assert.equal(consumed.status, 'consumed');
  assert.equal(consumed.reservedActionId, action.id);
  assert.equal(Object.keys(f.store.state(workspaceId).actions).length, 1);
});

test('not-satisfied settlement requires exact trusted readback evidence and never releases allowance', async t => {
  const f = await fixture(t);
  t.after(() => f.store.close());
  const action = f.service.reserve({ grantId: 'grant-1', workId: 'work', observation: observation(),
    maxObservationAgeMs: 60_000, binding: binding(), actionId: 'action-negative', attemptId: 'attempt-negative' });
  f.store.finishActionAttempt(workspaceId, action.id, action.attemptId, 'accepted', 'Synthetic accepted outcome',
    { recordedAt: now });
  assert.throws(() => f.service.settleGrant({ grantId: 'grant-1', actionId: action.id,
    outcome: 'not_satisfied' }), /verification|evidence|settlement/i);
  recordVerification(f.store, action.id, 'not_satisfied');
  const blocked = f.service.settleGrant({ grantId: 'grant-1', actionId: action.id, outcome: 'not_satisfied' });
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.reservedActionId, action.id);
});

test('later exact satisfied readback consumes a not-satisfied reservation without another mutation', async t => {
  const f = await fixture(t);
  const action = f.service.reserve({ grantId: 'grant-1', workId: 'work', observation: observation(),
    maxObservationAgeMs: 60_000, binding: binding(), actionId: 'action-negative-upgrade',
    attemptId: 'attempt-negative-upgrade' });
  f.store.finishActionAttempt(workspaceId, action.id, action.attemptId, 'accepted', 'Synthetic accepted outcome',
    { recordedAt: now });
  recordVerification(f.store, action.id, 'not_satisfied');
  const blocked = f.service.settleGrant({ grantId: 'grant-1', actionId: action.id, outcome: 'not_satisfied' });
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.reservedActionId, action.id);
  f.store.close();

  const reopened = new SqliteStore(f.path, { serviceQueue: { upgradeExisting: false } });
  t.after(() => reopened.close());
  const registry = new MonitoringRegistry(); registry.register(adapter());
  const restarted = new MonitoringService(reopened, registry, {
    workspaceId, ownerId, installationGeneration: 'installation-a', clock: () => now
  });

  assert.throws(() => restarted.settleGrant({ grantId: 'grant-1', actionId: action.id,
    outcome: 'accepted_verified' }), /verification|evidence|settlement/i);
  assert.throws(() => recordVerification(reopened, action.id, 'satisfied', {
    recordedAt: '2026-09-21T12:00:00.001Z', observation: { resourceId: 'foreign-resource' }
  }), /scope|verification|evidence/i);

  recordVerification(reopened, action.id, 'satisfied', {
    recordedAt: '2026-09-21T12:00:00.001Z', observedAt: '2026-09-21T12:00:00.001Z'
  });
  const consumed = restarted.settleGrant({ grantId: 'grant-1', actionId: action.id, outcome: 'accepted_verified' });
  assert.equal(consumed.status, 'consumed');
  assert.equal(consumed.reservedActionId, action.id);
  assert.equal(consumed.reservationAttemptId, action.attemptId);
  assert.equal(Object.keys(reopened.state(workspaceId).actions).length, 1);
  const version = reopened.state(workspaceId).version;
  assert.equal(restarted.settleGrant({ grantId: 'grant-1', actionId: action.id,
    outcome: 'accepted_verified' }).status, 'consumed');
  assert.equal(reopened.state(workspaceId).version, version);
  assert.throws(() => restarted.reserve({ grantId: 'grant-1', workId: 'work', observation: observation({ value: 'second' }),
    maxObservationAgeMs: 60_000, binding: binding(), actionId: 'action-second', attemptId: 'attempt-second' }),
  /allowance|reserved|blocked|active/i);
});

test('negative settlement requires strictly later recorded and observed readback evidence while legacy replay remains valid', async t => {
  const cases = [
    { name: 'equal evidence time', recordedAt: now, observedAt: now },
    { name: 'older provider observation', recordedAt: '2026-09-21T12:00:00.001Z',
      observedAt: '2026-09-21T11:59:59.999Z' },
    { name: 'legacy non-monotonic record time', recordedAt: '2026-09-21T11:59:59.999Z',
      observedAt: '2026-09-21T11:59:59.999Z' }
  ];
  for (const [index, item] of cases.entries()) {
    const f = await fixture(t);
    const action = f.service.reserve({ grantId: 'grant-1', workId: 'work', observation: observation(),
      maxObservationAgeMs: 60_000, binding: binding(), actionId: `action-stale-${index}`,
      attemptId: `attempt-stale-${index}` });
    f.store.finishActionAttempt(workspaceId, action.id, action.attemptId, 'accepted', 'Synthetic accepted outcome',
      { recordedAt: now });
    recordVerification(f.store, action.id, 'not_satisfied');
    f.service.settleGrant({ grantId: 'grant-1', actionId: action.id, outcome: 'not_satisfied' });

    recordVerification(f.store, action.id, 'satisfied', {
      recordedAt: item.recordedAt, observedAt: item.observedAt
    });
    assert.equal(f.store.rebuild(workspaceId).actions[action.id].verification.status, 'satisfied', item.name);
    assert.throws(() => f.service.settleGrant({ grantId: 'grant-1', actionId: action.id,
      outcome: 'accepted_verified' }), /verification|evidence|stale|later/i, item.name);
    assert.equal(f.store.state(workspaceId).monitoredActionGrants['grant-1'].status, 'blocked', item.name);
    assert.equal(f.store.state(workspaceId).monitoredActionGrants['grant-1'].reservedActionId, action.id, item.name);
    f.store.close();
  }
});

test('caller installation labels do not impersonate or rotate the trusted local generation', async t => {
  const f = await fixture(t);
  f.store.close();
  const restored = new SqliteStore(f.path, { serviceQueue: { upgradeExisting: false } });
  t.after(() => restored.close());
  const registry = new MonitoringRegistry(); registry.register(adapter());
  const copied = new MonitoringService(restored, registry, {
    workspaceId, ownerId, installationGeneration: 'installation-restored', clock: () => now
  });
  assert.equal(copied.reserve({ grantId: 'grant-1', workId: 'work', observation: observation(),
    maxObservationAgeMs: 60_000, binding: binding(), actionId: 'action-normal-restart', attemptId: 'attempt-normal-restart' }).status, 'running');
});

test('encrypted restored copy cannot reserve under a reused caller label until explicit owner reconciliation',
    { skip: process.platform === 'win32' }, async t => {
  const key = randomBytes(32);
  const f = await fixture(t, { key });
  t.after(() => f.store.close());
  const backup = join(f.directory, 'active-backup.db');
  await f.store.backup(backup);

  const restored = new SqliteStore(backup, { encryptionKey: Uint8Array.from(key),
    serviceQueue: { upgradeExisting: false } });
  t.after(() => restored.close());
  const registry = new MonitoringRegistry(); registry.register(adapter());
  const copied = new MonitoringService(restored, registry, {
    workspaceId, ownerId, installationGeneration: 'installation-a', clock: () => now
  });
  assert.equal(copied.grant('grant-1').status, 'blocked');
  assert.throws(() => copied.reserve({ grantId: 'grant-1', workId: 'work', observation: observation(),
    maxObservationAgeMs: 60_000, binding: binding(), actionId: 'action-before-reconcile', attemptId: 'attempt-before-reconcile' }),
  /installation|reconcil|blocked/i);
  assert.throws(() => copied.reconcileInstallation({ ownerId: 'other', grantId: 'grant-1',
    digest: f.grant.digest, revision: 1 }), /owner|denied/i);
  const reconciled = copied.reconcileInstallation({ ownerId, grantId: 'grant-1', digest: f.grant.digest, revision: 1 });
  assert.equal(reconciled.status, 'active');
  assert.equal(copied.reserve({ grantId: 'grant-1', workId: 'work', observation: observation(),
    maxObservationAgeMs: 60_000, binding: binding(), actionId: 'action-after-reconcile', attemptId: 'attempt-after-reconcile' }).status, 'running');
});

test('raw encrypted database copy cannot preserve active installation authority',
    { skip: process.platform === 'win32' }, async t => {
  const key = randomBytes(32);
  const f = await fixture(t, { key });
  const copiedPath = join(f.directory, 'raw-copy.db');
  f.store.close();
  copyFileSync(f.path, copiedPath);
  const copiedStore = new SqliteStore(copiedPath, { encryptionKey: Uint8Array.from(key),
    serviceQueue: { upgradeExisting: false } });
  t.after(() => copiedStore.close());
  const registry = new MonitoringRegistry(); registry.register(adapter());
  const copied = new MonitoringService(copiedStore, registry, {
    workspaceId, ownerId, installationGeneration: 'installation-a', clock: () => now
  });

  const grant = copied.grant('grant-1');
  assert.equal(grant.status, 'blocked');
  assert.throws(() => copied.reserve({ grantId: grant.id, workId: 'work', observation: observation(),
    maxObservationAgeMs: 60_000, binding: binding(), actionId: 'action-raw-copy', attemptId: 'attempt-raw-copy' }),
  /installation|reconcil|blocked/i);
  assert.equal(copied.reconcileInstallation({ ownerId, grantId: grant.id,
    digest: grant.digest, revision: grant.revision }).status, 'active');
});

test('restored installation reconciles each active grant without reopening global authority',
    { skip: process.platform === 'win32' }, async t => {
  const key = randomBytes(32);
  const f = await fixture(t, { key });
  t.after(() => f.store.close());
  const second = f.service.proposeGrant({
    id: 'grant-2', workspaceId, ownerId, adapter: 'synthetic.reserve', adapterVersion: 1,
    connectionId: 'connection-a', connectionGeneration: 1, browserProfileId: 'profile-a',
    subjectDigest, scope: { operation: 'reserve-second' }, maximumEffects: 1,
    expiresAt: '2026-09-22T12:00:00.000Z'
  });
  f.service.activateGrant({ ownerId, grantId: second.id, digest: second.digest, revision: second.revision });
  const backup = join(f.directory, 'multi-grant-backup.db');
  await f.store.backup(backup);
  const restored = new SqliteStore(backup, { encryptionKey: Uint8Array.from(key),
    serviceQueue: { upgradeExisting: false } });
  t.after(() => restored.close());
  const registry = new MonitoringRegistry(); registry.register(adapter());
  const copied = new MonitoringService(restored, registry, {
    workspaceId, ownerId, installationGeneration: 'installation-a', clock: () => now
  });

  const first = copied.grant('grant-1');
  copied.reconcileInstallation({ ownerId, grantId: first.id, digest: first.digest, revision: first.revision });
  const stillBlocked = copied.grant('grant-2');
  assert.equal(stillBlocked.status, 'blocked');
  const reconciled = copied.reconcileInstallation({ ownerId, grantId: stillBlocked.id,
    digest: stillBlocked.digest, revision: stillBlocked.revision });
  assert.equal(reconciled.status, 'active');
});

test('explicit reconciliation can reactivate a restored installation that contains only a pending grant',
    { skip: process.platform === 'win32' }, async t => {
  const key = randomBytes(32);
  const f = await fixture(t, { key, pending: true });
  t.after(() => f.store.close());
  const backup = join(f.directory, 'pending-backup.db');
  await f.store.backup(backup);
  const restored = new SqliteStore(backup, { encryptionKey: Uint8Array.from(key),
    serviceQueue: { upgradeExisting: false } });
  t.after(() => restored.close());
  const registry = new MonitoringRegistry(); registry.register(adapter());
  const copied = new MonitoringService(restored, registry, {
    workspaceId, ownerId, installationGeneration: 'installation-a', clock: () => now
  });

  const pending = copied.grant('grant-1');
  assert.equal(pending.status, 'pending');
  copied.reconcileInstallation({ ownerId, grantId: pending.id, digest: pending.digest, revision: pending.revision });
  const active = copied.activateGrant({ ownerId, grantId: pending.id, digest: pending.digest, revision: pending.revision });
  assert.equal(active.status, 'active');
});

test('encrypted backup and restore preserve monitored provenance and the restored-copy barrier', { skip: process.platform === 'win32' }, async t => {
  const key = randomBytes(32);
  const f = await fixture(t, { key });
  t.after(() => f.store.close());
  const action = f.service.reserve({ grantId: 'grant-1', workId: 'work', observation: observation(),
    maxObservationAgeMs: 60_000, binding: binding(), actionId: 'action-backup', attemptId: 'attempt-backup' });
  f.store.finishActionAttempt(workspaceId, action.id, action.attemptId, 'unknown', 'Synthetic unknown outcome', { recordedAt: now });
  f.service.settleGrant({ grantId: 'grant-1', actionId: action.id, outcome: 'unknown' });
  const originalGeneration = f.store.state(workspaceId).monitoredActionGrants['grant-1'].installationGeneration;
  const backup = join(f.directory, 'backup.db');
  await f.store.backup(backup);

  const restored = new SqliteStore(backup, { encryptionKey: Uint8Array.from(key), readOnly: true });
  try {
    const grant = restored.state(workspaceId).monitoredActionGrants['grant-1'];
    assert.equal(grant.status, 'blocked');
    assert.equal(grant.reservedActionId, action.id);
    assert.equal(grant.installationGeneration, originalGeneration);
    assert.deepEqual(restored.journal(workspaceId).filter(record =>
      ['monitored_action.grant_reserved', 'action.started', 'monitored_action.grant_settled'].includes(record.event.type))
      .map(record => record.event.type),
    ['monitored_action.grant_reserved', 'action.started', 'monitored_action.grant_settled']);
  } finally { restored.close(); }
});

test('replay and encrypted snapshot verification reject a reservation whose required start is missing',
    { skip: process.platform === 'win32' }, async t => {
  const key = randomBytes(32);
  const f = await fixture(t, { key });
  const action = f.service.reserve({ grantId: 'grant-1', workId: 'work', observation: observation(),
    maxObservationAgeMs: 60_000, binding: binding(), actionId: 'action-tampered', attemptId: 'attempt-tampered' });
  const started = f.store.journal(workspaceId).find(record =>
    record.event.type === 'action.started' && record.event.data.id === action.id);
  f.store.close();

  const raw = new DatabaseSync(f.path);
  raw.exec('DROP TRIGGER journal_no_delete');
  raw.prepare('DELETE FROM journal WHERE workspace_id=? AND seq=?').run(workspaceId, started.seq);
  raw.exec("CREATE TRIGGER journal_no_delete BEFORE DELETE ON journal BEGIN SELECT RAISE(ABORT,'journal is append-only'); END");
  raw.close();

  const tampered = new SqliteStore(f.path, { encryptionKey: Uint8Array.from(key),
    serviceQueue: { upgradeExisting: false } });
  t.after(() => tampered.close());
  assert.throws(() => tampered.rebuild(workspaceId), /reservation|start|monitored/i);
  await assert.rejects(tampered.backup(join(f.directory, 'tampered-backup.db')), /private file operation failed/i);
});
