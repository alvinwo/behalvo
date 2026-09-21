import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AgentService, FakeModelGateway, OperationRegistry, OperationService, Operator,
  OwnerControlService, OwnerControlSessions, ServiceControlService, ServiceRuntime, SqliteStore
} from '../dist/index.js';
import { startOwnerControlServer } from '../dist/control/http-server.js';
import { loadOwnerControlAssets } from '../dist/control/assets.js';
import { requestControl } from './owner-control-http-helpers.mjs';

const ASSETS = { html: '<!doctype html><title>Service</title>', javascript: "'use strict';", css: 'body{}' };
const workspaceId = 'service-http';
const ownerId = 'owner';
const at = '2026-09-21T12:00:00.000Z';
const model = { provider: 'scripted', model: 'synthetic' };

async function start(t, withAdapter = true, options = {}) {
  const directory = options.directory ?? mkdtempSync(join(tmpdir(), 'behalvo-service-http-'));
  if (!options.directory) chmodSync(directory, 0o700);
  const store = new SqliteStore(options.path ?? ':memory:', { serviceQueue: { upgradeExisting: options.upgradeExisting ?? false } });
  if (!options.existing) store.createWorkspace(workspaceId, ownerId);
  const sessions = new OwnerControlSessions({ workspaceId, ownerId });
  const operator = new Operator(store, () => at);
  const registry = new OperationRegistry();
  const operations = new OperationService(store, registry, () => at, workspaceId);
  const gateway = new FakeModelGateway([{ ...model }], () => ({
    text: JSON.stringify({ reply: 'Synthetic', workProposals: [], factProposals: [] })
  }));
  const agent = new AgentService(store, gateway, () => at, { service: operations, registry, workspaceId });
  const runtime = new ServiceRuntime(store, agent, operations, {
    workspaceId, ownerId, instanceId: sessions.instanceId, serviceGeneration: 'generation', clock: () => at
  });
  const reviews = new OwnerControlService({ store, operator, operations, sessions,
    binding: { workspaceId, ownerId } });
  const serviceControl = withAdapter ? new ServiceControlService({
    store, runtime, reviews, sessions, operator, binding: { workspaceId, ownerId },
    model, databaseMode: 'plaintext'
  }) : undefined;
  const app = {
    sessions, service: reviews, ...(serviceControl ? { serviceControl } : {}),
    close() { serviceControl?.close(); reviews.close(); store.close(); }
  };
  const server = await startOwnerControlServer({ app, bootstrapDirectory: join(directory, 'bootstrap'), assets: ASSETS });
  let closed = false;
  const shutdown = async () => {
    if (closed) return;
    closed = true;
    await server.close();
    app.close();
    if (!options.directory) rmSync(directory, { recursive: true, force: true });
  };
  if (options.autoClose !== false) t.after(shutdown);
  const bootstrap = JSON.parse(readFileSync(server.bootstrapPath, 'utf8'));
  const paired = await requestControl(server.origin, 'POST', '/api/session/bootstrap', bootstrap.token, {});
  return { server, store, runtime, operator, token: paired.body.token, shutdown };
}

test('service routes authenticate before lookup and never accept owner, workspace, or source', async t => {
  const f = await start(t);
  let lookups = 0;
  const original = f.store.findServiceReceipt.bind(f.store);
  f.store.findServiceReceipt = (...args) => { lookups++; return original(...args); };
  const anonymous = await requestControl(f.server.origin, 'POST', '/api/chat', undefined, {
    requestId: 'same', threadId: 'thread', text: 'Synthetic'
  });
  assert.equal(anonymous.status, 401);
  assert.equal(lookups, 0);

  for (const field of ['ownerId', 'workspaceId', 'source']) {
    const response = await requestControl(f.server.origin, 'POST', '/api/chat', f.token, {
      requestId: `extra-${field}`, threadId: 'thread', text: 'Synthetic', [field]: 'attacker'
    });
    assert.equal(response.status, 400, field);
  }
  assert.equal(f.store.serviceQueueCounts(workspaceId).queued, 0);
});

