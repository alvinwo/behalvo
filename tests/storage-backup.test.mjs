import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { OperationRegistry, OperationService, Operator, SqliteStore } from '../dist/index.js';
import { serviceJobContext } from '../dist/storage/sqlite-codec.js';
import { validateStorage } from '../dist/storage/sqlite-schema.js';
import { verifyEncryptedDatabase } from '../dist/storage/sqlite-validation.js';

const POSIX = process.platform !== 'win32';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'behalvo-backup-'));
  chmodSync(directory, 0o700);
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, key: randomBytes(32) };
}

function populate(store) {
  const owner = 'synthetic-owner';
  const workspace = 'personal';
  store.createWorkspace(workspace, owner);
  const message = store.ingest(workspace, {
    source: 'synthetic-mailbox', externalId: 'synthetic-delivery', threadId: 'synthetic-thread',
    senderId: owner, senderRole: 'owner', text: 'synthetic encrypted backup payload'
  });
  store.saveSummary(workspace, { threadId: 'synthetic-thread', sourceIds: [message.id], text: 'synthetic backup summary' });
  const operator = new Operator(store, () => '2026-09-14T12:00:00.000Z');
  operator.createWork(workspace, owner, { id: 'work', title: 'Synthetic work', goal: 'Preserve barriers', threadId: 'synthetic-thread' });
  const unknown = operator.propose(workspace, { workId: 'work', key: 'unknown', command: { kind: 'message.send', channel: 'mock-email', to: 'nobody@example.test', body: 'Unknown' } });
  operator.approve(workspace, owner, unknown.id, unknown.digest, '2026-09-14T13:00:00.000Z');
  const running = operator.propose(workspace, { workId: 'work', key: 'running', command: { kind: 'message.send', channel: 'mock-email', to: 'nobody@example.test', body: 'Running' } });
  operator.approve(workspace, owner, running.id, running.digest, '2026-09-14T13:00:00.000Z');
  return { workspace, message, unknown, running, operator };
}

test('encrypted backup includes live WAL state and can be restored with a separately loaded key copy', { skip: !POSIX }, async t => {
  const { directory, key } = await fixture(t);
  const sourcePath = join(directory, 'source.db');
  const backupPath = join(directory, 'backup.db');
  const restoredPath = join(directory, 'restored.db');
  const store = new SqliteStore(sourcePath, { encryptionKey: key });
  const { workspace, message, unknown, running, operator } = populate(store);
  let effectCalls = 0;
  await operator.runEffect(workspace, unknown.id, { channel: 'mock-email', async execute() {
    effectCalls++;
    return { status: 'unknown', evidence: 'synthetic unknown evidence' };
  } });
  operator.startEffect(workspace, running.id, 'mock-email');
  const expectedState = store.state(workspace);
  const expectedJournal = store.journal(workspace);
  const expectedArtifact = store.readArtifact(workspace, message.event.data.artifactId);
  const priorEffectCalls = effectCalls;
  assert.equal(existsSync(`${sourcePath}-wal`), true);

  await store.backup(backupPath);
  assert.equal(existsSync(`${backupPath}-wal`), false);
  assert.equal(existsSync(`${backupPath}-shm`), false);
  store.close();
  const recoveredKey = Uint8Array.from(key);
  const snapshot = new SqliteStore(backupPath, { encryptionKey: recoveredKey, readOnly: true });
  await snapshot.backup(restoredPath);
  snapshot.close();
  assert.equal(existsSync(`${restoredPath}-wal`), false);
  assert.equal(existsSync(`${restoredPath}-shm`), false);
  const restored = new SqliteStore(restoredPath, { encryptionKey: recoveredKey });
  try {
    assert.deepEqual(restored.state(workspace), expectedState);
    assert.deepEqual(restored.journal(workspace), expectedJournal);
    assert.equal(restored.readArtifact(workspace, message.event.data.artifactId), expectedArtifact);
    assert.equal(restored.state(workspace).actions[unknown.id].status, 'unknown');
    assert.equal(restored.state(workspace).actions[running.id].status, 'running');
    assert.equal(effectCalls, priorEffectCalls);
  } finally { restored.close(); }
});

