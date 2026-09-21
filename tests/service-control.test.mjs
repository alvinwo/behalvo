import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AgentService,
  FakeModelGateway,
  OperationRegistry,
  OperationService,
  Operator,
  OwnerControlService,
  OwnerControlSessions,
  ServiceControlService,
  ServiceRuntime,
  ServiceStorageError,
  SqliteStore
} from '../dist/index.js';

const workspaceId = 'service-control';
const ownerId = 'owner';
const now = Date.parse('2026-09-21T12:00:00.000Z');
const at = () => new Date(now).toISOString();
const model = { provider: 'scripted', model: 'synthetic' };

function fixture(t, options = {}) {
  const store = options.store ?? new SqliteStore(':memory:', { serviceQueue: { upgradeExisting: false } });
  if (!options.existing) store.createWorkspace(workspaceId, ownerId);
  const gateway = new FakeModelGateway([{ ...model, label: 'Synthetic' }], () => ({
    text: JSON.stringify(options.turn ?? { reply: 'Synthetic reply', workProposals: [], factProposals: [] })
  }));
  const registry = new OperationRegistry();
  const operations = new OperationService(store, registry, at, workspaceId);
  const agent = new AgentService(store, gateway, at, { service: operations, registry, workspaceId });
  const runtime = new ServiceRuntime(store, agent, operations, {
    workspaceId, ownerId, instanceId: 'service-instance', serviceGeneration: 'generation-1', clock: at
  });
  const sessions = new OwnerControlSessions({ workspaceId, ownerId }, () => now);
  const operator = new Operator(store, at);
  const reviews = new OwnerControlService({
    store, operator, operations, sessions, binding: { workspaceId, ownerId }, clock: () => now,
    onFatalStorageError(error) { runtime.reportStorageError(error); }
  });
  const control = new ServiceControlService({
    store, runtime, reviews, sessions, operator, binding: { workspaceId, ownerId },
    model, databaseMode: 'plaintext', clock: () => now
  });
  const bootstrap = sessions.issueBootstrap('http://127.0.0.1:4500');
  const session = sessions.exchangeBootstrap(bootstrap.token, bootstrap.origin);
  const principal = sessions.authenticate(session.token);
  t.after(() => { control.close(); store.close(); });
  return { store, runtime, operations, registry, operator, reviews, sessions, control, principal };
}

async function preparedAction(f, overrides = {}) {
  f.operator.createWork(workspaceId, ownerId, {
    id: 'work', title: 'Synthetic work', goal: 'Prepare an exact update', threadId: 'linked-thread'
  });
  f.registry.register({
    id: 'contact.update', version: '1', provider: 'synthetic-accounts',
    catalog: { description: 'Synthetic', connectionKind: 'synthetic', resourceIds: ['resource'],
      argumentsSchema: { type: 'object' }, exampleArguments: { value: 'after' } },
    validateArguments(value) { return value; },
    async identify({ connection }) { return connection.subject; },
    async observe({ connection, resourceId }) { return overrides.observe?.({ connection, resourceId }) ?? { state: { value: 'before' }, providerVersion: 'v1',
      source: connection.provider, resourceId, observedAt: at() }; },
    prepare({ arguments: args, observation }) { return { arguments: args,
      affectedResourceIds: [observation.resourceId], expectedResult: args }; },
    comparePrecondition() { return true; },
    async execute(input) { return overrides.execute?.(input) ?? { status: 'accepted', evidence: 'Synthetic accepted' }; },
    verify(input) { return overrides.verify?.(input) ?? { status: 'satisfied' }; }
  });
  f.operations.registerConnection({ workspaceId, ownerId, connection: {
    id: 'account', provider: 'synthetic-accounts', subject: 'synthetic-person', label: 'Synthetic'
  } });
  return f.operations.prepare({ workspaceId, ownerId, workId: 'work', key: 'prepared', connectionId: 'account',
    operationId: 'contact.update', operationVersion: '1', resourceId: 'resource', arguments: { value: 'after' } });
}

