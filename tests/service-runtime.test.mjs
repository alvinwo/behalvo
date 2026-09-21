import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentService, OperationRegistry, OperationService, Operator, ServiceRuntime,
  ServiceStorageError, SqliteStore } from '../dist/index.js';

const workspaceId = 'service-runtime';
const ownerId = 'owner';
const at = '2026-09-21T12:00:00.000Z';

function final(reply = 'Synthetic reply') {
  return { reply, workProposals: [], factProposals: [] };
}

function fixture(responses = [], options = {}) {
  const store = options.store ?? new SqliteStore(':memory:', { serviceQueue: { upgradeExisting: false } });
  if (!options.existing) store.createWorkspace(workspaceId, ownerId);
  const requests = [];
  const gateway = { async listModels() { return []; }, async complete(request) {
    requests.push(request);
    const response = responses.shift();
    if (typeof response === 'function') return response(request);
    return { text: JSON.stringify(response ?? final()) };
  } };
  const registry = new OperationRegistry();
  const operations = new OperationService(store, registry, () => at, workspaceId);
  const agent = new AgentService(store, gateway, () => at,
    options.withoutLoop ? undefined : { service: operations, registry, workspaceId });
  const runtime = new ServiceRuntime(store, agent, operations, {
    workspaceId, ownerId, instanceId: 'runtime-1', serviceGeneration: 'generation-1', clock: () => at,
    ...options.runtime
  });
  return { store, gateway, registry, operations, agent, runtime, requests };
}

function admit(runtime, requestId, text = `Synthetic ${requestId}`, extra = {}) {
  return runtime.admitOwnerTurn({ requestId, threadId: 'thread', text,
    model: { provider: 'scripted', model: 'synthetic' }, ...extra });
}

async function actionFixture(t, options = {}) {
  const f = fixture();
  t.after(() => f.store.close());
  const operator = new Operator(f.store, () => at);
  operator.createWork(workspaceId, ownerId, { id: 'work', title: 'Synthetic', goal: 'Exact action', threadId: 'thread' });
  let effects = 0;
  let identifyCalls = 0;
  let verificationCalls = 0;
  let remote = { value: 'before' };
  f.registry.register({
    id: 'synthetic.update', version: '1', provider: 'synthetic',
    catalog: { description: 'Synthetic', connectionKind: 'synthetic', resourceIds: ['resource'],
      argumentsSchema: { type: 'object' }, exampleArguments: { value: 'after' } },
    validateArguments(value) { return value; },
    async identify({ connection }) {
      identifyCalls++;
      return options.identify && identifyCalls > 1 ? options.identify(connection) : connection.subject;
    },
    async observe({ connection, resourceId }) { return { state: remote, providerVersion: `v${effects}`,
      source: connection.provider, resourceId, observedAt: at }; },
    prepare({ arguments: args, observation }) { return { arguments: args,
      affectedResourceIds: [observation.resourceId], expectedResult: args }; },
    comparePrecondition() { return true; },
    async execute(input) {
      effects++;
      if (options.execute) return options.execute(input, value => { remote = value; });
      remote = input.command.expectedResult;
      return { status: options.outcome ?? 'accepted', evidence: 'Synthetic outcome' };
    },
    verify({ command, observation }) {
      verificationCalls++;
      if (options.verify) return options.verify({ command, observation });
      return { status: JSON.stringify(command.expectedResult) === JSON.stringify(observation.state)
        ? 'satisfied' : 'not_satisfied' };
    }
  });
  f.operations.registerConnection({ workspaceId, ownerId,
    connection: { id: 'account', provider: 'synthetic', subject: 'subject', label: 'Synthetic' } });
  const action = await f.operations.prepare({ workspaceId, ownerId, workId: 'work', key: 'prepared', connectionId: 'account',
    operationId: 'synthetic.update', operationVersion: '1', resourceId: 'resource', arguments: { value: 'after' } });
  f.operations.approveBatch({ workspaceId, ownerId, expiresAt: '2026-09-21T12:10:00.000Z',
    approvals: [{ actionId: action.id, digest: action.digest }] });
  return { ...f, action, effects: () => effects, verificationCalls: () => verificationCalls };
}

