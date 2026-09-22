import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MonitoringRegistry, MonitoringService, Operator, SqliteStore,
  evaluateMonitoredAction, monitoredActionGrantDigest
} from '../dist/index.js';

const workspaceId = 'monitoring-policy';
const ownerId = 'owner';
const now = '2026-09-21T12:00:00.000Z';
const expiresAt = '2026-09-22T12:00:00.000Z';

function adapter() {
  return {
    id: 'synthetic.reserve', version: 1,
    validateScope(value) {
      if (!value || typeof value !== 'object' || Array.isArray(value) ||
          Object.keys(value).some(key => !['resourceId', 'allowedCities'].includes(key)) ||
          typeof value.resourceId !== 'string' || !Array.isArray(value.allowedCities) ||
          value.allowedCities.some(city => typeof city !== 'string') || value.allowedCities.length === 0)
        throw new Error('Prohibited or invalid synthetic scope');
      return { resourceId: value.resourceId, allowedCities: [...value.allowedCities].sort() };
    },
    coverageSufficient(scope, coverage) {
      return coverage?.resourceId === scope.resourceId && coverage?.complete === true;
    },
    selectCommand({ grant, scope, observation }) {
      const eligible = observation.candidates
        .filter(candidate => scope.allowedCities.includes(candidate.city))
        .sort((left, right) => left.city.localeCompare(right.city));
      const selected = eligible[0];
      if (!selected) return undefined;
      return {
        kind: 'operation.execute', operationId: grant.adapter, operationVersion: String(grant.adapterVersion),
        connectionId: grant.connectionId, provider: 'synthetic-provider', subject: 'synthetic-subject',
        connectionGeneration: grant.connectionGeneration, resourceId: scope.resourceId,
        arguments: { city: selected.city }, affectedResourceIds: [scope.resourceId],
        precondition: { state: { available: true }, source: 'synthetic-monitor', observedAt: observation.observedAt },
        expectedResult: { city: selected.city }, subjectRevision: 0,
        requestFingerprint: 'a'.repeat(64)
      };
    }
  };
}

function fixture() {
  const store = new SqliteStore(':memory:', { serviceQueue: { upgradeExisting: false } });
  store.createWorkspace(workspaceId, ownerId);
  const operator = new Operator(store, () => now);
  operator.createWork(workspaceId, ownerId, {
    id: 'work', title: 'Synthetic monitor', goal: 'Exercise monitored authority', threadId: 'thread'
  });
  store.append(workspaceId, store.state(workspaceId).version, [{ type: 'connection.registered', data: { connection: {
    id: 'connection-a', provider: 'synthetic-provider', subject: 'synthetic-subject', label: 'Synthetic',
    generation: 1, status: 'active'
  } } }], { actorId: ownerId, recordedAt: now });
  const registry = new MonitoringRegistry();
  registry.register(adapter());
  const service = new MonitoringService(store, registry, {
    workspaceId, ownerId, installationGeneration: 'installation-a', clock: () => now
  });
  return { store, registry, service };
}

function proposal(scope = { resourceId: 'profile', allowedCities: ['Zurich', 'Beijing'] }) {
  return {
    id: 'grant-1', workspaceId, ownerId, adapter: 'synthetic.reserve', adapterVersion: 1,
    connectionId: 'connection-a', connectionGeneration: 1, browserProfileId: 'profile-a',
    subjectDigest: 'b'.repeat(64), scope, maximumEffects: 1, expiresAt
  };
}

function observation(extra = {}) {
  return {
    observedAt: now, complete: true, coverage: { resourceId: 'profile', complete: true },
    candidates: [{ city: 'Zurich' }, { city: 'Beijing' }], result: 'complete', ...extra
  };
}

test('grant digest is canonical and immutable while routine observations leave revision unchanged', () => {
  const f = fixture();
  try {
    const first = f.service.proposeGrant(proposal());
    assert.equal(first.revision, 1);
    assert.equal(first.status, 'pending');
    assert.equal(first.digest, monitoredActionGrantDigest(first));
    assert.equal(first.digest, monitoredActionGrantDigest({ ...first,
      scope: { allowedCities: ['Beijing', 'Zurich'], resourceId: 'profile' } }));
    const active = f.service.activateGrant({ ownerId, grantId: first.id, digest: first.digest, revision: 1 });
    assert.equal(active.status, 'active');
    assert.equal(active.revision, 1);

    const monitor = f.service.configureMonitor({ ownerId, id: 'monitor-1', grantId: first.id, workId: 'work',
      nextDueAt: now, maxObservationAgeMs: 60_000, intervalMs: 60_000, jitterMs: 5_000,
      requestBudget: 3, requestWindowMs: 300_000, backoffBaseMs: 60_000, backoffMaxMs: 600_000 });
    f.service.recordObservation(monitor.id, observation(), { jobId: 'manual-observation', observedAt: now });
    assert.equal(f.store.state(workspaceId).monitoredActionGrants[first.id].revision, 1);
    assert.equal(f.store.state(workspaceId).monitors[monitor.id].lastCompleteObservationAt, now);

    const before = f.store.state(workspaceId);
    f.store.rebuild(workspaceId);
    assert.deepEqual(f.store.state(workspaceId), before, 'replay is read/reduce only');
  } finally { f.store.close(); }
});

