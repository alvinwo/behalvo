import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { chmodSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Operator, SqliteStore } from '../dist/index.js';
import { verifyServiceResult } from '../dist/storage/sqlite-validation.js';

const owner = 'owner';
const workspace = 'service-test';
const at = '2026-09-15T12:00:00.000Z';

async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'behalvo-service-storage-'));
  chmodSync(directory, 0o700);
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'service.db');
  const store = new SqliteStore(path, { serviceQueue: { upgradeExisting: false }, ...options });
  store.createWorkspace(workspace, owner);
  return { directory, path, store };
}

function ownerInput(requestId = 'request-1', target = workspace) {
  return {
    workspaceId: target,
    source: 'owner:service',
    requestId,
    ownerId: owner,
    envelope: { kind: 'owner_turn', threadId: 'thread', workId: 'work', text: 'Synthetic owner input' },
    accepted: {
      threadId: 'thread', workId: 'work', model: { provider: 'scripted', model: 'synthetic' },
      windowTokens: 12000, outputReserve: 1000, capability: 'prepare_only'
    },
    instanceId: 'instance-1',
    at
  };
}

test('admission reports corrupt projection reads as integrity faults, not invalid requests', async t => {
  for (const kind of ['owner_turn', 'execute', 'readback', 'schedule_reminder', 'reminder']) await t.test(kind, async t => {
    const { store, path } = await fixture(t, { encryptionKey: randomBytes(32) });
    t.after(() => store.close());
    const operator = new Operator(store, () => at);
    operator.createWork(workspace, owner, { id: 'work', title: 'Synthetic', goal: 'Preserve faults', threadId: 'thread' });
    const action = operator.propose(workspace, { workId: 'work', key: 'action', command: {
      kind: 'message.send', channel: 'mock-email', to: 'nobody@example.test', body: 'Synthetic'
    } });
    const reminder = { workspaceId: workspace, source: 'owner:service', requestId: 'schedule', ownerId: owner,
      envelope: { kind: 'schedule_reminder', workId: 'work', dueAt: at }, timerId: 'timer', at };
    if (kind === 'reminder') store.scheduleServiceReminder(reminder);
    const db = new DatabaseSync(path);
    const beforeJournal = db.prepare('SELECT count(*) AS n FROM journal').get().n;
    const beforeRequests = db.prepare('SELECT count(*) AS n FROM service_requests').get().n;
    db.prepare('UPDATE projections SET state_json=? WHERE workspace_id=?').run('SYNTHETIC_CORRUPTION_CANARY', workspace);
    const admit = () => {
      if (kind === 'owner_turn') return store.admitOwnerTurnJob(ownerInput());
      if (kind === 'schedule_reminder') return store.scheduleServiceReminder(reminder);
      if (kind === 'reminder') return store.admitDueTimerJob(workspace, 'timer', 'instance', at);
      return store.admitActionJob({ workspaceId: workspace, source: 'owner:service', requestId: kind, ownerId: owner,
        envelope: { kind, actionId: action.id, digest: action.digest }, instanceId: 'instance', at });
    };
    assert.throws(admit, error => error.code === 'integrity' && !error.message.includes('CANARY'));
    assert.equal(db.prepare('SELECT count(*) AS n FROM journal').get().n, beforeJournal);
    assert.equal(db.prepare('SELECT count(*) AS n FROM service_requests').get().n, beforeRequests);
    db.close();
  });
});

test('reminder persistence failure is an integrity fault and rolls back journal and receipt', async t => {
  const { store, path } = await fixture(t, { encryptionKey: randomBytes(32) });
  t.after(() => store.close());
  const operator = new Operator(store, () => at);
  operator.createWork(workspace, owner, { id: 'work', title: 'Synthetic', goal: 'Atomic reminder', threadId: 'thread' });
  const before = store.state(workspace);
  const db = new DatabaseSync(path);
  db.exec("CREATE TRIGGER fail_reminder BEFORE UPDATE ON projections BEGIN SELECT RAISE(ABORT, 'SYNTHETIC_WRITE_CANARY'); END");
  const input = { workspaceId: workspace, source: 'owner:service', requestId: 'schedule', ownerId: owner,
    envelope: { kind: 'schedule_reminder', workId: 'work', dueAt: at }, timerId: 'timer', at };
  assert.throws(() => store.scheduleServiceReminder(input), error => error.code === 'integrity' && !error.message.includes('CANARY'));
  assert.deepEqual(store.state(workspace), before);
  assert.equal(store.journal(workspace).length, before.version);
  assert.equal(store.findServiceReceipt(input, input.envelope), undefined);
  db.exec('DROP TRIGGER fail_reminder');
  db.close();
  assert.throws(() => store.scheduleServiceReminder({ ...input, timerId: '' }), error => error.code === 'invalid');
  assert.equal(store.scheduleServiceReminder(input).duplicate, false);
});