test('an admitted owner turn is processed from its stored record without re-ingestion', async t => {
  const f = fixture([final('Stored input handled')]);
  t.after(() => f.store.close());
  const admitted = admit(f.runtime, 'turn-1');
  const ownerRecordId = admitted.job.parameters.ownerRecordId;
  assert.equal(f.store.inbox(workspaceId).length, 1);

  await f.runtime.drain();

  const job = f.store.serviceJob(workspaceId, admitted.job.id);
  assert.equal(job.status, 'finished');
  assert.equal(job.result.reason, 'completed');
  assert.equal(f.store.journal(workspaceId).filter(record => record.id === ownerRecordId).length, 1);
  assert.equal(f.store.inbox(workspaceId).length, 0);
  assert.equal(f.requests.length, 1);
});

test('service chat is prepare-only and cannot execute or verify an approved action', async t => {
  const f = fixture();
  t.after(() => f.store.close());
  const operator = new Operator(f.store, () => at);
  operator.createWork(workspaceId, ownerId, { id: 'work', title: 'Synthetic', goal: 'No chat dispatch', threadId: 'thread' });
  let effects = 0;
  f.registry.register({
    id: 'synthetic.update', version: '1', provider: 'synthetic',
    catalog: { description: 'Synthetic', connectionKind: 'synthetic', resourceIds: ['resource'],
      argumentsSchema: { type: 'object' }, exampleArguments: {} },
    validateArguments(value) { return value; },
    async identify({ connection }) { return connection.subject; },
    async observe({ connection, resourceId }) { return { state: {}, providerVersion: 'v1', source: connection.provider,
      resourceId, observedAt: at }; },
    prepare({ arguments: args, observation }) { return { arguments: args, affectedResourceIds: [observation.resourceId], expectedResult: args }; },
    comparePrecondition() { return true; },
    async execute() { effects++; return { status: 'accepted', evidence: 'Synthetic accepted' }; },
    verify() { return { status: 'satisfied' }; }
  });
  f.operations.registerConnection({ workspaceId, ownerId,
    connection: { id: 'account', provider: 'synthetic', subject: 'subject', label: 'Synthetic' } });
  const action = await f.operations.prepare({ workspaceId, ownerId, workId: 'work', key: 'prepared', connectionId: 'account',
    operationId: 'synthetic.update', operationVersion: '1', resourceId: 'resource', arguments: {} });
  f.operations.approveBatch({ workspaceId, ownerId, expiresAt: '2026-09-21T12:10:00.000Z',
    approvals: [{ actionId: action.id, digest: action.digest }] });
  f.gateway.complete = async () => ({ text: JSON.stringify({ tool: { name: 'execute', arguments: { actionId: action.id } } }) });

  const admitted = admit(f.runtime, 'chat-execute', 'Execute the approved action', { workId: 'work' });
  await f.runtime.drain();

  assert.equal(effects, 0);
  assert.equal(f.store.state(workspaceId).actions[action.id].status, 'approved');
  assert.equal(f.store.serviceJob(workspaceId, admitted.job.id).result.reason, 'invalid_model_result');
});

test('drain is coalesced and status remains responsive while inference is pending', async t => {
  let release;
  const f = fixture([() => new Promise(resolve => { release = resolve; })]);
  t.after(() => f.store.close());
  const admitted = admit(f.runtime, 'pending');

  const first = f.runtime.drain();
  const second = f.runtime.drain();
  await new Promise(resolve => setImmediate(resolve));
  const snapshot = f.runtime.snapshot();
  assert.equal(snapshot.accepting, true);
  assert.equal(snapshot.faulted, false);
  assert.equal(snapshot.activeJobId, admitted.job.id);
  assert.equal(snapshot.activeStartedAt, at);
  assert.equal(f.requests.length, 1);

  release({ text: JSON.stringify(final()) });
  await Promise.all([first, second]);
  assert.equal(f.requests.length, 1);
  assert.equal(f.runtime.snapshot().activeJobId, null);
});