test('focused chat snapshots an already-linked thread and fingerprints the submitted focus without relinking', async t => {
  const f = fixture(t);
  const action = await preparedAction(f);
  const first = f.control.chat(f.principal, {
    requestId: 'chat-1', threadId: 'new-browser-thread', workId: 'work', text: 'Continue the pending work.'
  });

  assert.equal(first.duplicate, false);
  assert.equal(first.job.focus.threadId, 'linked-thread');
  assert.deepEqual(f.store.state(workspaceId).works.work.threadIds, ['linked-thread']);
  assert.equal(f.store.state(workspaceId).actions[action.id].status, 'proposed');

  const replay = f.control.chat(f.principal, {
    requestId: 'chat-1', threadId: 'new-browser-thread', workId: 'work', text: 'Continue the pending work.'
  });
  assert.equal(replay.duplicate, true);
  assert.equal(replay.receipt.id, first.receipt.id);
  assert.throws(() => f.control.chat(f.principal, {
    requestId: 'chat-1', threadId: 'different-submission', workId: 'work', text: 'Continue the pending work.'
  }), error => error?.code === 'conflict');
});

test('chat replay returns the durable first admission before current work or model checks', async t => {
  const f = fixture(t);
  f.operator.createWork(workspaceId, ownerId, {
    id: 'replay-work', title: 'Replay work', goal: 'Preserve admission', threadId: 'replay-linked'
  });
  const envelope = {
    requestId: 'chat-replay', threadId: 'submitted-thread', workId: 'replay-work', text: 'Original owner text'
  };
  const first = f.control.chat(f.principal, envelope);
  f.operator.setWorkPhase(workspaceId, ownerId, 'replay-work', 'cancelled');

  const closedReplay = f.control.chat(f.principal, envelope);
  assert.equal(closedReplay.duplicate, true);
  assert.equal(closedReplay.receipt.id, first.receipt.id);
  assert.equal(closedReplay.job.focus.threadId, 'replay-linked');

  const withoutModel = new ServiceControlService({
    store: f.store, runtime: f.runtime, reviews: f.reviews, sessions: f.sessions, operator: f.operator,
    binding: { workspaceId, ownerId }, databaseMode: 'plaintext', clock: () => now
  });
  t.after(() => withoutModel.close());
  const modelReplay = withoutModel.chat(f.principal, envelope);
  assert.equal(modelReplay.duplicate, true);
  assert.equal(modelReplay.receipt.id, first.receipt.id);
  assert.throws(() => withoutModel.chat(f.principal, { ...envelope, text: 'Conflicting owner text' }),
    error => error?.code === 'conflict');
});

test('expired reminder recovery returns only its durable receipt while a missing request cannot create a late timer', t => {
  const f = fixture(t);
  f.operator.createWork(workspaceId, ownerId, {
    id: 'reminder-work', title: 'Reminder work', goal: 'Preserve reminder admission', threadId: 'thread'
  });
  const dueAt = new Date(now + 1_000).toISOString();
  const envelope = { requestId: 'reminder-recovery', workId: 'reminder-work', dueAt };
  const first = f.control.reminder(f.principal, envelope);
  const expiredControl = new ServiceControlService({
    store: f.store, runtime: f.runtime, reviews: f.reviews, sessions: f.sessions, operator: f.operator,
    binding: { workspaceId, ownerId }, model, databaseMode: 'plaintext', clock: () => now + 1_001
  });
  t.after(() => expiredControl.close());

  const recovered = expiredControl.reminder(f.principal, envelope);
  assert.equal(recovered.duplicate, true);
  assert.equal(recovered.receipt.id, first.receipt.id);
  assert.equal(Object.keys(f.store.state(workspaceId).timers).length, 1);

  assert.throws(() => expiredControl.reminder(f.principal, {
    ...envelope, requestId: 'missing-expired-reminder'
  }), error => error?.code === 'invalid_request');
  assert.equal(Object.keys(f.store.state(workspaceId).timers).length, 1);
});