test('unknown envelope, admitted model, and result keys are rejected before persistence', async t => {
  for (const target of ['owner_turn', 'execute', 'readback', 'schedule_reminder', 'reminder', 'model', 'result']) {
    await t.test(target, async t => {
      const { store, path } = await fixture(t);
      t.after(() => store.close());
      const canary = 'SYNTHETIC_CONFIRMATION_CANARY';
      const operator = new Operator(store, () => at);
      operator.createWork(workspace, owner, { id: 'work', title: 'Synthetic', goal: 'Allowlisted storage', threadId: 'thread' });
      const action = operator.propose(workspace, { workId: 'work', key: 'action', command: {
        kind: 'message.send', channel: 'mock-email', to: 'nobody@example.test', body: 'Synthetic'
      } });
      const input = ownerInput();
      let mutate;
      if (target === 'result') {
        store.admitOwnerTurnJob(input);
        const claimed = store.claimServiceJob(workspace, 'worker', at);
        mutate = () => store.completeServiceJob(workspace, claimed.claim, 'stopped',
          { reason: 'cancelled', recordIds: [], rawDiagnostic: canary }, at);
      } else if (target === 'model') {
        input.accepted.model.confirmationToken = canary;
        mutate = () => store.admitOwnerTurnJob(input);
      } else {
        const envelopes = {
          owner_turn: input.envelope,
          execute: { kind: 'execute', actionId: action.id, digest: action.digest },
          readback: { kind: 'readback', actionId: action.id, digest: action.digest },
          schedule_reminder: { kind: 'schedule_reminder', workId: 'work', dueAt: at },
          reminder: { kind: 'reminder', timerId: 'timer', workId: 'work' }
        };
        const envelope = { ...envelopes[target], confirmationToken: canary };
        if (target === 'owner_turn') mutate = () => store.admitOwnerTurnJob({ ...input, envelope });
        else if (target === 'schedule_reminder') mutate = () => store.scheduleServiceReminder({ ...input, envelope, timerId: 'timer' });
        else if (target === 'reminder') mutate = () => store.findServiceReceipt(input, envelope);
        else mutate = () => store.admitActionJob({ ...input, envelope });
      }
      const before = store.state(workspace);
      const jobsBefore = store.serviceJobs(workspace);
      assert.throws(mutate, error => ['invalid', 'integrity'].includes(error.code) && !error.message.includes(canary));
      assert.deepEqual(store.state(workspace), before);
      assert.deepEqual(store.serviceJobs(workspace), jobsBefore);
      const db = new DatabaseSync(path);
      assert.equal(JSON.stringify(db.prepare('SELECT * FROM service_requests').all()).includes(canary), false);
      assert.equal(JSON.stringify(db.prepare('SELECT * FROM service_jobs').all()).includes(canary), false);
      db.close();
    });
  }
});

test('generic completion rejects assistant evidence that encrypted validation cannot accept', async t => {
  const { store } = await fixture(t);
  t.after(() => store.close());
  const job = store.admitOwnerTurnJob(ownerInput()).job;
  const claimed = store.claimServiceJob(workspace, 'worker', at);
  assert.throws(() => store.completeServiceJob(workspace, claimed.claim, 'finished', {
    reason: 'completed', recordIds: [job.parameters.ownerRecordId], assistantRecordId: job.parameters.ownerRecordId
  }, at), error => error.code === 'integrity');
  assert.equal(store.serviceJob(workspace, job.id).status, 'running');
});

test('service result validation rejects completed readbacks without satisfied trusted verification', () => {
  for (const status of ['not_satisfied', 'unknown', 'owner_attested']) {
    const verification = status === 'owner_attested'
      ? { status, resolution: 'accepted', evidenceRef: 'evidence', recordedAt: at }
      : { status, observation: {}, recordedAt: at };
    const record = { id: `verification-${status}`, event: {
      type: 'action.verification_recorded', data: { id: 'action', verification }
    } };
    const job = { id: `job-${status}`, workspaceId: workspace, receiptId: 'receipt', position: 1,
      kind: 'readback', status: 'finished', admittedAt: at, admittedBy: 'instance',
      parameters: { kind: 'readback', actionId: 'action', digest: 'digest' },
      startedAt: at, finishedAt: at, claim: { jobId: `job-${status}`, claimId: 'claim', instanceId: 'instance' },
      verificationRecordId: record.id, result: undefined };
    const result = { reason: 'completed', recordIds: [record.id], actionId: 'action',
      verificationRecordId: record.id };
    assert.throws(() => verifyServiceResult(result, job, new Map([[record.id, record]])),
      /invalid encrypted database snapshot/i);
  }
  const finishedUnresolved = { id: 'job-finished-unresolved', workspaceId: workspace, receiptId: 'receipt', position: 1,
    kind: 'readback', status: 'finished', admittedAt: at, admittedBy: 'instance',
    parameters: { kind: 'readback', actionId: 'action', digest: 'digest' }, startedAt: at, finishedAt: at,
    claim: { jobId: 'job-finished-unresolved', claimId: 'claim', instanceId: 'instance' } };
  assert.throws(() => verifyServiceResult({ reason: 'readback_unresolved', recordIds: [] },
    finishedUnresolved, new Map()), /invalid encrypted database snapshot/i);
});

test('service writers reject wrong envelope variants as invalid requests', async t => {
  const { store } = await fixture(t);
  t.after(() => store.close());
  const input = ownerInput();
  assert.throws(() => store.admitOwnerTurnJob({ ...input, envelope: { kind: 'reminder', timerId: 'timer', workId: 'work' } }),
    error => error.code === 'invalid');
  const operator = new Operator(store, () => at);
  operator.createWork(workspace, owner, { id: 'work', title: 'Synthetic', goal: 'Reject mismatches', threadId: 'thread' });
  assert.throws(() => store.scheduleServiceReminder({ ...input, timerId: 'timer', envelope: { kind: 'reminder', timerId: 'timer', workId: 'work' } }),
    error => error.code === 'invalid');
});