test('ordinary job failures stop that job and advance FIFO', async t => {
  const f = fixture([() => { throw new Error('SYNTHETIC_PROVIDER_SECRET'); }, final('Second handled')]);
  t.after(() => f.store.close());
  const first = admit(f.runtime, 'first');
  const second = admit(f.runtime, 'second');

  await f.runtime.drain();

  assert.equal(f.store.serviceJob(workspaceId, first.job.id).status, 'stopped');
  assert.equal(f.store.serviceJob(workspaceId, first.job.id).result.reason, 'model_unavailable');
  assert.equal(f.store.serviceJob(workspaceId, second.job.id).status, 'finished');
  assert.equal(f.requests.length, 2);
  assert.equal(JSON.stringify(f.store.serviceJob(workspaceId, first.job.id)).includes('SYNTHETIC_PROVIDER_SECRET'), false);
});

test('trusted integrity faults stop admission and dispatch while invalid conflicts do not', async t => {
  const f = fixture();
  t.after(() => f.store.close());
  const first = admit(f.runtime, 'same', 'First body');
  assert.throws(() => admit(f.runtime, 'same', 'Conflicting body'), error => error.code === 'conflict');
  assert.equal(f.runtime.snapshot().faulted, false);

  const originalClaim = f.store.claimServiceJob.bind(f.store);
  f.store.claimServiceJob = () => { throw new ServiceStorageError('integrity', 'Fixed storage fault'); };
  await assert.rejects(f.runtime.drain(), error => error.code === 'integrity');
  assert.equal(f.runtime.snapshot().faulted, true);
  assert.equal(f.runtime.snapshot().accepting, false);
  assert.equal(f.store.serviceJob(workspaceId, first.job.id).status, 'queued');
  assert.throws(() => admit(f.runtime, 'after-fault'), /unavailable|fault/i);
  f.store.claimServiceJob = originalClaim;
});

test('execute job binds its exact claim and performs bounded accepted readback', async t => {
  const f = await actionFixture(t);
  const admitted = f.runtime.admitAction({ requestId: 'execute-1', kind: 'execute',
    actionId: f.action.id, digest: f.action.digest });

  await f.runtime.drain();

  const job = f.store.serviceJob(workspaceId, admitted.job.id);
  assert.equal(job.status, 'finished');
  assert.equal(job.result.reason, 'completed');
  assert.ok(job.attemptId);
  assert.equal(job.result.attemptId, job.attemptId);
  assert.ok(job.result.actionRecordId);
  assert.ok(job.result.verificationRecordId);
  assert.equal(f.effects(), 1);
  assert.equal(f.store.state(workspaceId).actions[f.action.id].verification.status, 'satisfied');
});

test('failed action outcome is committed once and FIFO continues without retry', async t => {
  const f = await actionFixture(t, { outcome: 'failed' });
  const failed = f.runtime.admitAction({ requestId: 'execute-failed', kind: 'execute',
    actionId: f.action.id, digest: f.action.digest });
  const owner = admit(f.runtime, 'after-failed');

  await f.runtime.drain();

  assert.equal(f.effects(), 1);
  assert.equal(f.store.serviceJob(workspaceId, failed.job.id).status, 'stopped');
  assert.equal(f.store.serviceJob(workspaceId, failed.job.id).result.reason, 'action_failed');
  assert.equal(f.store.serviceJob(workspaceId, owner.job.id).status, 'finished');
  assert.equal(f.runtime.snapshot().faulted, false);
});

test('explicit readback never redispatches an accepted unresolved action', async t => {
  const f = await actionFixture(t);
  await f.operations.execute({ workspaceId, ownerId, actionId: f.action.id });
  assert.equal(f.effects(), 1);
  const admitted = f.runtime.admitAction({ requestId: 'readback-1', kind: 'readback',
    actionId: f.action.id, digest: f.action.digest });

  await f.runtime.drain();

  assert.equal(f.effects(), 1);
  assert.equal(f.store.serviceJob(workspaceId, admitted.job.id).status, 'finished');
  assert.ok(f.store.serviceJob(workspaceId, admitted.job.id).result.verificationRecordId);
});