test('encrypted backup preserves and validates service receipts, claims, and queued jobs', { skip: !POSIX }, async t => {
  const { directory, key } = await fixture(t);
  const sourcePath = join(directory, 'service-source.db');
  const backupPath = join(directory, 'service-backup.db');
  const store = new SqliteStore(sourcePath, { encryptionKey: key, serviceQueue: { upgradeExisting: false } });
  store.createWorkspace('service-workspace', 'service-owner');
  const input = requestId => ({ workspaceId: 'service-workspace', source: 'owner:service', requestId,
    ownerId: 'service-owner', envelope: { kind: 'owner_turn', threadId: 'thread', text: `Synthetic ${requestId}` },
    accepted: { threadId: 'thread', model: { provider: 'scripted', model: 'synthetic' }, windowTokens: 12000,
      outputReserve: 1000, capability: 'prepare_only' }, instanceId: 'instance', at: '2026-09-15T12:00:00.000Z' });
  const running = store.admitOwnerTurnJob(input('running')).job;
  const queued = store.admitOwnerTurnJob(input('queued')).job;
  store.claimServiceJob('service-workspace', 'worker', '2026-09-15T12:00:00.000Z');
  const receipt = store.findServiceReceipt(input('running'), input('running').envelope);
  await store.backup(backupPath);
  store.close();

  const restored = new SqliteStore(backupPath, { encryptionKey: Uint8Array.from(key), readOnly: true });
  try {
    assert.deepEqual(restored.findServiceReceipt(input('running'), input('running').envelope), receipt);
    assert.equal(restored.serviceJob('service-workspace', running.id).status, 'running');
    assert.equal(restored.serviceJob('service-workspace', queued.id).status, 'queued');
    assert.equal(restored.serviceQueueCounts('service-workspace').activeJobId, running.id);
  } finally { restored.close(); }
  const db = new DatabaseSync(backupPath);
  try {
    const cipher = validateStorage(db, key);
    const row = db.prepare('SELECT * FROM service_jobs WHERE id=?').get(running.id);
    const job = JSON.parse(cipher.open(row.job_json, serviceJobContext(row)));
    job.actionRecordId = 'unrelated-outcome';
    db.prepare('UPDATE service_jobs SET job_json=? WHERE id=?')
      .run(cipher.seal(JSON.stringify(job), serviceJobContext(row)), job.id);
    assert.throws(() => verifyEncryptedDatabase(db, cipher), /snapshot/i);
  } finally { db.close(); }
});