test('service results reject malformed optional references instead of storing nested diagnostics', async t => {
  const { store } = await fixture(t);
  t.after(() => store.close());
  store.admitOwnerTurnJob(ownerInput());
  const claimed = store.claimServiceJob(workspace, 'worker', at);
  for (const field of ['actionId', 'attemptId', 'timerId']) assert.throws(() => store.completeServiceJob(workspace, claimed.claim,
    'stopped', { reason: 'cancelled', recordIds: [], [field]: { confirmationToken: 'SYNTHETIC_CANARY' } }, at),
    error => error.code === 'integrity');
  assert.equal(store.serviceJob(workspace, claimed.id).status, 'running');
});

test('generated owner results cannot exceed the snapshot evidence bound', async t => {
  const { store } = await fixture(t);
  t.after(() => store.close());
  const operator = new Operator(store, () => at);
  operator.createWork(workspace, owner, { id: 'work', title: 'Synthetic', goal: 'Bound results', threadId: 'thread' });
  store.admitOwnerTurnJob(ownerInput());
  const claimed = store.claimServiceJob(workspace, 'worker', at);
  const before = store.state(workspace);
  assert.throws(() => store.completeOwnerTurnJob(workspace, claimed.claim, {
    ownerRecordId: claimed.parameters.ownerRecordId, expectedVersion: before.version,
    events: Array.from({ length: 999 }, () => ({ type: 'work.thread_linked', data: { id: 'work', threadId: 'thread' } })),
    reply: { text: 'Synthetic reply', source: 'agent:application', externalId: 'reply', threadId: 'thread' },
    status: 'finished', reason: 'completed', at
  }), error => error.code === 'integrity');
  assert.deepEqual(store.state(workspace), before);
  assert.equal(store.serviceJob(workspace, claimed.id).status, 'running');
  assert.deepEqual(store.inbox(workspace).map(record => record.id), [claimed.parameters.ownerRecordId]);
});

test('reminder finalization keeps the generated handled record within the snapshot evidence bound', async t => {
  const { store } = await fixture(t);
  t.after(() => store.close());
  const operator = new Operator(store, () => at);
  operator.createWork(workspace, owner, { id: 'work', title: 'Synthetic', goal: 'Bound results', threadId: 'thread' });
  store.scheduleServiceReminder({ workspaceId: workspace, source: 'owner:service', requestId: 'reminder', ownerId: owner,
    envelope: { kind: 'schedule_reminder', workId: 'work', dueAt: at }, timerId: 'timer', at });
  const admitted = store.admitDueTimerJob(workspace, 'timer', 'instance', at).job;
  const claimed = store.claimServiceJob(workspace, 'worker', at);
  const records = store.append(workspace, store.state(workspace).version,
    Array.from({ length: 999 }, () => ({ type: 'work.thread_linked', data: { id: 'work', threadId: 'thread' } })));
  const before = store.state(workspace);
  assert.throws(() => store.completeServiceJob(workspace, claimed.claim, 'finished', {
    reason: 'completed', recordIds: [admitted.parameters.timerRecordId, ...records.map(record => record.id)], timerId: 'timer'
  }, at), error => error.code === 'integrity');
  assert.deepEqual(store.state(workspace), before);
  assert.equal(store.serviceJob(workspace, claimed.id).status, 'running');
  assert.deepEqual(store.inbox(workspace).map(record => record.id), [admitted.parameters.timerRecordId]);
});

test('reminder completion storage faults preserve pending state and integrity classification', async t => {
  const { store, path } = await fixture(t, { encryptionKey: randomBytes(32) });
  t.after(() => store.close());
  const operator = new Operator(store, () => at);
  operator.createWork(workspace, owner, { id: 'work', title: 'Synthetic', goal: 'Atomic completion', threadId: 'thread' });
  store.scheduleServiceReminder({ workspaceId: workspace, source: 'owner:service', requestId: 'reminder', ownerId: owner,
    envelope: { kind: 'schedule_reminder', workId: 'work', dueAt: at }, timerId: 'timer', at });
  const admitted = store.admitDueTimerJob(workspace, 'timer', 'instance', at).job;
  const claimed = store.claimServiceJob(workspace, 'worker', at);
  const before = store.state(workspace);
  const db = new DatabaseSync(path);
  db.exec("CREATE TRIGGER fail_completion BEFORE UPDATE ON service_jobs BEGIN SELECT RAISE(ABORT, 'SYNTHETIC_WRITE_CANARY'); END");
  assert.throws(() => store.completeServiceJob(workspace, claimed.claim, 'finished',
    { reason: 'completed', recordIds: [admitted.parameters.timerRecordId], timerId: 'timer' }, at),
    error => error.code === 'integrity' && !error.message.includes('CANARY'));
  assert.deepEqual(store.state(workspace), before);
  assert.equal(store.serviceJob(workspace, claimed.id).status, 'running');
  assert.deepEqual(store.inbox(workspace).map(record => record.id), [admitted.parameters.timerRecordId]);
  db.exec('DROP TRIGGER fail_completion');
  db.close();
});