test('unresolved explicit readback of an unknown effect preserves the barrier without faulting or blocking queued work', async t => {
  for (const verdict of ['not_satisfied', 'unknown']) await t.test(verdict, async t => {
    const f = await actionFixture(t, { outcome: 'unknown', verify: () => ({ status: verdict }) });
    await f.operations.execute({ workspaceId, ownerId, actionId: f.action.id });
    const admitted = f.runtime.admitAction({ requestId: `unknown-${verdict}`, kind: 'readback',
      actionId: f.action.id, digest: f.action.digest });
    const next = admit(f.runtime, 'next-owner-turn');
    await f.runtime.drain();
    const job = f.store.serviceJob(workspaceId, admitted.job.id);
    assert.equal(job.status, 'stopped');
    assert.equal(job.result.reason, 'readback_unresolved');
    assert.equal(f.store.record(workspaceId, job.result.verificationRecordId).event.data.verification.status, verdict);
    assert.equal(f.store.state(workspaceId).actions[f.action.id].status, 'unknown');
    assert.equal(f.runtime.snapshot().faulted, false);
    assert.equal(f.runtime.snapshot().accepting, true);
    assert.equal(f.store.serviceJob(workspaceId, next.job.id).status, 'finished');
    assert.equal(f.effects(), 1);
    assert.equal(f.verificationCalls(), 1);
    assert.ok(admit(f.runtime, 'subsequent-owner-turn').job);
  });
});

test('explicit readback completes only for a satisfied trusted verification', async t => {
  for (const verdict of ['not_satisfied', 'unknown']) await t.test(verdict, async t => {
    const f = await actionFixture(t, {
      execute() { return { status: 'accepted', evidence: 'Accepted without changing remote state' }; },
      verify() { return { status: verdict }; }
    });
    await f.operations.execute({ workspaceId, ownerId, actionId: f.action.id });
    const admitted = f.runtime.admitAction({ requestId: `readback-${verdict}`, kind: 'readback',
      actionId: f.action.id, digest: f.action.digest });

    await f.runtime.drain();

    const job = f.store.serviceJob(workspaceId, admitted.job.id);
    assert.equal(job.status, 'stopped');
    assert.equal(job.result.reason, 'readback_unresolved');
    assert.ok(job.result.verificationRecordId);
    assert.equal(f.store.record(workspaceId, job.result.verificationRecordId)
      .event.data.verification.status, verdict);
    assert.equal(f.effects(), 1);
  });

  await t.test('owner_attested', async t => {
    const f = await actionFixture(t, {
      execute() { return { status: 'accepted', evidence: 'Accepted without changing remote state' }; }
    });
    await f.operations.execute({ workspaceId, ownerId, actionId: f.action.id });
    f.operations.reconcile({ workspaceId, ownerId, actionId: f.action.id,
      status: 'accepted', evidence: 'Owner observed the result independently.' });
    const admitted = f.runtime.admitAction({ requestId: 'readback-owner-attested', kind: 'readback',
      actionId: f.action.id, digest: f.action.digest });

    await f.runtime.drain();

    const job = f.store.serviceJob(workspaceId, admitted.job.id);
    assert.equal(job.status, 'stopped');
    assert.equal(job.result.reason, 'readback_unresolved');
    assert.equal(f.store.state(workspaceId).actions[f.action.id].verification.status, 'owner_attested');
    assert.equal(f.effects(), 1);
  });
});

test('readback after earlier unknown resolution never imports old verification or faults the service', async t => {
  for (const resolution of ['satisfied', 'owner_attested']) await t.test(resolution, async t => {
    const f = await actionFixture(t, { outcome: 'unknown' });
    await f.operations.execute({ workspaceId, ownerId, actionId: f.action.id });
    if (resolution === 'satisfied') await f.operations.verify({ workspaceId, ownerId, actionId: f.action.id });
    else f.operations.reconcile({ workspaceId, ownerId, actionId: f.action.id,
      status: 'accepted', evidence: 'Synthetic owner resolution' });
    const admitted = f.runtime.admitAction({ requestId: `resolved-${resolution}`, kind: 'readback',
      actionId: f.action.id, digest: f.action.digest });
    await f.runtime.drain();
    const job = f.store.serviceJob(workspaceId, admitted.job.id);
    assert.equal(job.status, 'stopped');
    assert.equal(job.result.reason, 'readback_unresolved');
    assert.equal(job.result.verificationRecordId, undefined);
    assert.equal(f.store.record(workspaceId, job.result.actionRecordId).event.data.status, 'unknown');
    assert.equal(f.runtime.snapshot().faulted, false);
    assert.equal(f.effects(), 1);
    assert.equal(f.verificationCalls(), resolution === 'satisfied' ? 1 : 0);
  });
});