for (const kind of ['execute', 'readback']) test(`encrypted backup validates a running ${kind} claim with exact verification association`, { skip: !POSIX }, async t => {
  const { directory, key } = await fixture(t);
  const sourcePath = join(directory, 'verified-running-source.db');
  const backupPath = join(directory, 'verified-running-backup.db');
  const store = new SqliteStore(sourcePath, { encryptionKey: key, serviceQueue: { upgradeExisting: false } });
  t.after(() => store.close());
  const workspace = 'verified-workspace';
  const owner = 'verified-owner';
  const at = '2026-09-15T12:00:00.000Z';
  store.createWorkspace(workspace, owner);
  const operator = new Operator(store, () => at);
  operator.createWork(workspace, owner, { id: 'work', title: 'Verified work', goal: 'Preserve exact proof', threadId: 'thread' });
  const registry = new OperationRegistry();
  let remote = { value: 'before' };
  registry.register({
    id: 'synthetic.update', version: '1', provider: 'synthetic',
    catalog: { description: 'Synthetic', connectionKind: 'synthetic', resourceIds: ['resource'],
      argumentsSchema: { type: 'object' }, exampleArguments: { value: 'after' } },
    validateArguments(value) { return value; },
    async identify({ connection }) { return connection.subject; },
    async observe({ connection, resourceId }) { return { state: remote, providerVersion: 'v1',
      source: connection.provider, resourceId, observedAt: at }; },
    prepare({ arguments: args, observation }) { return { arguments: args,
      affectedResourceIds: [observation.resourceId], expectedResult: args }; },
    comparePrecondition() { return true; },
    async execute({ command }) { remote = command.expectedResult; return { status: 'accepted', evidence: 'Accepted' }; },
    verify({ command, observation }) { return { status: JSON.stringify(command.expectedResult) === JSON.stringify(observation.state)
      ? 'satisfied' : 'not_satisfied' }; }
  });
  const operations = new OperationService(store, registry, () => at, workspace);
  operations.registerConnection({ workspaceId: workspace, ownerId: owner,
    connection: { id: 'account', provider: 'synthetic', subject: 'subject', label: 'Synthetic' } });
  const action = await operations.prepare({ workspaceId: workspace, ownerId: owner, workId: 'work', key: 'action',
    connectionId: 'account', operationId: 'synthetic.update', operationVersion: '1', resourceId: 'resource',
    arguments: { value: 'after' } });
  operations.approveBatch({ workspaceId: workspace, ownerId: owner, expiresAt: '2026-09-15T13:00:00.000Z',
    approvals: [{ actionId: action.id, digest: action.digest }] });
  if (kind === 'readback') await operations.execute({ workspaceId: workspace, ownerId: owner, actionId: action.id });
  store.admitActionJob({ workspaceId: workspace, source: 'owner:service', requestId: kind, ownerId: owner,
    envelope: { kind, actionId: action.id, digest: action.digest }, instanceId: 'instance', at });
  const claimed = store.claimServiceJob(workspace, 'worker', at);
  const context = { deadline: Date.now() + 30_000, serviceClaim: claimed.claim };
  if (kind === 'execute') await operations.execute({ workspaceId: workspace, ownerId: owner, actionId: action.id }, context);
  await operations.verify({ workspaceId: workspace, ownerId: owner, actionId: action.id }, context);
  const running = store.serviceJob(workspace, claimed.id);
  assert.equal(running.status, 'running');
  assert.ok(running.verificationRecordId);
  const outcome = store.journal(workspace).find(record => record.event.type === 'action.finished');
  const result = { reason: 'completed', recordIds: [outcome.id, running.verificationRecordId],
    actionId: action.id, attemptId: outcome.event.data.attemptId, actionRecordId: outcome.id,
    verificationRecordId: running.verificationRecordId };
  for (const reason of ['action_failed', 'action_unknown', 'readback_unresolved']) {
    assert.throws(() => store.completeServiceJob(workspace, claimed.claim, 'stopped', { ...result, reason }, at),
      error => error.code === 'integrity');
    assert.equal(store.serviceJob(workspace, claimed.id).status, 'running');
  }

  await store.backup(backupPath);
  const restored = new SqliteStore(backupPath, { encryptionKey: Uint8Array.from(key), readOnly: true });
  try {
    const restoredJob = restored.serviceJob(workspace, claimed.id);
    assert.equal(restoredJob.verificationRecordId, running.verificationRecordId);
    assert.equal(restored.record(workspace, restoredJob.verificationRecordId).event.type, 'action.verification_recorded');
  } finally { restored.close(); }
  const db = new DatabaseSync(backupPath);
  try {
    const cipher = validateStorage(db, key);
    const row = db.prepare('SELECT * FROM service_jobs WHERE id=?').get(running.id);
    if (kind === 'readback') {
      const alteredRow = { ...row, status: 'finished', finished_at: at };
      const alteredJob = { ...running, status: 'finished', finishedAt: at, result: {
        reason: 'completed', actionId: action.id, verificationRecordId: running.verificationRecordId,
        recordIds: [running.verificationRecordId]
      } };
      db.prepare('UPDATE service_jobs SET status=?, finished_at=?, job_json=? WHERE id=?')
        .run('finished', at, cipher.seal(JSON.stringify(alteredJob), serviceJobContext(alteredRow)), running.id);
      assert.throws(() => verifyEncryptedDatabase(db, cipher), /snapshot/i);
    }
    for (const reason of ['action_failed', 'action_unknown', 'readback_unresolved']) {
      const alteredRow = { ...row, status: 'stopped', finished_at: at };
      const alteredJob = { ...running, status: 'stopped', finishedAt: at, result: { ...result, reason } };
      db.prepare('UPDATE service_jobs SET status=?, finished_at=?, job_json=? WHERE id=?')
        .run('stopped', at, cipher.seal(JSON.stringify(alteredJob), serviceJobContext(alteredRow)), running.id);
      assert.throws(() => verifyEncryptedDatabase(db, cipher), /snapshot/i);
    }
  } finally { db.close(); }
});