test('pre-start execution stops preserve cancellation and deadline outcomes without effects', async t => {
  for (const reason of ['cancelled', 'deadline']) await t.test(reason, async t => {
    const { store } = await fixture(t);
    t.after(() => store.close());
    const operator = new Operator(store, () => at);
    operator.createWork(workspace, owner, { id: 'work', title: 'Synthetic', goal: 'Stop safely', threadId: 'thread' });
    const action = operator.propose(workspace, { workId: 'work', key: 'action', command: {
      kind: 'message.send', channel: 'mock-email', to: 'nobody@example.test', body: 'Synthetic'
    } });
    store.admitActionJob({ workspaceId: workspace, source: 'owner:service', requestId: reason, ownerId: owner,
      envelope: { kind: 'execute', actionId: action.id, digest: action.digest }, instanceId: 'instance', at });
    const claimed = store.claimServiceJob(workspace, 'worker', at);
    const result = { reason, recordIds: [] };
    assert.deepEqual(store.completeServiceJob(workspace, claimed.claim, 'stopped', result, at).result, result);
    assert.equal(store.journal(workspace).some(record => record.event.type === 'action.started'), false);
  });
});

test('owner admission is atomic, idempotent across changed defaults, scoped, and bounded', async t => {
  const { store } = await fixture(t);
  store.createWorkspace('other-workspace', owner);

  const input = ownerInput();
  const first = store.admitOwnerTurnJob(input);
  const again = store.admitOwnerTurnJob({ ...input, accepted: { ...input.accepted,
    model: { provider: 'scripted', model: 'changed-default' } } });
  assert.equal(again.duplicate, true);
  assert.equal(again.receipt.id, first.receipt.id);
  assert.equal(again.job.id, first.job.id);
  assert.deepEqual(again.job.parameters, first.job.parameters);
  assert.equal(store.inbox(workspace).length, 1);
  assert.equal(store.journal(workspace).filter(record => record.event.type === 'message.received').length, 1);
  assert.equal(store.serviceQueueCounts(workspace).queued, 1);
  assert.deepEqual(store.findServiceReceipt(input, input.envelope), first.receipt);
  assert.throws(() => store.admitOwnerTurnJob({ ...input,
    envelope: { ...input.envelope, text: 'Conflicting synthetic text' } }),
  error => error.code === 'conflict');

  const scoped = store.admitOwnerTurnJob(ownerInput('request-1', 'other-workspace'));
  assert.notEqual(scoped.receipt.id, first.receipt.id);
  assert.equal(store.serviceQueueCounts('other-workspace').queued, 1);

  for (let index = 2; index <= 64; index++) store.admitOwnerTurnJob(ownerInput(`request-${index}`));
  assert.equal(store.serviceQueueCounts(workspace).queued, 64);
  assert.throws(() => store.admitOwnerTurnJob(ownerInput('request-65')), error => error.code === 'full');
  assert.equal(store.admitOwnerTurnJob(input).duplicate, true, 'duplicate lookup precedes capacity rejection');
  store.close();
});

test('owner admission rollback hook leaves artifacts, journal, inbox, receipt, and job unchanged', async t => {
  const { store } = await fixture(t);
  const version = store.state(workspace).version;
  assert.throws(() => store.admitOwnerTurnJob(ownerInput('rollback'), () => { throw new Error('rollback'); }), /rollback/);
  assert.equal(store.state(workspace).version, version);
  assert.equal(store.inbox(workspace).length, 0);
  assert.equal(store.serviceJobs(workspace).items.length, 0);
  assert.equal(store.findServiceReceipt({ workspaceId: workspace, source: 'owner:service', requestId: 'rollback' },
    ownerInput('rollback').envelope), undefined);
  store.close();
});

test('jobs claim in durable FIFO order and only the exact claim can finalize', async t => {
  const { path, store } = await fixture(t);
  const first = store.admitOwnerTurnJob(ownerInput('first')).job;
  const second = store.admitOwnerTurnJob(ownerInput('second')).job;
  const claimed = store.claimServiceJob(workspace, 'worker-1', at);
  assert.equal(claimed.id, first.id);
  assert.equal(claimed.status, 'running');
  assert.equal(store.claimServiceJob(workspace, 'worker-2', at), undefined);
  assert.throws(() => store.completeServiceJob(workspace,
    { ...claimed.claim, claimId: 'wrong-claim' }, 'stopped', { reason: 'cancelled', recordIds: [] }, at),
  error => error.code === 'conflict');
  const complete = store.completeServiceJob(workspace, claimed.claim, 'stopped',
    { reason: 'cancelled', recordIds: [] }, at);
  assert.equal(complete.status, 'stopped');
  assert.equal(store.claimServiceJob(workspace, 'worker-2', at).id, second.id);
  assert.equal(store.serviceQueueCounts(workspace).activeJobId, second.id);
  const page = store.serviceJobs(workspace, first.position, 1);
  assert.deepEqual(page.items.map(job => job.id), [second.id]);
  assert.equal(page.nextAfter, null);
  store.close();

  const reopened = new SqliteStore(path, { serviceQueue: { upgradeExisting: false } });
  assert.equal(reopened.serviceJob(workspace, second.id).status, 'running');
  reopened.close();
});