test('restart repairs execute and readback from their exact durably associated verification', async t => {
  for (const kind of ['execute', 'readback']) for (const verdict of ['satisfied', 'not_satisfied'])
    await t.test(`${kind}/${verdict}`, async t => {
    const f = await actionFixture(t, verdict === 'satisfied' ? {} : { verify() { return { status: verdict }; } });
    if (kind === 'readback') await f.operations.execute({ workspaceId, ownerId, actionId: f.action.id });
    const admitted = f.runtime.admitAction({ requestId: `verified-crash-${kind}`, kind,
      actionId: f.action.id, digest: f.action.digest });
    const originalComplete = f.store.completeServiceJob.bind(f.store);
    const fatal = new ServiceStorageError('integrity', 'Synthetic crash after verification association');
    f.store.completeServiceJob = () => { throw fatal; };

    await assert.rejects(f.runtime.drain(), error => error === fatal);

    const running = f.store.serviceJob(workspaceId, admitted.job.id);
    assert.equal(running.status, 'running');
    assert.ok(running.verificationRecordId);
    const exactVerificationId = running.verificationRecordId;
    assert.equal(f.verificationCalls(), 1);
    assert.equal(f.effects(), 1);
    f.store.completeServiceJob = originalComplete;

    assert.deepEqual(f.store.inspectInterruptedServiceJobs(workspaceId, at), { repaired: 1, interrupted: 0 });
    const recovered = f.store.serviceJob(workspaceId, admitted.job.id);
    assert.equal(recovered.status, verdict === 'satisfied' ? 'finished' : 'stopped');
    assert.equal(recovered.result.reason, verdict === 'satisfied' ? 'completed' : 'readback_unresolved');
    assert.equal(recovered.result.verificationRecordId, exactVerificationId);
    assert.equal(f.verificationCalls(), 1);
    assert.equal(f.effects(), 1);
  });
});

test('a replayed execution request stops as ineligible without redispatch or runtime fault', async t => {
  const f = await actionFixture(t);
  await f.operations.execute({ workspaceId, ownerId, actionId: f.action.id });
  assert.equal(f.effects(), 1);
  const admitted = f.runtime.admitAction({ requestId: 'execute-replay', kind: 'execute',
    actionId: f.action.id, digest: f.action.digest });

  await f.runtime.drain();

  assert.equal(f.effects(), 1);
  assert.equal(f.store.serviceJob(workspaceId, admitted.job.id).status, 'stopped');
  assert.equal(f.store.serviceJob(workspaceId, admitted.job.id).result.reason, 'action_ineligible');
  assert.equal(f.runtime.snapshot().faulted, false);
});

test('cancellation racing after claim remains pre-start ineligibility, not an integrity fault', async t => {
  const f = await actionFixture(t);
  const admitted = f.runtime.admitAction({ requestId: 'execute-cancel-race', kind: 'execute',
    actionId: f.action.id, digest: f.action.digest });
  const originalExecute = f.operations.execute.bind(f.operations);
  f.operations.execute = async input => {
    new Operator(f.store, () => at).cancelAction(workspaceId, ownerId, input.actionId, 'Synthetic race');
    return f.store.state(workspaceId).actions[input.actionId];
  };

  await f.runtime.drain();

  assert.equal(f.effects(), 0);
  assert.equal(f.store.serviceJob(workspaceId, admitted.job.id).result.reason, 'action_ineligible');
  assert.equal(f.runtime.snapshot().faulted, false);
  f.operations.execute = originalExecute;
});

test('shutdown before action start stops safely without dispatch', async t => {
  let releaseIdentify;
  const f = await actionFixture(t, { identify: () => new Promise(resolve => { releaseIdentify = resolve; }) });
  const admitted = f.runtime.admitAction({ requestId: 'cancel-preflight', kind: 'execute',
    actionId: f.action.id, digest: f.action.digest });
  const draining = f.runtime.drain();
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(await f.runtime.shutdown(), true);
  await draining;
  assert.equal(f.effects(), 0);
  assert.equal(f.store.state(workspaceId).actions[f.action.id].status, 'approved');
  assert.equal(f.store.serviceJob(workspaceId, admitted.job.id).result.reason, 'cancelled');
  releaseIdentify('subject');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.effects(), 0);
});