test('reminder reads authenticate before bounded workspace projection lookup', async t => {
  const f = await start(t);
  f.operator.createWork(workspaceId, ownerId, {
    id: 'work', title: 'Refund follow-up', goal: 'Private goal must not be projected', threadId: 'thread'
  });
  let lookups = 0;
  const original = f.store.serviceReminderRequests.bind(f.store);
  f.store.serviceReminderRequests = (...args) => { lookups++; return original(...args); };
  const anonymous = await requestControl(f.server.origin, 'GET', '/api/reminders');
  assert.equal(anonymous.status, 401);
  assert.equal(lookups, 0);

  const dueAt = new Date(Date.now() + 60_000).toISOString();
  const admitted = await requestControl(f.server.origin, 'POST', '/api/reminders', f.token, {
    requestId: 'owner-reminder', workId: 'work', dueAt
  });
  assert.equal(admitted.status, 202);
  const projected = await requestControl(f.server.origin, 'GET', '/api/reminders', f.token);
  assert.equal(projected.status, 200);
  assert.deepEqual(projected.body.items.map(item => ({
    requestId: item.requestId, timerId: item.timerId, work: item.work, dueAt: item.dueAt, status: item.status
  })), [{ requestId: 'owner-reminder', timerId: admitted.body.receipt.timerId,
    work: { id: 'work', title: 'Refund follow-up' }, dueAt, status: 'scheduled' }]);
  assert.equal(JSON.stringify(projected.body).includes('Private goal'), false);
  assert.equal(lookups, 1);
  assert.equal((await requestControl(f.server.origin, 'GET', '/api/reminders?workspaceId=other', f.token)).status, 400);
});

test('real loopback reminder projection preserves fired and cancelled meaning after store restart', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'behalvo-service-reminder-restart-'));
  chmodSync(directory, 0o700);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'service.db');
  const first = await start(t, true, { directory, path, autoClose: false });
  first.operator.createWork(workspaceId, ownerId, {
    id: 'refund', title: 'Check refund', goal: 'Private fired goal', threadId: 'refund-thread'
  });
  first.operator.createWork(workspaceId, ownerId, {
    id: 'stale', title: 'Stale follow-up', goal: 'Private cancelled goal', threadId: 'stale-thread'
  });
  const firedDueAt = new Date(Date.now() + 60_000).toISOString();
  const cancelledDueAt = new Date(Date.now() + 120_000).toISOString();
  const fired = await requestControl(first.server.origin, 'POST', '/api/reminders', first.token, {
    requestId: 'owner-fired', workId: 'refund', dueAt: firedDueAt
  });
  const cancelled = await requestControl(first.server.origin, 'POST', '/api/reminders', first.token, {
    requestId: 'owner-cancelled', workId: 'stale', dueAt: cancelledDueAt
  });
  assert.equal(first.store.admitDueTimerJob(workspaceId, fired.body.receipt.timerId, 'timer-worker', firedDueAt).kind, 'queued');
  first.operator.setWorkPhase(workspaceId, ownerId, 'stale', 'cancelled');
  assert.equal(first.store.admitDueTimerJob(workspaceId, cancelled.body.receipt.timerId, 'timer-worker', cancelledDueAt).kind,
    'cancelled');
  await first.runtime.drain();
  const before = await requestControl(first.server.origin, 'GET', '/api/reminders', first.token);
  assert.deepEqual(before.body.items.map(item => [item.requestId, item.work.title, item.status]), [
    ['owner-fired', 'Check refund', 'fired'], ['owner-cancelled', 'Stale follow-up', 'cancelled']
  ]);
  const reminderJob = first.store.serviceJobs(workspaceId).items.find(job => job.kind === 'reminder');
  const detail = await requestControl(first.server.origin, 'GET', `/api/jobs/${reminderJob.id}`, first.token);
  assert.equal(detail.body.result.reminder.requestId, 'owner-fired');
  assert.equal(detail.body.result.reminder.timerId, fired.body.receipt.timerId);
  await first.shutdown();

  const restarted = await start(t, true, { directory, path, existing: true, autoClose: false });
  t.after(restarted.shutdown);
  const after = await requestControl(restarted.server.origin, 'GET', '/api/reminders', restarted.token);
  assert.deepEqual(after.body, before.body);
  assert.equal(JSON.stringify(after.body).includes('Private'), false);
});