test('reminder projection preserves owner identity, work meaning, lifecycle, and exact fired job result', async t => {
  const f = fixture(t);
  f.operator.createWork(workspaceId, ownerId, {
    id: 'fired-work', title: 'Check refund', goal: 'Follow up on a refund', threadId: 'refund-thread'
  });
  f.operator.createWork(workspaceId, ownerId, {
    id: 'cancelled-work', title: 'Cancelled follow-up', goal: 'Do not fire stale work', threadId: 'cancelled-thread'
  });
  const firedDueAt = new Date(now + 1_000).toISOString();
  const cancelledDueAt = new Date(now + 2_000).toISOString();
  const fired = f.control.reminder(f.principal, {
    requestId: 'owner-refund-reminder', workId: 'fired-work', dueAt: firedDueAt
  });
  const cancelled = f.control.reminder(f.principal, {
    requestId: 'owner-cancelled-reminder', workId: 'cancelled-work', dueAt: cancelledDueAt
  });

  assert.deepEqual(f.control.reminders(f.principal).items.map(item => ({
    requestId: item.requestId, timerId: item.timerId, work: item.work, dueAt: item.dueAt, status: item.status
  })), [{
    requestId: 'owner-refund-reminder', timerId: fired.receipt.timerId,
    work: { id: 'fired-work', title: 'Check refund' }, dueAt: firedDueAt, status: 'scheduled'
  }, {
    requestId: 'owner-cancelled-reminder', timerId: cancelled.receipt.timerId,
    work: { id: 'cancelled-work', title: 'Cancelled follow-up' }, dueAt: cancelledDueAt, status: 'scheduled'
  }]);

  assert.equal(f.store.admitDueTimerJob(workspaceId, fired.receipt.timerId, 'timer-worker', firedDueAt).kind, 'queued');
  f.operator.setWorkPhase(workspaceId, ownerId, 'cancelled-work', 'cancelled');
  assert.equal(f.store.admitDueTimerJob(workspaceId, cancelled.receipt.timerId, 'timer-worker', cancelledDueAt).kind, 'cancelled');
  await f.runtime.drain();

  const restarted = new ServiceControlService({
    store: f.store, runtime: f.runtime, reviews: f.reviews, sessions: f.sessions, operator: f.operator,
    binding: { workspaceId, ownerId }, model, databaseMode: 'plaintext', clock: () => now + 3_000
  });
  t.after(() => restarted.close());
  const projection = restarted.reminders(f.principal);
  assert.deepEqual(projection.items.map(item => [item.requestId, item.status]), [
    ['owner-refund-reminder', 'fired'], ['owner-cancelled-reminder', 'cancelled']
  ]);
  assert.equal(JSON.stringify(projection).includes('Follow up on a refund'), false);
  const reminderJob = f.store.serviceJobs(workspaceId).items.find(job => job.kind === 'reminder');
  const detail = restarted.job(f.principal, reminderJob.id);
  assert.deepEqual(detail.result.reminder, projection.items[0]);
});

test('authenticated job detail resolves the exact owner and assistant text without arbitrary artifact access', async t => {
  const f = fixture(t, { turn: { reply: 'Synthetic reply',
    workProposals: [{ id: 'new-work', title: 'New work', goal: 'Visible without an action' }], factProposals: [] } });
  const admitted = f.control.chat(f.principal, {
    requestId: 'chat-result', threadId: 'result-thread', text: 'Owner question'
  });
  await f.runtime.drain();

  const detail = f.control.job(f.principal, admitted.job.id);
  assert.equal(detail.requestId, 'chat-result');
  assert.equal(detail.result.reason, 'completed');
  assert.deepEqual(detail.result.conversation, {
    threadId: 'result-thread', ownerText: 'Owner question', assistantText: 'Synthetic reply'
  });
  assert.deepEqual(detail.result.works, [{
    id: 'new-work', title: 'New work', goal: 'Visible without an action', phase: 'open'
  }]);
  assert.equal(Object.hasOwn(detail, 'parameters'), false);
  assert.equal(JSON.stringify(detail).includes('ownerRecordId'), false);
});

test('execution job and review expose outcome and verification as distinct authenticated results', async t => {
  const f = fixture(t);
  const action = await preparedAction(f);
  const approval = f.control.review(f.principal, action.id);
  f.control.approve(f.principal, action.id, { reviewToken: approval.reviewToken, digest: action.digest });
  const executable = f.control.review(f.principal, action.id);
  const admitted = f.control.execute(f.principal, action.id, {
    requestId: 'execute-result', digest: action.digest, confirmationToken: executable.executionToken
  });
  await f.runtime.drain();

  const detail = f.control.job(f.principal, admitted.job.id);
  assert.equal(detail.requestId, 'execute-result');
  assert.equal(detail.result.action.outcome.status, 'accepted');
  assert.equal(detail.result.action.outcome.evidence, 'Synthetic accepted');
  assert.equal(typeof detail.result.action.outcome.evidenceRef, 'string');
  assert.equal(detail.result.action.verification.status, 'satisfied');
  assert.equal(detail.result.action.verification.recordedAt, at());
  const reviewed = f.control.review(f.principal, action.id);
  assert.equal(reviewed.action.outcome.status, 'accepted');
  assert.equal(reviewed.action.verification.status, 'satisfied');
  assert.equal(reviewed.canExecute, false);
});