test('execution revalidates domain authorization after durable start and before dispatch', async t => {
  const f = await actionFixture(t);
  const originalStart = f.store.startActionAttempt.bind(f.store);
  f.store.startActionAttempt = (...args) => {
    const result = originalStart(...args);
    queueMicrotask(() => f.operations.revokeConnection({ workspaceId, ownerId, connectionId: 'account' }));
    return result;
  };
  const admitted = f.runtime.admitAction({ requestId: 'revalidate-after-start', kind: 'execute',
    actionId: f.action.id, digest: f.action.digest });

  await f.runtime.drain();

  assert.equal(f.effects(), 0);
  assert.equal(f.store.state(workspaceId).connections.account.status, 'revoked');
  assert.equal(f.store.state(workspaceId).actions[f.action.id].status, 'unknown');
  assert.equal(f.store.serviceJob(workspaceId, admitted.job.id).result.reason, 'action_unknown');
});

for (const late of ['resolve', 'reject']) {
  test(`shutdown after action start records unknown and ignores late ${late}`, async t => {
    let releaseEffect;
    let rejectEffect;
    let markStarted;
    const started = new Promise(resolve => { markStarted = resolve; });
    const f = await actionFixture(t, { execute: () => {
      markStarted();
      return new Promise((resolve, reject) => { releaseEffect = resolve; rejectEffect = reject; });
    } });
    const admitted = f.runtime.admitAction({ requestId: `cancel-started-${late}`, kind: 'execute',
      actionId: f.action.id, digest: f.action.digest });
    const draining = f.runtime.drain();
    await started;

    assert.equal(await f.runtime.shutdown(), true);
    await draining;
    const settled = f.store.serviceJob(workspaceId, admitted.job.id);
    assert.equal(settled.status, 'stopped');
    assert.equal(settled.result.reason, 'action_unknown');
    assert.ok(settled.result.actionRecordId);
    assert.equal(f.store.state(workspaceId).actions[f.action.id].status, 'unknown');
    assert.equal(f.runtime.snapshot().faulted, false);
    const before = f.store.journal(workspaceId).length;
    if (late === 'resolve') releaseEffect({ status: 'accepted', evidence: 'Late accepted' });
    else rejectEffect(new Error('SYNTHETIC_LATE_SECRET'));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.store.journal(workspaceId).length, before);
  });
}

test('scheduler processes due reminders up to queue capacity and reminders never call model or effects', async t => {
  const f = fixture();
  t.after(() => f.store.close());
  const operator = new Operator(f.store, () => at);
  operator.createWork(workspaceId, ownerId, { id: 'work', title: 'Synthetic', goal: 'Reminders', threadId: 'thread' });
  for (let index = 0; index < 101; index++) f.runtime.scheduleReminder({ requestId: `schedule-${index}`,
    timerId: `timer-${String(index).padStart(3, '0')}`, workId: 'work', dueAt: at });
  assert.equal(f.runtime.snapshot().nextDueAt, at);

  await f.runtime.tick();

  const timers = Object.values(f.store.state(workspaceId).timers);
  assert.equal(timers.filter(timer => timer.status === 'fired').length, 64);
  assert.equal(timers.filter(timer => timer.status === 'scheduled').length, 37);
  assert.equal(f.requests.length, 0);
  const counts = f.store.serviceQueueCounts(workspaceId);
  assert.equal(counts.queued + counts.running + counts.finished, 64);
  assert.equal(f.runtime.snapshot().nextDueAt, at);
});

test('scheduler admits due reminders up to capacity without waiting for inference drain', async t => {
  let release;
  const f = fixture([() => new Promise(resolve => { release = resolve; })]);
  t.after(() => f.store.close());
  new Operator(f.store, () => at).createWork(workspaceId, ownerId,
    { id: 'work', title: 'Synthetic', goal: 'Reminders', threadId: 'thread' });
  admit(f.runtime, 'pending-before-timers');
  for (let index = 0; index < 3; index++) f.runtime.scheduleReminder({ requestId: `poll-${index}`,
    timerId: `poll-timer-${index}`, workId: 'work', dueAt: at });
  const draining = f.runtime.drain();
  await new Promise(resolve => setImmediate(resolve));

  const ticking = f.runtime.tick();
  await new Promise(resolve => setImmediate(resolve));
  const timers = Object.values(f.store.state(workspaceId).timers);
  const fired = timers.filter(timer => timer.status === 'fired').length;

  release({ text: JSON.stringify(final()) });
  await Promise.all([draining, ticking]);
  assert.equal(fired, 3);
});