test('interrupted reminder recovery preserves firing provenance and remains backup-valid', { skip: !POSIX }, async t => {
  const { directory, key } = await fixture(t);
  const sourcePath = join(directory, 'interrupted-reminder-source.db');
  const backupPath = join(directory, 'interrupted-reminder-backup.db');
  const store = new SqliteStore(sourcePath, { encryptionKey: key, serviceQueue: { upgradeExisting: false } });
  store.createWorkspace('service-workspace', 'service-owner');
  const operator = new Operator(store, () => '2026-09-15T12:00:00.000Z');
  operator.createWork('service-workspace', 'service-owner', {
    id: 'work', title: 'Synthetic reminder', goal: 'Preserve interruption', threadId: 'thread'
  });
  store.scheduleServiceReminder({ workspaceId: 'service-workspace', source: 'owner:service', requestId: 'schedule',
    ownerId: 'service-owner', envelope: { kind: 'schedule_reminder', workId: 'work', dueAt: '2026-09-15T12:00:00.000Z' },
    timerId: 'timer', at: '2026-09-15T12:00:00.000Z' });
  const admitted = store.admitDueTimerJob('service-workspace', 'timer', 'instance', '2026-09-15T12:00:00.000Z');
  assert.equal(admitted.kind, 'queued');
  const claimed = store.claimServiceJob('service-workspace', 'worker', '2026-09-15T12:00:00.000Z');
  assert.equal(claimed.id, admitted.job.id);
  assert.deepEqual(store.inspectInterruptedServiceJobs('service-workspace', '2026-09-15T12:01:00.000Z'),
    { repaired: 0, interrupted: 1 });
  const interrupted = store.serviceJob('service-workspace', admitted.job.id);
  assert.equal(interrupted.status, 'interrupted');
  assert.deepEqual(interrupted.result, {
    reason: 'process_interrupted', recordIds: [admitted.job.parameters.timerRecordId], timerId: 'timer'
  });
  assert.deepEqual(store.inbox('service-workspace').map(record => record.id), [admitted.job.parameters.timerRecordId]);
  assert.equal(store.journal('service-workspace').some(record => record.event.type === 'inbox.handled' &&
    record.event.data.recordId === admitted.job.parameters.timerRecordId), false);

  await store.backup(backupPath);
  store.close();
  const restored = new SqliteStore(backupPath, { encryptionKey: Uint8Array.from(key), readOnly: true });
  try {
    assert.deepEqual(restored.serviceJob('service-workspace', admitted.job.id).result, interrupted.result);
    assert.deepEqual(restored.inbox('service-workspace').map(record => record.id), [admitted.job.parameters.timerRecordId]);
  } finally { restored.close(); }
});

test('every interrupted job kind survives verified backup and restore with its original barriers', { skip: !POSIX }, async t => {
  for (const kind of ['owner_turn', 'execute_unstarted', 'execute_started', 'readback', 'reminder']) {
    for (const completion of ['recovery', 'ordinary']) await t.test(`${kind}/${completion}`, async t => {
      const { directory, key } = await fixture(t);
      const at = '2026-09-15T12:00:00.000Z';
      const store = new SqliteStore(join(directory, 'source.db'), { encryptionKey: key, serviceQueue: { upgradeExisting: false } });
      t.after(() => store.close());
      const { workspace, running: action } = populate(store);
      const identity = { workspaceId: workspace, source: 'owner:service', requestId: 'request', ownerId: 'synthetic-owner',
        instanceId: 'instance', at };
      if (kind === 'owner_turn') store.admitOwnerTurnJob({ ...identity,
        envelope: { kind, threadId: 'synthetic-thread', workId: 'work', text: 'Synthetic interrupted owner' },
        accepted: { threadId: 'synthetic-thread', workId: 'work', model: { provider: 'scripted', model: 'synthetic' },
          windowTokens: 12000, outputReserve: 1000, capability: 'prepare_only' } });
      else if (kind === 'reminder') {
        store.scheduleServiceReminder({ ...identity, envelope: { kind: 'schedule_reminder', workId: 'work', dueAt: at }, timerId: 'timer' });
        store.admitDueTimerJob(workspace, 'timer', 'instance', at);
      } else store.admitActionJob({ ...identity,
        envelope: { kind: kind === 'readback' ? 'readback' : 'execute', actionId: action.id, digest: action.digest } });
      const claimed = store.claimServiceJob(workspace, 'worker', at);
      if (kind === 'execute_started') store.startActionAttempt(workspace, store.state(workspace).version,
        action.id, 'attempt', { recordedAt: at }, undefined, claimed.claim);
      const journalBefore = store.journal(workspace);
      const pendingBefore = store.inbox(workspace);
      if (completion === 'recovery') assert.deepEqual(store.inspectInterruptedServiceJobs(workspace, at), { repaired: 0, interrupted: 1 });
      else {
        const result = kind === 'reminder'
          ? { reason: 'process_interrupted', recordIds: [claimed.parameters.timerRecordId], timerId: 'timer' }
          : { reason: 'process_interrupted', recordIds: [] };
        assert.throws(() => store.completeServiceJob(workspace, claimed.claim, 'interrupted',
          { ...result, reason: 'completed' }, at), error => error.code === 'integrity');
        store.completeServiceJob(workspace, claimed.claim, 'interrupted', result, at);
      }
      const expected = store.serviceJob(workspace, claimed.id);
      assert.equal(expected.status, 'interrupted');
      assert.deepEqual(store.journal(workspace), journalBefore);
      assert.deepEqual(store.inbox(workspace), pendingBefore);
      const backupPath = join(directory, 'backup.db');
      await store.backup(backupPath);
      const restored = new SqliteStore(backupPath, { encryptionKey: Uint8Array.from(key), readOnly: true });
      try {
        assert.deepEqual(restored.serviceJob(workspace, claimed.id), expected);
        assert.deepEqual(restored.journal(workspace), journalBefore);
        assert.deepEqual(restored.inbox(workspace), pendingBefore);
        assert.equal(restored.state(workspace).actions[action.id].status, kind === 'execute_started' ? 'running' : 'approved');
      } finally { restored.close(); }
    });
  }
});