test('ordinary and crash-repaired readback preserve historical unknown outcome through encrypted restore', async t => {
  for (const completion of ['ordinary', 'crash']) await t.test(completion, async t => {
    const directory = mkdtempSync(join(tmpdir(), 'behalvo-readback-outcome-'));
    chmodSync(directory, 0o700);
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const key = randomBytes(32);
    const f = fixture(t, { store: new SqliteStore(join(directory, 'source.db'),
      { encryptionKey: key, serviceQueue: { upgradeExisting: false } }) });
    let effects = 0, verifications = 0;
    const action = await preparedAction(f, {
      execute() { effects++; return { status: 'unknown', evidence: 'Original provider outcome unavailable' }; },
      verify() { verifications++; return { status: 'satisfied' }; }
    });
    f.operations.approveBatch({ workspaceId, ownerId, expiresAt: '2026-09-21T12:10:00.000Z',
      approvals: [{ actionId: action.id, digest: action.digest }] });
    await f.operations.execute({ workspaceId, ownerId, actionId: action.id });
    const outcome = f.store.journal(workspaceId).find(record => record.event.type === 'action.finished');
    const admitted = f.control.readback(f.principal, action.id, { requestId: 'readback', digest: action.digest });
    if (completion === 'ordinary') await f.runtime.drain();
    else {
      const claimed = f.store.claimServiceJob(workspaceId, 'crashed-worker', at());
      await f.operations.verify({ workspaceId, ownerId, actionId: action.id },
        { serviceClaim: claimed.claim, deadline: Date.now() + 30_000 });
      assert.deepEqual(f.store.inspectInterruptedServiceJobs(workspaceId, at()), { repaired: 1, interrupted: 0 });
    }
    assert.equal(f.store.state(workspaceId).actions[action.id].status, 'accepted');
    const detail = f.control.job(f.principal, admitted.job.id);
    assert.equal(detail.result.action.outcome.status, 'unknown');
    assert.equal(detail.result.action.outcome.evidence, 'Original provider outcome unavailable');
    assert.equal(detail.result.action.verification.status, 'satisfied');
    const job = f.store.serviceJob(workspaceId, admitted.job.id);
    assert.equal(job.actionRecordId, outcome.id);
    assert.equal(job.result.actionRecordId, outcome.id);
    assert.equal(job.result.attemptId, outcome.event.data.attemptId);
    assert.ok(job.result.recordIds.includes(outcome.id));
    assert.equal(effects, 1);
    assert.equal(verifications, 1);
    const backupPath = join(directory, 'backup.db');
    await f.store.backup(backupPath);
    const restored = fixture(t, { store: new SqliteStore(backupPath, { encryptionKey: key, readOnly: true }), existing: true });
    assert.deepEqual(restored.control.job(restored.principal, job.id), detail);
  });
});

test('public readback completion cannot omit its historical outcome after exact verification', async t => {
  const f = fixture(t);
  const action = await preparedAction(f);
  f.operations.approveBatch({ workspaceId, ownerId, expiresAt: '2026-09-21T12:10:00.000Z',
    approvals: [{ actionId: action.id, digest: action.digest }] });
  await f.operations.execute({ workspaceId, ownerId, actionId: action.id });
  f.control.readback(f.principal, action.id, { requestId: 'readback', digest: action.digest });
  const claimed = f.store.claimServiceJob(workspaceId, 'worker', at());
  await f.operations.verify({ workspaceId, ownerId, actionId: action.id },
    { serviceClaim: claimed.claim, deadline: Date.now() + 30_000 });
  const job = f.store.serviceJob(workspaceId, claimed.id);
  assert.throws(() => f.store.completeServiceJob(workspaceId, claimed.claim, 'finished', {
    reason: 'completed', actionId: action.id, verificationRecordId: job.verificationRecordId,
    recordIds: [job.verificationRecordId]
  }, at()), error => error.code === 'integrity');
  assert.equal(f.store.serviceJob(workspaceId, job.id).status, 'running');
});

test('terminal action projection refuses missing immutable outcome instead of using current state', async t => {
  const f = fixture(t);
  const action = await preparedAction(f);
  f.operations.approveBatch({ workspaceId, ownerId, expiresAt: '2026-09-21T12:10:00.000Z',
    approvals: [{ actionId: action.id, digest: action.digest }] });
  await f.operations.execute({ workspaceId, ownerId, actionId: action.id });
  const admitted = f.control.readback(f.principal, action.id, { requestId: 'readback', digest: action.digest });
  await f.runtime.drain();
  const original = f.store.serviceJob.bind(f.store);
  f.store.serviceJob = (...args) => {
    const job = original(...args);
    delete job.result.actionRecordId;
    delete job.result.attemptId;
    return job;
  };
  assert.throws(() => f.control.job(f.principal, admitted.job.id), error => error.code === 'unavailable');
});