test('owner completion commits the reply, handled inbox, and terminal job atomically', async t => {
  const { store } = await fixture(t);
  const admitted = store.admitOwnerTurnJob(ownerInput('complete-owner')).job;
  const claimed = store.claimServiceJob(workspace, 'worker-owner', at);
  assert.equal(claimed.id, admitted.id);
  const expectedVersion = store.state(workspace).version;
  const completion = {
    ownerRecordId: claimed.parameters.ownerRecordId,
    expectedVersion,
    events: [],
    reply: { text: 'Synthetic completion', source: 'agent:model', externalId: 'reply-complete-owner', threadId: 'thread' },
    status: 'finished', reason: 'completed', at
  };
  assert.throws(() => store.completeOwnerTurnJob(workspace, claimed.claim, completion,
    () => { throw new Error('completion rollback'); }), /completion rollback/);
  assert.equal(store.serviceJob(workspace, admitted.id).status, 'running');
  assert.equal(store.inbox(workspace).length, 1);
  assert.equal(store.journal(workspace).filter(record => record.event.type === 'message.received').length, 1);

  const completed = store.completeOwnerTurnJob(workspace, claimed.claim, completion);
  assert.equal(completed.job.status, 'finished');
  assert.equal(completed.job.result.reason, 'completed');
  assert.equal(completed.job.result.assistantRecordId,
    completed.records.find(record => record.event.type === 'message.received').id);
  assert.equal(store.inbox(workspace).length, 0);
  assert.equal(store.journal(workspace).filter(record => record.event.type === 'message.received').length, 2);
  store.close();
});

test('public completion rejects terminal reasons that contradict the exact effect outcome', async t => {
  for (const [kind, outcomeStatus, reason] of [
    ['execute', 'accepted', 'readback_unresolved'], ['execute', 'failed', 'action_failed'],
    ['execute', 'unknown', 'action_unknown'], ['readback', 'accepted', 'readback_unresolved'],
    ['readback', 'failed', 'action_failed'], ['readback', 'unknown', 'readback_unresolved']
  ])
    await t.test(`${kind}/${outcomeStatus}`, async t => {
      const { store } = await fixture(t);
      t.after(() => store.close());
      const operator = new Operator(store, () => at);
      operator.createWork(workspace, owner, { id: 'work', title: 'Synthetic', goal: 'Exact outcome', threadId: 'thread' });
      const action = operator.propose(workspace, { workId: 'work', key: 'action', command: {
        kind: 'message.send', channel: 'mock-email', to: 'nobody@example.test', body: 'Synthetic'
      } });
      operator.approve(workspace, owner, action.id, action.digest, '2026-09-15T13:00:00.000Z');
      store.admitActionJob({ workspaceId: workspace, source: 'owner:service', requestId: 'action', ownerId: owner,
        envelope: { kind, actionId: action.id, digest: action.digest }, instanceId: 'instance', at });
      let claimed;
      if (kind === 'execute') claimed = store.claimServiceJob(workspace, 'worker', at);
      store.startActionAttempt(workspace, store.state(workspace).version, action.id, 'attempt', {}, undefined,
        claimed?.claim);
      store.finishActionAttempt(workspace, action.id, 'attempt', outcomeStatus, 'Synthetic outcome');
      if (kind === 'readback') claimed = store.claimServiceJob(workspace, 'worker', at);
      const outcome = store.journal(workspace).find(record => record.event.type === 'action.finished');
      const result = { reason, recordIds: [outcome.id], actionId: action.id, attemptId: 'attempt', actionRecordId: outcome.id };
      for (const invalidReason of ['action_failed', 'action_unknown', 'readback_unresolved'].filter(value => value !== reason)) {
        assert.throws(() => store.completeServiceJob(workspace, claimed.claim, 'stopped',
          { ...result, reason: invalidReason }, at), error => error.code === 'integrity');
        assert.equal(store.serviceJob(workspace, claimed.id).status, 'running');
      }
      assert.equal(store.completeServiceJob(workspace, claimed.claim, 'stopped', result, at).result.reason, reason);
    });
});