test('accepted service result shapes roundtrip through verified encrypted backups', { skip: !POSIX }, async t => {
  const { directory, key } = await fixture(t);
  const at = '2026-09-15T12:00:00.000Z';
  const store = new SqliteStore(join(directory, 'source.db'), { encryptionKey: key, serviceQueue: { upgradeExisting: false } });
  t.after(() => store.close());
  const { workspace, running: action } = populate(store);
  const identity = { workspaceId: workspace, source: 'owner:service', ownerId: 'synthetic-owner', instanceId: 'instance', at };
  for (const reason of ['cancelled', 'deadline', 'action_ineligible']) {
    store.admitActionJob({ ...identity, requestId: reason, envelope: { kind: 'execute', actionId: action.id, digest: action.digest } });
    const claimed = store.claimServiceJob(workspace, 'worker', at);
    store.completeServiceJob(workspace, claimed.claim, 'stopped', { reason, recordIds: [] }, at);
  }
  store.admitActionJob({ ...identity, requestId: 'execute', envelope: { kind: 'execute', actionId: action.id, digest: action.digest } });
  const execute = store.claimServiceJob(workspace, 'worker', at);
  const start = store.startActionAttempt(workspace, store.state(workspace).version, action.id, 'attempt', { recordedAt: at }, undefined, execute.claim);
  store.finishActionAttempt(workspace, action.id, 'attempt', 'accepted', 'Synthetic accepted evidence');
  const outcome = store.journal(workspace).find(record => record.event.type === 'action.finished' && record.event.data.attemptId === 'attempt');
  store.completeServiceJob(workspace, execute.claim, 'stopped', { reason: 'readback_unresolved', recordIds: [start.id, outcome.id],
    actionId: action.id, attemptId: 'attempt', actionRecordId: outcome.id }, at);
  store.admitActionJob({ ...identity, requestId: 'readback', envelope: { kind: 'readback', actionId: action.id, digest: action.digest } });
  const readback = store.claimServiceJob(workspace, 'worker', at);
  store.completeServiceJob(workspace, readback.claim, 'stopped', { reason: 'readback_unresolved', recordIds: [outcome.id],
    actionId: action.id, attemptId: 'attempt', actionRecordId: outcome.id }, at);
  store.admitOwnerTurnJob({ ...identity, requestId: 'owner', envelope: { kind: 'owner_turn', threadId: 'synthetic-thread', text: 'Synthetic owner' },
    accepted: { threadId: 'synthetic-thread', model: { provider: 'scripted', model: 'synthetic' },
      windowTokens: 12000, outputReserve: 1000, capability: 'prepare_only' } });
  const ownerJob = store.claimServiceJob(workspace, 'worker', at);
  store.completeOwnerTurnJob(workspace, ownerJob.claim, { ownerRecordId: ownerJob.parameters.ownerRecordId,
    expectedVersion: store.state(workspace).version, events: [], reply: { text: 'Synthetic reply', source: 'agent:application',
      externalId: 'reply', threadId: 'synthetic-thread' }, status: 'finished', reason: 'completed', at });
  store.scheduleServiceReminder({ ...identity, requestId: 'schedule', envelope: { kind: 'schedule_reminder', workId: 'work', dueAt: at }, timerId: 'timer' });
  store.admitDueTimerJob(workspace, 'timer', 'instance', at);
  const reminder = store.claimServiceJob(workspace, 'worker', at);
  const finished = store.completeServiceJob(workspace, reminder.claim, 'finished',
    { reason: 'completed', recordIds: [reminder.parameters.timerRecordId], timerId: 'timer' }, at);
  assert.equal(finished.result.recordIds.length, 2);
  assert.equal(store.inbox(workspace).some(record => record.id === reminder.parameters.timerRecordId), false);
  const backupPath = join(directory, 'backup.db');
  await store.backup(backupPath);
  const restored = new SqliteStore(backupPath, { encryptionKey: Uint8Array.from(key), readOnly: true });
  try { assert.deepEqual(restored.serviceJobs(workspace), store.serviceJobs(workspace)); }
  finally { restored.close(); }
});