test('execution job detail keeps its exact outcome evidence after later owner reconciliation', async t => {
  const f = fixture(t);
  const action = await preparedAction(f, { verify() { return { status: 'not_satisfied' }; } });
  const approval = f.control.review(f.principal, action.id);
  f.control.approve(f.principal, action.id, { reviewToken: approval.reviewToken, digest: action.digest });
  const executable = f.control.review(f.principal, action.id);
  const admitted = f.control.execute(f.principal, action.id, {
    requestId: 'execute-exact-result', digest: action.digest, confirmationToken: executable.executionToken
  });
  await f.runtime.drain();
  f.operations.reconcile({ workspaceId, ownerId, actionId: action.id, status: 'accepted',
    evidence: 'Later owner attestation' });

  const detail = f.control.job(f.principal, admitted.job.id);
  assert.equal(detail.result.action.outcome.status, 'accepted');
  assert.equal(detail.result.action.outcome.evidence, 'Synthetic accepted');
  assert.equal(detail.result.action.verification.status, 'not_satisfied');
});

test('authenticated control integrity faults synchronously fence an execution held in preflight', async t => {
  const f = fixture(t);
  let observeCalls = 0;
  let releasePreflight;
  let preflightStarted;
  const preflight = new Promise(resolve => { preflightStarted = resolve; });
  let effects = 0;
  const action = await preparedAction(f, {
    observe({ connection, resourceId }) {
      observeCalls++;
      if (observeCalls === 2) {
        preflightStarted();
        return new Promise(resolve => { releasePreflight = () => resolve({ state: { value: 'before' },
          providerVersion: 'v1', source: connection.provider, resourceId, observedAt: at() }); });
      }
      return { state: { value: 'before' }, providerVersion: 'v1', source: connection.provider,
        resourceId, observedAt: at() };
    },
    execute() { effects++; return { status: 'accepted', evidence: 'must not run' }; }
  });
  const review = f.control.review(f.principal, action.id);
  f.control.approve(f.principal, action.id, { reviewToken: review.reviewToken, digest: action.digest });
  const executable = f.control.review(f.principal, action.id);
  f.control.execute(f.principal, action.id, {
    requestId: 'held-execute', digest: action.digest, confirmationToken: executable.executionToken
  });
  const draining = f.runtime.drain();
  await preflight;
  f.store.serviceJobs = () => { throw new ServiceStorageError('integrity', 'synthetic corruption'); };

  let controlError;
  try { f.control.jobs(f.principal); } catch (error) { controlError = error; }
  const snapshot = f.runtime.snapshot();
  releasePreflight();
  let drainError;
  try { await draining; } catch (error) { drainError = error; }

  assert.equal(controlError?.code, 'unavailable');
  assert.equal(snapshot.accepting, false);
  assert.equal(snapshot.faulted, true);
  assert.match(drainError?.message ?? '', /synthetic corruption/);
  assert.equal(effects, 0);
  assert.equal(f.store.state(workspaceId).actions[action.id].status, 'approved');
});

test('all authenticated control read paths latch fatal storage faults before sanitizing them', async t => {
  const cases = [
    ['state', f => f.control.status(f.principal), f => { f.store.state = () => {
      throw new ServiceStorageError('integrity', 'state corruption');
    }; }],
    ['job', f => f.control.job(f.principal, 'synthetic-job'), f => { f.store.serviceJob = () => {
      throw new ServiceStorageError('integrity', 'job corruption');
    }; }],
    ['receipt', f => f.control.chat(f.principal, {
      requestId: 'receipt-fault', threadId: 'thread', text: 'Synthetic'
    }), f => { f.store.findServiceReceipt = () => {
      throw new ServiceStorageError('integrity', 'receipt corruption');
    }; }],
    ['review', f => f.control.review(f.principal, 'synthetic-action'), f => { f.store.state = () => {
      throw new ServiceStorageError('integrity', 'review corruption');
    }; }],
    ['queue status', f => f.control.status(f.principal), f => { f.store.serviceQueueCounts = () => {
      throw new ServiceStorageError('integrity', 'queue corruption');
    }; }]
  ];
  for (const [name, invoke, corrupt] of cases) {
    await t.test(name, child => {
      const f = fixture(child);
      corrupt(f);
      assert.throws(() => invoke(f), error => error?.code === 'unavailable');
      assert.equal(f.runtime.snapshot().accepting, false);
      assert.equal(f.runtime.snapshot().faulted, true);
    });
  }
});