test('action jobs bind the exact claim, start attempt, and outcome provenance', async t => {
  const { store } = await fixture(t);
  const operator = new Operator(store, () => at);
  operator.createWork(workspace, owner, { id: 'action-work', title: 'Synthetic action', goal: 'Exercise storage', threadId: 'thread' });
  const action = operator.propose(workspace, { workId: 'action-work', key: 'service-action', command: {
    kind: 'message.send', channel: 'mock-email', to: 'nobody@example.test', body: 'Synthetic body'
  } });
  operator.approve(workspace, owner, action.id, action.digest, '2026-09-15T13:00:00.000Z');
  const admitted = store.admitActionJob({ workspaceId: workspace, source: 'owner:service', requestId: 'execute-1', ownerId: owner,
    envelope: { kind: 'execute', actionId: action.id, digest: action.digest }, instanceId: 'instance-1', at });
  assert.equal(store.admitActionJob({ workspaceId: workspace, source: 'owner:service', requestId: 'execute-1', ownerId: owner,
    envelope: { kind: 'execute', actionId: action.id, digest: action.digest }, instanceId: 'changed-instance', at }).duplicate, true);
  assert.throws(() => store.admitActionJob({ workspaceId: workspace, source: 'owner:service', requestId: 'execute-1', ownerId: owner,
    envelope: { kind: 'execute', actionId: action.id, digest: 'different-digest' }, instanceId: 'instance-1', at }),
  error => error.code === 'conflict');

  const claimed = store.claimServiceJob(workspace, 'action-worker', at);
  assert.equal(claimed.id, admitted.job.id);
  const beforeVersion = store.state(workspace).version;
  assert.throws(() => store.startActionAttempt(workspace, beforeVersion, action.id, 'attempt-1', {}, undefined,
    { ...claimed.claim, claimId: 'wrong-claim' }), error => error.code === 'conflict');
  assert.equal(store.state(workspace).actions[action.id].status, 'approved');
  assert.equal(store.serviceJob(workspace, claimed.id).attemptId, undefined);

  const started = store.startActionAttempt(workspace, beforeVersion, action.id, 'attempt-1', {}, undefined, claimed.claim);
  assert.equal(started.event.type, 'action.started');
  assert.equal(store.serviceJob(workspace, claimed.id).attemptId, 'attempt-1');
  assert.equal(store.finishActionAttempt(workspace, action.id, 'attempt-1', 'accepted', 'Synthetic accepted evidence'), true);
  const finished = store.journal(workspace).find(record => record.event.type === 'action.finished' &&
    record.event.data.id === action.id && record.event.data.attemptId === 'attempt-1');
  assert.ok(finished);
  assert.throws(() => store.completeServiceJob(workspace, claimed.claim, 'finished', {
    reason: 'completed', recordIds: [started.id], actionId: action.id, attemptId: 'attempt-1', actionRecordId: started.id
  }, at), error => error.code === 'integrity');
  const unrelated = store.journal(workspace).find(record => record.event.type === 'workspace.created');
  assert.throws(() => store.completeServiceJob(workspace, claimed.claim, 'finished', {
    reason: 'completed', recordIds: [started.id, finished.id, unrelated.id], actionId: action.id,
    attemptId: 'attempt-1', actionRecordId: finished.id
  }, at), error => error.code === 'integrity');
  const completed = store.completeServiceJob(workspace, claimed.claim, 'stopped', {
    reason: 'readback_unresolved', recordIds: [started.id, finished.id], actionId: action.id,
    attemptId: 'attempt-1', actionRecordId: finished.id
  }, at);
  assert.equal(completed.status, 'stopped');
  assert.equal(completed.result.actionRecordId, finished.id);
  assert.throws(() => store.completeServiceJob(workspace, claimed.claim, 'finished', completed.result, at),
    error => error.code === 'conflict');
  store.close();
});

test('claim-less action starts remain available to ordinary legacy stores', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'behalvo-legacy-action-start-'));
  chmodSync(directory, 0o700);
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new SqliteStore(join(directory, 'ordinary.db'));
  store.createWorkspace(workspace, owner);
  const operator = new Operator(store, () => at);
  operator.createWork(workspace, owner, { id: 'legacy-work', title: 'Legacy', goal: 'Preserve legacy execution', threadId: 'thread' });
  const action = operator.propose(workspace, { workId: 'legacy-work', key: 'legacy-action', command: {
    kind: 'message.send', channel: 'mock-email', to: 'nobody@example.test', body: 'Synthetic legacy body'
  } });
  operator.approve(workspace, owner, action.id, action.digest, '2026-09-15T13:00:00.000Z');
  const started = store.startActionAttempt(workspace, store.state(workspace).version, action.id, 'legacy-attempt', { recordedAt: at });
  assert.equal(started.event.type, 'action.started');
  assert.equal(store.state(workspace).actions[action.id].attemptId, 'legacy-attempt');
  store.close();
});

test('unstarted execute jobs reject effect completion but permit preflight ineligibility', async t => {
  for (const evidence of ['empty', 'earlier-outcome']) await t.test(evidence, async t => {
    const { store } = await fixture(t);
    t.after(() => store.close());
    const operator = new Operator(store, () => at);
    operator.createWork(workspace, owner, { id: 'unstarted-work', title: 'Unstarted', goal: 'Require exact start', threadId: 'thread' });
    const action = operator.propose(workspace, { workId: 'unstarted-work', key: 'unstarted-action', command: {
      kind: 'message.send', channel: 'mock-email', to: 'nobody@example.test', body: 'Synthetic unstarted body'
    } });
    operator.approve(workspace, owner, action.id, action.digest, '2026-09-15T13:00:00.000Z');
    store.startActionAttempt(workspace, store.state(workspace).version, action.id, 'earlier-attempt', { recordedAt: at });
    assert.equal(store.finishActionAttempt(workspace, action.id, 'earlier-attempt', 'accepted', 'Earlier accepted evidence'), true);
    const earlierOutcome = store.journal(workspace).find(record => record.event.type === 'action.finished' &&
      record.event.data.id === action.id && record.event.data.attemptId === 'earlier-attempt');
    assert.ok(earlierOutcome);

    const admitted = store.admitActionJob({ workspaceId: workspace, source: 'owner:service', requestId: 'unstarted-execute', ownerId: owner,
      envelope: { kind: 'execute', actionId: action.id, digest: action.digest }, instanceId: 'instance-1', at }).job;
    const claimed = store.claimServiceJob(workspace, 'unstarted-worker', at);
    assert.equal(claimed.id, admitted.id);
    const result = evidence === 'empty' ? { reason: 'completed', recordIds: [] } : {
      reason: 'completed', recordIds: [earlierOutcome.id], actionId: action.id,
      attemptId: 'earlier-attempt', actionRecordId: earlierOutcome.id
    };
    assert.throws(() => store.completeServiceJob(workspace, claimed.claim, 'finished', result, at), error => error.code === 'integrity');
    assert.equal(store.serviceJob(workspace, admitted.id).status, 'running');

    const stopped = store.completeServiceJob(workspace, claimed.claim, 'stopped', {
      reason: 'action_ineligible', recordIds: []
    }, at);
    assert.equal(stopped.status, 'stopped');
    assert.equal(stopped.attemptId, undefined);
    assert.deepEqual(stopped.result, { reason: 'action_ineligible', recordIds: [] });
  });
});