test('proposal and activation reject prohibited scope, unknown fields, wrong owner, expiry, and maximum effects', () => {
  const f = fixture();
  try {
    assert.throws(() => f.service.proposeGrant(proposal({ resourceId: 'profile', arbitraryMutation: true })),
      /scope|prohibited|invalid/i);
    assert.throws(() => f.service.proposeGrant({ ...proposal(), maximumEffects: 2 }), /maximum|effect/i);
    assert.throws(() => f.service.proposeGrant({ ...proposal(), unexpected: 'field' }), /unknown|field/i);
    const grant = f.service.proposeGrant(proposal());
    assert.throws(() => f.service.activateGrant({ ownerId: 'other', grantId: grant.id,
      digest: grant.digest, revision: grant.revision }), /owner|denied/i);
    assert.throws(() => f.service.activateGrant({ ownerId, grantId: grant.id,
      digest: '0'.repeat(64), revision: grant.revision }), /digest|binding/i);
    const poisonedBase = { ...grant, id: 'grant-poisoned', revokedAt: now };
    const poisoned = { ...poisonedBase, digest: monitoredActionGrantDigest(poisonedBase) };
    assert.throws(() => f.store.append(workspaceId, f.store.state(workspaceId).version,
      [{ type: 'monitored_action.grant_proposed', data: { grant: poisoned } }],
      { actorId: ownerId, recordedAt: now }), /status|provenance|revok|invalid/i);
    const active = f.service.activateGrant({ ownerId, grantId: grant.id,
      digest: grant.digest, revision: grant.revision });
    assert.equal(active.installationGeneration, f.store.monitorInstallation().generation);
    assert.throws(() => f.service.proposeGrant({ ...proposal(), id: 'expired-grant', expiresAt: now }), /expiry|future/i);
  } finally { f.store.close(); }
});

test('only a complete fresh sufficiently covered observation produces one exact command', () => {
  const f = fixture();
  try {
    const pending = f.service.proposeGrant(proposal());
    const grant = f.service.activateGrant({ ownerId, grantId: pending.id,
      digest: pending.digest, revision: pending.revision });
    const policy = f.registry.resolve(grant.adapter, grant.adapterVersion);
    const context = { now, maxObservationAgeMs: 60_000,
      connection: { id: 'connection-a', provider: 'synthetic-provider', subject: 'synthetic-subject', generation: 1, status: 'active' } };

    const command = evaluateMonitoredAction(grant, observation(), policy, context);
    assert.equal(command.arguments.city, 'Beijing');
    assert.equal(command.precondition.observedAt, now);
    assert.throws(() => evaluateMonitoredAction(grant, observation({ complete: false }), policy, context), /complete/i);
    assert.throws(() => evaluateMonitoredAction(grant,
      observation({ observedAt: '2026-09-21T11:58:00.000Z' }), policy, context), /fresh|stale/i);
    assert.throws(() => evaluateMonitoredAction(grant,
      observation({ coverage: { resourceId: 'profile', complete: false } }), policy, context), /coverage/i);
    assert.equal(evaluateMonitoredAction(grant, observation({ candidates: [] }), policy, context), undefined);
  } finally { f.store.close(); }
});

test('revocation and expiry fail closed and material drift revokes before narrowing', () => {
  const f = fixture();
  try {
    const first = f.service.proposeGrant(proposal());
    f.service.activateGrant({ ownerId, grantId: first.id, digest: first.digest, revision: first.revision });
    const revoked = f.service.revokeGrant({ ownerId, grantId: first.id, digest: first.digest,
      revision: first.revision, reason: 'owner_revoked' });
    assert.equal(revoked.status, 'revoked');
    assert.throws(() => f.service.evaluate(first.id, observation(), { maxObservationAgeMs: 60_000,
      binding: { adapter: 'synthetic.reserve', adapterVersion: 1, connectionId: 'connection-a',
        connectionGeneration: 1, browserProfileId: 'profile-a', subjectDigest: 'b'.repeat(64) } }), /revoked|active/i);

    const second = f.service.proposeGrant({ ...proposal(), id: 'grant-drift' });
    f.service.activateGrant({ ownerId, grantId: second.id, digest: second.digest, revision: second.revision });
    assert.throws(() => f.service.evaluate(second.id, observation(), { maxObservationAgeMs: 60_000,
      binding: { adapter: 'synthetic.reserve', adapterVersion: 2, connectionId: 'connection-a',
        connectionGeneration: 1, browserProfileId: 'profile-a', subjectDigest: 'b'.repeat(64) } }), /drift|revoked/i);
    assert.equal(f.store.state(workspaceId).monitoredActionGrants[second.id].status, 'revoked');

    const third = f.service.proposeGrant({ ...proposal(), id: 'grant-connection-drift' });
    f.service.activateGrant({ ownerId, grantId: third.id, digest: third.digest, revision: third.revision });
    f.store.append(workspaceId, f.store.state(workspaceId).version,
      [{ type: 'connection.revoked', data: { id: 'connection-a', generation: 2 } }],
      { actorId: ownerId, recordedAt: now });
    assert.throws(() => f.service.evaluate(third.id, observation(), { maxObservationAgeMs: 60_000,
      binding: { adapter: 'synthetic.reserve', adapterVersion: 1, connectionId: 'connection-a',
        connectionGeneration: 1, browserProfileId: 'profile-a', subjectDigest: 'b'.repeat(64) } }), /drift|revoked/i);
    assert.equal(f.store.state(workspaceId).monitoredActionGrants[third.id].status, 'revoked');
  } finally { f.store.close(); }
});