test('delegated authenticated decisions latch fatal storage faults before returning a safe error', async t => {
  const f = fixture(t);
  const action = await preparedAction(f);
  const review = f.control.review(f.principal, action.id);
  f.operations.approveBatch = () => {
    throw new ServiceStorageError('integrity', 'decision corruption');
  };

  assert.throws(() => f.control.approve(f.principal, action.id, {
    reviewToken: review.reviewToken, digest: action.digest
  }), error => error?.code === 'unavailable');
  assert.equal(f.runtime.snapshot().accepting, false);
  assert.equal(f.runtime.snapshot().faulted, true);
});

test('service inputs reject client-selected trust bindings and approval never admits or executes work', async t => {
  const f = fixture(t);
  const action = await preparedAction(f);
  assert.throws(() => f.control.chat(f.principal, {
    requestId: 'chat-extra', threadId: 'linked-thread', text: 'Synthetic', ownerId
  }), error => error?.code === 'invalid_request');

  const review = f.control.review(f.principal, action.id);
  const approved = f.control.approve(f.principal, action.id, {
    reviewToken: review.reviewToken, digest: action.digest
  });
  assert.equal(approved.status, 'approved');
  assert.equal(f.store.serviceQueueCounts(workspaceId).queued, 0);
  assert.equal(f.store.state(workspaceId).actions[action.id].status, 'approved');
});

test('status distinguishes a crash-preserved running action as an exclusive-maintenance barrier', async t => {
  const f = fixture(t);
  const action = await preparedAction(f);
  const review = f.control.review(f.principal, action.id);
  f.control.approve(f.principal, action.id, { reviewToken: review.reviewToken, digest: action.digest });
  f.store.admitActionJob({ workspaceId, source: 'owner:service', requestId: 'orphan-execution', ownerId,
    envelope: { kind: 'execute', actionId: action.id, digest: action.digest }, instanceId: 'crashed-instance', at: at() });
  const claimed = f.store.claimServiceJob(workspaceId, 'crashed-instance', at());
  f.store.startActionAttempt(workspaceId, f.store.state(workspaceId).version, action.id, 'orphan-attempt', {},
    undefined, claimed.claim);

  const status = f.control.status(f.principal);
  assert.deepEqual(status.unresolvedActions, [{
    actionId: action.id, status: 'running', kind: 'crash_preserved_execution'
  }]);
  assert.deepEqual(status.unresolvedActionIds, [action.id]);
});

test('execution requires a fresh purpose-bound one-use confirmation while lost acknowledgements return the durable receipt first', async t => {
  const f = fixture(t);
  const action = await preparedAction(f);
  const approvalReview = f.control.review(f.principal, action.id);
  f.control.approve(f.principal, action.id, {
    reviewToken: approvalReview.reviewToken, digest: action.digest
  });
  const executeReview = f.control.review(f.principal, action.id);
  assert.match(executeReview.executionToken, /^[A-Za-z0-9_-]{43}$/);

  assert.throws(() => f.control.execute(f.principal, action.id, {
    requestId: 'wrong-purpose', digest: action.digest,
    confirmationToken: Buffer.alloc(32, 7).toString('base64url')
  }), error => error?.code === 'conflict');
  const admitted = f.control.execute(f.principal, action.id, {
    requestId: 'execute-1', digest: action.digest, confirmationToken: executeReview.executionToken
  });
  assert.equal(admitted.duplicate, false);
  assert.throws(() => f.control.execute(f.principal, action.id, {
    requestId: 'execute-2', digest: action.digest, confirmationToken: executeReview.executionToken
  }), error => error?.code === 'conflict');

  const replay = f.control.execute(f.principal, action.id, {
    requestId: 'execute-1', digest: action.digest,
    confirmationToken: Buffer.alloc(32, 3).toString('base64url')
  });
  assert.equal(replay.duplicate, true);
  assert.equal(replay.receipt.id, admitted.receipt.id);
  assert.equal(f.store.serviceQueueCounts(workspaceId).queued, 1);
});