test('interrupted inspection leaves queued work alone and repairs only exact durable outcomes', async t => {
  const { store } = await fixture(t);
  const unproven = store.admitOwnerTurnJob(ownerInput('interrupted-owner')).job;
  const queued = store.admitOwnerTurnJob(ownerInput('still-queued')).job;
  store.claimServiceJob(workspace, 'worker-owner', at);
  assert.deepEqual(store.inspectInterruptedServiceJobs(workspace, at), { repaired: 0, interrupted: 1 });
  assert.equal(store.serviceJob(workspace, unproven.id).status, 'interrupted');
  assert.equal(store.serviceJob(workspace, queued.id).status, 'queued');

  const ownerClaim = store.claimServiceJob(workspace, 'drain-owner', at);
  store.completeServiceJob(workspace, ownerClaim.claim, 'stopped', { reason: 'cancelled', recordIds: [] }, at);
  const operator = new Operator(store, () => at);
  operator.createWork(workspace, owner, { id: 'repair-work', title: 'Repair', goal: 'Use exact outcome', threadId: 'thread' });
  const action = operator.propose(workspace, { workId: 'repair-work', key: 'repair-action', command: {
    kind: 'message.send', channel: 'mock-email', to: 'nobody@example.test', body: 'Synthetic repair body'
  } });
  operator.approve(workspace, owner, action.id, action.digest, '2026-09-15T13:00:00.000Z');
  const admitted = store.admitActionJob({ workspaceId: workspace, source: 'owner:service', requestId: 'repair-execute', ownerId: owner,
    envelope: { kind: 'execute', actionId: action.id, digest: action.digest }, instanceId: 'instance-1', at }).job;
  const claimed = store.claimServiceJob(workspace, 'repair-worker', at);
  store.startActionAttempt(workspace, store.state(workspace).version, action.id, 'repair-attempt', {}, undefined, claimed.claim);
  store.finishActionAttempt(workspace, action.id, 'repair-attempt', 'accepted', 'Synthetic repair evidence');
  assert.deepEqual(store.inspectInterruptedServiceJobs(workspace, at), { repaired: 1, interrupted: 0 });
  assert.equal(store.serviceJob(workspace, admitted.id).status, 'stopped');
  assert.equal(store.serviceJob(workspace, admitted.id).result.reason, 'readback_unresolved');
  store.close();
});

test('ordinary reminder interruption retains the pending inbox without a handled event', async t => {
  const { store } = await fixture(t);
  const operator = new Operator(store, () => at);
  operator.createWork(workspace, owner, { id: 'work', title: 'Reminder', goal: 'Preserve pending', threadId: 'thread' });
  store.scheduleServiceReminder({ workspaceId: workspace, source: 'owner:service', requestId: 'reminder', ownerId: owner,
    envelope: { kind: 'schedule_reminder', workId: 'work', dueAt: at }, timerId: 'timer', at });
  const admitted = store.admitDueTimerJob(workspace, 'timer', 'instance', at).job;
  const claimed = store.claimServiceJob(workspace, 'worker', at);
  const result = { reason: 'process_interrupted', recordIds: [admitted.parameters.timerRecordId], timerId: 'timer' };
  assert.throws(() => store.completeServiceJob(workspace, claimed.claim, 'interrupted',
    { ...result, reason: 'completed' }, at), error => error.code === 'integrity');
  const completed = store.completeServiceJob(workspace, claimed.claim, 'interrupted', result, at);
  assert.deepEqual(completed.result, result);
  assert.deepEqual(store.inbox(workspace).map(record => record.id), [admitted.parameters.timerRecordId]);
  assert.equal(store.journal(workspace).some(record => record.event.type === 'inbox.handled'), false);
  store.close();
});