test('successful shutdown settles scheduler continuations before storage can close', async t => {
  let release;
  const f = fixture([() => new Promise(resolve => { release = resolve; })]);
  new Operator(f.store, () => at).createWork(workspaceId, ownerId,
    { id: 'work', title: 'Synthetic', goal: 'Reminders', threadId: 'thread' });
  admit(f.runtime, 'pending-for-shutdown');
  for (let index = 0; index < 3; index++) f.runtime.scheduleReminder({ requestId: `shutdown-${index}`,
    timerId: `shutdown-timer-${index}`, workId: 'work', dueAt: at });
  const draining = f.runtime.drain();
  await new Promise(resolve => setImmediate(resolve));
  const ticking = f.runtime.tick();
  await new Promise(resolve => setImmediate(resolve));

  const beforeShutdown = Object.values(f.store.state(workspaceId).timers).map(timer => timer.status);
  assert.equal(await f.runtime.shutdown(), true);
  const afterShutdown = Object.values(f.store.state(workspaceId).timers).map(timer => timer.status);
  f.store.close();
  release({ text: JSON.stringify(final()) });
  const settlements = await Promise.allSettled([draining, ticking]);
  await new Promise(resolve => setImmediate(resolve));

  assert.deepEqual(afterShutdown, beforeShutdown);
  assert.deepEqual(settlements.map(result => result.status), ['fulfilled', 'fulfilled']);
});

test('a concurrent fatal runtime fault leaves the active action and job nonterminal', async t => {
  let release;
  let started;
  const dispatched = new Promise(resolve => { started = resolve; });
  const f = await actionFixture(t, { execute: () => {
    started();
    return new Promise(resolve => { release = resolve; });
  } });
  const admitted = f.runtime.admitAction({ requestId: 'fatal-active-action', kind: 'execute',
    actionId: f.action.id, digest: f.action.digest });
  const draining = f.runtime.drain();
  await dispatched;
  const fatal = new ServiceStorageError('integrity', 'Synthetic concurrent integrity fault');
  const originalAdmit = f.store.admitOwnerTurnJob.bind(f.store);
  f.store.admitOwnerTurnJob = () => { throw fatal; };

  assert.throws(() => admit(f.runtime, 'fatal-race'), error => error === fatal);
  let drainError;
  try { await draining; } catch (error) { drainError = error; }
  release({ status: 'accepted', evidence: 'Late result' });
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(drainError, fatal);
  assert.equal(f.runtime.snapshot().faulted, true);
  assert.equal(f.store.state(workspaceId).actions[f.action.id].status, 'running');
  assert.equal(f.store.serviceJob(workspaceId, admitted.job.id).status, 'running');
  f.store.admitOwnerTurnJob = originalAdmit;
});

test('a fatal fault during accepted readback preserves the outcome without terminalizing the job', async t => {
  let releaseReadback;
  let markReadback;
  let executionIdentityCalls = 0;
  const readbackStarted = new Promise(resolve => { markReadback = resolve; });
  const f = await actionFixture(t, { identify: () => {
    executionIdentityCalls++;
    if (executionIdentityCalls === 1) return 'subject';
    markReadback();
    return new Promise(resolve => { releaseReadback = resolve; });
  } });
  const admitted = f.runtime.admitAction({ requestId: 'fatal-accepted-readback', kind: 'execute',
    actionId: f.action.id, digest: f.action.digest });
  const draining = f.runtime.drain();
  await readbackStarted;
  const fatal = new ServiceStorageError('integrity', 'Synthetic fatal during accepted readback');
  const originalAdmit = f.store.admitOwnerTurnJob.bind(f.store);
  f.store.admitOwnerTurnJob = () => { throw fatal; };

  assert.throws(() => admit(f.runtime, 'fatal-readback-race'), error => error === fatal);
  let drainError;
  try { await draining; } catch (error) { drainError = error; }
  const beforeLateReadback = f.store.journal(workspaceId).length;
  releaseReadback('subject');
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(drainError, fatal);
  assert.equal(f.effects(), 1);
  assert.equal(f.runtime.snapshot().faulted, true);
  const action = f.store.state(workspaceId).actions[f.action.id];
  assert.equal(action.status, 'accepted');
  assert.equal(action.verification, undefined);
  assert.equal(f.store.serviceJob(workspaceId, admitted.job.id).status, 'running');
  assert.equal(f.store.journal(workspaceId).length, beforeLateReadback);
  f.store.admitOwnerTurnJob = originalAdmit;
});