test('pre-service Operator timers survive upgrade, firing, cancellation, job reads and restart without faulting', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'behalvo-legacy-reminders-'));
  chmodSync(directory, 0o700);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'legacy.db');
  const legacy = new SqliteStore(path);
  legacy.createWorkspace(workspaceId, ownerId);
  const operator = new Operator(legacy, () => at);
  for (const id of ['fired', 'cancelled', 'scheduled']) {
    operator.createWork(workspaceId, ownerId, { id, title: `Legacy ${id}`, goal: 'Private legacy goal', threadId: id });
    operator.schedule(workspaceId, ownerId, { id: `timer-${id}`, workId: id, dueAt: at });
  }
  operator.setWorkPhase(workspaceId, ownerId, 'cancelled', 'cancelled');
  legacy.close();
  const first = await start(t, true, { directory, path, existing: true, upgradeExisting: true });
  assert.equal(first.store.admitDueTimerJob(workspaceId, 'timer-fired', 'worker', at).kind, 'queued');
  assert.equal(first.store.admitDueTimerJob(workspaceId, 'timer-cancelled', 'worker', at).kind, 'cancelled');
  await first.runtime.drain();
  const job = first.store.serviceJobs(workspaceId).items[0];
  const detail = await requestControl(first.server.origin, 'GET', `/api/jobs/${job.id}`, first.token);
  assert.equal(detail.status, 200);
  assert.deepEqual(detail.body.result.reminder, { timerId: 'timer-fired', requestId: null, admittedAt: null,
    work: { id: 'fired', title: 'Legacy fired' }, dueAt: at, status: 'fired' });
  const before = await requestControl(first.server.origin, 'GET', '/api/reminders', first.token);
  assert.deepEqual(before.body.items.map(item => [item.timerId, item.requestId, item.admittedAt, item.status]), [
    ['timer-fired', null, null, 'fired'], ['timer-cancelled', null, null, 'cancelled'],
    ['timer-scheduled', null, null, 'scheduled']
  ]);
  assert.equal(JSON.stringify(before.body).includes('Private legacy goal'), false);
  assert.equal(first.runtime.snapshot().faulted, false);
  assert.equal(first.runtime.snapshot().accepting, true);
  await first.shutdown();
  const restarted = await start(t, true, { directory, path, existing: true });
  assert.deepEqual((await requestControl(restarted.server.origin, 'GET', '/api/reminders', restarted.token)).body, before.body);
  assert.deepEqual((await requestControl(restarted.server.origin, 'GET', `/api/jobs/${job.id}`, restarted.token)).body, detail.body);
  const chat = await requestControl(restarted.server.origin, 'POST', '/api/chat', restarted.token,
    { requestId: 'after-legacy-read', threadId: 'thread', text: 'Synthetic next work' });
  assert.equal(chat.status, 202);
  await restarted.runtime.drain();
  assert.equal(restarted.store.serviceJob(workspaceId, chat.body.job.id).status, 'finished');
  assert.equal(restarted.runtime.snapshot().faulted, false);
});

test('service HTTP admits bounded work with 202 and exposes no-store status and durable job reads', async t => {
  const f = await start(t);
  const admitted = await requestControl(f.server.origin, 'POST', '/api/chat', f.token, {
    requestId: 'chat-1', threadId: 'thread', text: 'Synthetic chat'
  });
  assert.equal(admitted.status, 202);
  assert.equal(admitted.headers['cache-control'], 'no-store');
  assert.equal(admitted.body.duplicate, false);
  assert.equal(f.store.serviceJob(workspaceId, admitted.body.job.id).status, 'queued');
  await f.runtime.drain();

  const status = await requestControl(f.server.origin, 'GET', '/api/service', f.token);
  assert.equal(status.status, 200);
  assert.equal(status.body.model.configured, true);
  assert.equal(status.body.lifecycle, 'running');
  assert.deepEqual(status.body.limits, { foreground: true, awakeOnly: true, supervised: false });
  const jobs = await requestControl(f.server.origin, 'GET', '/api/jobs', f.token);
  assert.equal(jobs.status, 200);
  assert.equal(jobs.body.items.length, 1);
  const job = await requestControl(f.server.origin, 'GET', `/api/jobs/${admitted.body.job.id}`, f.token);
  assert.equal(job.status, 200);
  assert.equal(job.body.id, admitted.body.job.id);
  assert.equal(job.body.requestId, 'chat-1');
  assert.equal(job.body.result.conversation.ownerText, 'Synthetic chat');
  assert.equal(job.body.result.conversation.assistantText, 'Synthetic');
  assert.equal(Object.hasOwn(job.body, 'parameters'), false);
});