test('service schema creation and old-format upgrade are explicit and atomic', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'behalvo-service-schema-'));
  chmodSync(directory, 0o700);
  t.after(() => rm(directory, { recursive: true, force: true }));
  const ordinaryPath = join(directory, 'ordinary.db');
  const ordinary = new SqliteStore(ordinaryPath);
  ordinary.createWorkspace(workspace, owner);
  ordinary.close();
  assert.throws(() => new SqliteStore(ordinaryPath, { serviceQueue: { upgradeExisting: false } }), /upgrade/i);
  const before = new DatabaseSync(ordinaryPath);
  assert.equal(before.prepare('PRAGMA user_version').get().user_version, 1);
  assert.equal(before.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name IN ('service_requests','service_jobs')").get().n, 0);
  before.close();
  const upgraded = new SqliteStore(ordinaryPath, { serviceQueue: { upgradeExisting: true } });
  upgraded.close();
  const after = new DatabaseSync(ordinaryPath);
  assert.equal(after.prepare('PRAGMA user_version').get().user_version, 3);
  assert.equal(after.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name IN ('service_requests','service_jobs')").get().n, 2);
  after.close();

  const failedPath = join(directory, 'failed.db');
  const legacy = new SqliteStore(failedPath); legacy.createWorkspace(workspace, owner); legacy.close();
  assert.throws(() => new SqliteStore(failedPath, { serviceQueue: { upgradeExisting: true }, beforeWrite() {
    throw new Error('upgrade rollback');
  } }), /upgrade rollback/);
  const failed = new DatabaseSync(failedPath);
  assert.equal(failed.prepare('PRAGMA user_version').get().user_version, 1);
  assert.equal(failed.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name IN ('service_requests','service_jobs')").get().n, 0);
  failed.close();
});

test('mixed service and legacy reminder pages are bounded, stable and workspace scoped in protected storage', async t => {
  const { store } = await fixture(t, { encryptionKey: randomBytes(32) });
  t.after(() => store.close());
  const operator = new Operator(store, () => at);
  store.createWorkspace('other', owner);
  for (const target of [workspace, 'other']) {
    operator.createWork(target, owner, { id: 'work', title: 'Synthetic', goal: 'Private', threadId: 'thread' });
    operator.schedule(target, owner, { id: 'legacy-first', workId: 'work', dueAt: at });
    store.scheduleServiceReminder({ workspaceId: target, source: 'owner:service', requestId: 'service-request', ownerId: owner,
      envelope: { kind: 'schedule_reminder', workId: 'work', dueAt: at }, timerId: 'service-timer', at });
    operator.schedule(target, owner, { id: 'legacy-last', workId: 'work', dueAt: at });
  }
  const first = store.serviceReminderRequests(workspace, 0, 2);
  assert.deepEqual(first.items.map(item => [item.timerId, item.receipt?.requestId ?? null]),
    [['legacy-first', null], ['service-timer', 'service-request']]);
  assert.equal(first.nextAfter, first.items[1].position);
  const last = store.serviceReminderRequests(workspace, first.nextAfter, 2);
  assert.deepEqual(last.items.map(item => item.timerId), ['legacy-last']);
  assert.equal(last.nextAfter, null);
  assert.equal(first.items[1].receipt.workspaceId, workspace);
  assert.equal(store.serviceReminderRequests('other').items[1].receipt.workspaceId, 'other');
  assert.throws(() => store.serviceReminderRequests(workspace, 0, 101), error => error.code === 'invalid');
});

test('reminder schedule and fire are deduplicated transactions and queue saturation keeps it scheduled', async t => {
  const { store } = await fixture(t);
  const operator = new Operator(store, () => at);
  operator.createWork(workspace, owner, { id: 'work', title: 'Synthetic reminder', goal: 'Remember', threadId: 'thread' });
  const scheduled = store.scheduleServiceReminder({ workspaceId: workspace, source: 'owner:service', requestId: 'timer-request',
    ownerId: owner, envelope: { kind: 'schedule_reminder', workId: 'work', dueAt: at }, timerId: 'timer-1', at });
  assert.equal(scheduled.duplicate, false);
  assert.equal(store.scheduleServiceReminder({ workspaceId: workspace, source: 'owner:service', requestId: 'timer-request',
    ownerId: owner, envelope: { kind: 'schedule_reminder', workId: 'work', dueAt: at }, timerId: 'changed-default', at }).duplicate, true);
  const fired = store.admitDueTimerJob(workspace, 'timer-1', 'instance-1', at);
  assert.equal(fired.kind, 'queued');
  assert.equal(fired.job.kind, 'reminder');
  assert.equal(store.state(workspace).timers['timer-1'].status, 'fired');
  assert.equal(store.admitDueTimerJob(workspace, 'timer-1', 'instance-1', at).kind, 'unchanged');
  assert.equal(store.inbox(workspace).length, 1);

  for (let index = 1; index < 64; index++) store.admitOwnerTurnJob(ownerInput(`capacity-${index}`));
  const later = '2026-09-15T12:01:00.000Z';
  store.scheduleServiceReminder({ workspaceId: workspace, source: 'owner:service', requestId: 'timer-request-full',
    ownerId: owner, envelope: { kind: 'schedule_reminder', workId: 'work', dueAt: later }, timerId: 'timer-full', at });
  assert.equal(store.admitDueTimerJob(workspace, 'timer-full', 'instance-1', later).kind, 'full');
  assert.equal(store.state(workspace).timers['timer-full'].status, 'scheduled');
  assert.equal(store.findServiceReceipt({ workspaceId: workspace, source: 'kernel:timer', requestId: 'timer-full' },
    { kind: 'reminder', timerId: 'timer-full', workId: 'work' }), undefined);
  store.close();
});