test('admitted inference is deadline-bounded without an operation loop', async t => {
  let release;
  let capturedSignal;
  const f = fixture([request => {
    capturedSignal = request.signal;
    return new Promise(resolve => { release = resolve; });
  }], { withoutLoop: true, runtime: { timeoutMs: 10 } });
  t.after(() => f.store.close());
  const admitted = admit(f.runtime, 'no-loop-deadline');
  const draining = f.runtime.drain();

  const settled = await Promise.race([draining.then(() => true),
    new Promise(resolve => setTimeout(() => resolve(false), 50))]);
  if (!settled) {
    release({ text: JSON.stringify(final('Released only for failed-test cleanup')) });
    await draining;
  }

  assert.equal(settled, true);
  assert.ok(capturedSignal instanceof AbortSignal);
  assert.equal(capturedSignal.aborted, true);
  assert.equal(f.store.serviceJob(workspaceId, admitted.job.id).result.reason, 'deadline');
});

test('trusted cancellation signal reaches the model transport and aborts on shutdown', async t => {
  let release;
  let capturedSignal;
  const f = fixture([request => {
    capturedSignal = request.signal;
    return new Promise(resolve => { release = resolve; });
  }]);
  t.after(() => f.store.close());
  admit(f.runtime, 'signal-shutdown');
  const draining = f.runtime.drain();
  await new Promise(resolve => setImmediate(resolve));

  const wasTrusted = capturedSignal instanceof AbortSignal;
  const wasActive = capturedSignal?.aborted === false;
  assert.equal(await f.runtime.shutdown(), true);
  await draining;
  release({ text: JSON.stringify(final()) });
  assert.equal(wasTrusted, true);
  assert.equal(wasActive, true);
  assert.equal(capturedSignal?.aborted, true);
});

test('elapsed admitted loop deadline persists deadline rather than cancellation', async t => {
  let capturedSignal;
  const f = fixture([request => {
    capturedSignal = request.signal;
    return new Promise(() => {});
  }], { runtime: { timeoutMs: 10 } });
  t.after(() => f.store.close());
  const admitted = admit(f.runtime, 'loop-deadline');

  await f.runtime.drain();

  assert.ok(capturedSignal instanceof AbortSignal);
  assert.equal(capturedSignal.aborted, true);
  const job = f.store.serviceJob(workspaceId, admitted.job.id);
  assert.equal(job.status, 'stopped');
  assert.equal(job.result.reason, 'deadline');
  assert.equal(f.store.inbox(workspaceId).length, 0);
});

test('restart resumes queued work once and interrupts running work without replay', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'behalvo-runtime-restart-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const state of ['queued', 'running']) await t.test(state, async () => {
    const path = join(directory, `${state}.db`);
    const firstStore = new SqliteStore(path, { serviceQueue: { upgradeExisting: false } });
    const first = fixture([], { store: firstStore });
    const admitted = admit(first.runtime, `restart-${state}`);
    if (state === 'running') firstStore.claimServiceJob(workspaceId, 'crashed-instance', at);
    firstStore.close();

    const reopened = new SqliteStore(path, { serviceQueue: { upgradeExisting: false } });
    const restarted = fixture([final('Restarted once')], { store: reopened, existing: true });
    try {
      restarted.runtime.start();
      await restarted.runtime.drain();
      const job = reopened.serviceJob(workspaceId, admitted.job.id);
      assert.equal(job.status, state === 'queued' ? 'finished' : 'interrupted');
      assert.equal(restarted.requests.length, state === 'queued' ? 1 : 0);
    } finally {
      await restarted.runtime.shutdown();
      reopened.close();
    }
  });
});