test('legacy owner control keeps its exact route allowlist when no service adapter is installed', async t => {
  const f = await start(t, false);
  for (const [method, path, body] of [
    ['GET', '/api/service', undefined],
    ['GET', '/api/jobs', undefined],
    ['GET', '/api/reminders', undefined],
    ['POST', '/api/chat', { requestId: 'x', threadId: 'thread', text: 'Synthetic' }],
    ['POST', '/api/reminders', { requestId: 'x', workId: 'work', dueAt: at }],
    ['POST', '/api/actions/action/execute', { requestId: 'x', digest: '0'.repeat(64), confirmationToken: 'x'.repeat(43) }],
    ['POST', '/api/actions/action/readback', { requestId: 'x', digest: '0'.repeat(64) }]
  ]) {
    const response = await requestControl(f.server.origin, method, path, f.token, body);
    assert.equal(response.status, 404, `${method} ${path}`);
  }
});

test('queue saturation rejects fresh work but keeps durable duplicate lookup available', async t => {
  const f = await start(t);
  let first;
  for (let index = 0; index < 64; index++) {
    const response = await requestControl(f.server.origin, 'POST', '/api/chat', f.token, {
      requestId: `queued-${index}`, threadId: 'thread', text: `Synthetic ${index}`
    });
    assert.equal(response.status, 202);
    if (index === 0) first = response.body;
  }
  const full = await requestControl(f.server.origin, 'POST', '/api/chat', f.token, {
    requestId: 'queued-64', threadId: 'thread', text: 'Fresh overflow'
  });
  assert.equal(full.status, 429);
  assert.deepEqual(full.body, { error: 'rate_limited' });
  const replay = await requestControl(f.server.origin, 'POST', '/api/chat', f.token, {
    requestId: 'queued-0', threadId: 'thread', text: 'Synthetic 0'
  });
  assert.equal(replay.status, 202);
  assert.equal(replay.body.duplicate, true);
  assert.equal(replay.body.receipt.id, first.receipt.id);
});

test('service mutations retain the common body bound and fixed safe error surface', async t => {
  const f = await start(t);
  const oversized = await requestControl(f.server.origin, 'POST', '/api/chat', f.token, {
    requestId: 'large', threadId: 'thread', text: 'x'.repeat(5000)
  });
  assert.equal(oversized.status, 413);
  assert.deepEqual(oversized.body, { error: 'invalid_request' });
  assert.equal(JSON.stringify(oversized).includes('x'.repeat(100)), false);
});

test('packaged service UI exposes responsive chat, focus, queue, reminder, review, execution, and lifecycle surfaces only', () => {
  const assets = loadOwnerControlAssets();
  for (const id of [
    'service-dashboard', 'service-refresh', 'service-lifecycle', 'service-limits', 'service-barriers',
    'chat-thread', 'chat-work', 'chat-text', 'send-chat', 'jobs', 'refresh-jobs', 'reminders',
    'reminder-work', 'reminder-due', 'create-reminder', 'execute', 'readback'
  ]) assert.match(assets.html, new RegExp(`id=["']${id}["']`), id);
  for (const endpoint of ['/api/service', '/api/jobs', '/api/chat', '/api/reminders', '/execute', '/readback'])
    assert.match(assets.javascript, new RegExp(endpoint.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), endpoint);
  assert.match(assets.css, /@media\s*\(max-width:/);
  assert.match(assets.css, /grid-template-columns/);
  assert.doesNotMatch(assets.javascript, /\/api\/(?:login|credentials?|browser)(?:\/|['"`])/i);
  assert.doesNotMatch(assets.html, /type=["']password["']/i);
});