test('backup refuses plaintext stores and preserves existing destinations and sidecars', { skip: !POSIX }, async t => {
  const { directory, key } = await fixture(t);
  const plaintext = new SqliteStore(join(directory, 'plain.db'));
  plaintext.createWorkspace('personal', 'owner');
  await assert.rejects(() => plaintext.backup(join(directory, 'plain-backup.db')), /encrypted/i);
  plaintext.close();

  const source = new SqliteStore(join(directory, 'source.db'), { encryptionKey: key });
  populate(source);
  const sourceBefore = readFileSync(join(directory, 'source.db'));
  await assert.rejects(() => source.backup(join(directory, 'source.db')));
  assert.deepEqual(readFileSync(join(directory, 'source.db')), sourceBefore);
  const collision = join(directory, 'collision.db');
  writeFileSync(collision, 'existing', { mode: 0o600 });
  await assert.rejects(() => source.backup(collision));
  assert.equal(readFileSync(collision, 'utf8'), 'existing');
  const stale = join(directory, 'stale.db');
  writeFileSync(`${stale}-wal`, 'stale wal', { mode: 0o600 });
  await assert.rejects(() => source.backup(stale));
  assert.equal(existsSync(stale), false);
  assert.equal(readFileSync(`${stale}-wal`, 'utf8'), 'stale wal');
  const target = join(directory, 'target.db');
  writeFileSync(target, 'target', { mode: 0o600 });
  const linked = join(directory, 'linked.db');
  symlinkSync(target, linked);
  await assert.rejects(() => source.backup(linked));
  assert.equal(readFileSync(target, 'utf8'), 'target');
  source.close();

  chmodSync(join(directory, 'source.db'), 0o644);
  assert.throws(() => new SqliteStore(join(directory, 'source.db'), { encryptionKey: key, readOnly: true }));
});

test('backup validates the complete snapshot and leaves source and output unchanged on corruption', { skip: !POSIX }, async t => {
  const { directory, key } = await fixture(t);
  for (const [label, mutate] of [
    ['ciphertext', db => db.exec("UPDATE artifacts SET body='corrupt' WHERE rowid=1")],
    ['relational metadata', db => db.exec('DELETE FROM projections')]
  ]) await t.test(label, async () => {
    const sourcePath = join(directory, `${label.replaceAll(' ', '-')}.db`);
    const outputPath = join(directory, `${label.replaceAll(' ', '-')}-backup.db`);
    const writer = new SqliteStore(sourcePath, { encryptionKey: key });
    populate(writer);
    writer.close();
    const db = new DatabaseSync(sourcePath);
    mutate(db);
    db.close();
    chmodSync(sourcePath, 0o600);
    const before = readFileSync(sourcePath);
    const source = new SqliteStore(sourcePath, { encryptionKey: key, readOnly: true });
    await assert.rejects(() => source.backup(outputPath));
    source.close();
    assert.deepEqual(readFileSync(sourcePath), before);
    assert.equal(existsSync(outputPath), false);
  });
});
