import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FakeModelGateway, OperationRegistry, OperationService, recoverLocalService,
  SqliteStore, startLocalService
} from '../dist/index.js';
import { requestControl } from './owner-control-http-helpers.mjs';
import { validateLocalServiceOptions } from '../dist/service/config.js';

const ASSETS = { html: '<!doctype html><title>Service</title>', javascript: "'use strict';", css: 'body{}' };
const model = { provider: 'scripted', model: 'synthetic' };

function directory(t) {
  const value = mkdtempSync(join(tmpdir(), 'behalvo-service-lifecycle-'));
  chmodSync(value, 0o700);
  t.after(() => rmSync(value, { recursive: true, force: true }));
  return value;
}

function options(t, override = {}) {
  const dir = directory(t);
  const gateway = new FakeModelGateway([{ ...model }], () => ({
    text: JSON.stringify({ reply: 'Synthetic', workProposals: [], factProposals: [] })
  }));
  return { dir, value: {
    dbPath: join(dir, 'service.db'), bootstrapDirectory: join(dir, 'bootstrap'),
    workspaceId: 'service-lifecycle', ownerId: 'owner', assets: ASSETS,
    gateways: [gateway], model, syntheticOperations: true, upgradeStorage: false, port: 0,
    ...override
  } };
}

async function pair(service) {
  const bootstrap = JSON.parse(readFileSync(service.bootstrapPath, 'utf8'));
  const response = await requestControl(service.origin, 'POST', '/api/session/bootstrap', bootstrap.token, {});
  assert.equal(response.status, 200);
  return response.body.token;
}

test('one composition owns one store and lock, starts ready, shuts down, and restarts with sessions revoked', async t => {
  const setup = options(t);
  const first = await startLocalService(setup.value);
  const token = await pair(first);
  assert.equal((await requestControl(first.origin, 'GET', '/api/service', token)).status, 200);
  await assert.rejects(() => startLocalService(setup.value), /lock|already|service|unavailable/i);

  assert.equal(await first.shutdown(), true);
  assert.equal(existsSync(`${setup.value.dbPath}.behalvo-lock`), false);

  const restarted = await startLocalService({ ...setup.value, upgradeStorage: false });
  t.after(() => restarted.shutdown());
  assert.equal((await requestControl(restarted.origin, 'GET', '/api/service', token)).status, 401);
  assert.equal((await requestControl(restarted.origin, 'GET', '/api/service', await pair(restarted))).status, 200);
});

test('shutdown revokes HTTP authority before waiting for active inference to settle', async t => {
  let release;
  let started;
  const startedPromise = new Promise(resolve => { started = resolve; });
  const gateway = {
    async listModels() { return [{ ...model }]; },
    async complete() {
      started();
      return new Promise(resolve => { release = resolve; });
    }
  };
  const setup = options(t, { gateways: [gateway] });
  const service = await startLocalService(setup.value);
  const token = await pair(service);
  assert.equal((await requestControl(service.origin, 'POST', '/api/chat', token, {
    requestId: 'held-chat', threadId: 'thread', text: 'Hold synthetic inference'
  })).status, 202);
  await startedPromise;

  const stopping = service.shutdown();
  await assert.rejects(() => requestControl(service.origin, 'GET', '/api/service', token));
  release({ text: JSON.stringify({ reply: 'Late synthetic reply', workProposals: [], factProposals: [] }) });
  assert.equal(await stopping, true);
});

test('missing model configuration blocks chat only and keeps authenticated status and review available', async t => {
  const setup = options(t, { model: undefined });
  const service = await startLocalService(setup.value);
  t.after(() => service.shutdown());
  const token = await pair(service);
  const status = await requestControl(service.origin, 'GET', '/api/service', token);
  assert.equal(status.status, 200);
  assert.deepEqual(status.body.model, { configured: false, selection: null });
  const chat = await requestControl(service.origin, 'POST', '/api/chat', token, {
    requestId: 'no-model', threadId: 'thread', text: 'Synthetic'
  });
  assert.equal(chat.status, 503);
  assert.equal((await requestControl(service.origin, 'GET', '/api/actions', token)).status, 200);
});

test('persistent synthetic plus encrypted domain storage fails before creating either database', async t => {
  const setup = options(t, { encryptionKey: Buffer.alloc(32, 7) });
  await assert.rejects(() => startLocalService(setup.value), /encrypted|synthetic|configuration/i);
  assert.equal(existsSync(setup.value.dbPath), false);
  assert.equal(existsSync(`${setup.value.dbPath}.synthetic.sqlite`), false);
  assert.equal(existsSync(`${setup.value.dbPath}.behalvo-lock`), false);
});

test('service path separation rejects plaintext model state aliases before lock or database creation', t => {
  const setup = options(t);
  assert.throws(() => validateLocalServiceOptions({
    ...setup.value, authPath: setup.value.dbPath, settingsPath: `${setup.value.dbPath}.settings.json`
  }), /configuration|path|private/i);
  assert.equal(existsSync(setup.value.dbPath), false);
  assert.equal(existsSync(`${setup.value.dbPath}.behalvo-lock`), false);
});

test('configured model readiness is metadata-only and does not probe the provider catalog', async t => {
  let listCalls = 0;
  const gateway = {
    async listModels() { listCalls++; throw new Error('catalog must not be loaded at readiness'); },
    async complete() { throw new Error('not used'); }
  };
  const setup = options(t, { gateways: [gateway] });
  const service = await startLocalService(setup.value);
  t.after(() => service.shutdown());
  assert.equal(listCalls, 0);
});

test('exclusive recovery refuses ownership while the service composition is active in this process', async t => {
  const setup = options(t);
  const service = await startLocalService(setup.value);
  t.after(() => service.shutdown());
  assert.throws(() => recoverLocalService({
    dbPath: setup.value.dbPath, workspaceId: setup.value.workspaceId, exclusiveMaintenance: true
  }), /exclusive|running|ownership|unavailable/i);
});

test('exclusive recovery interrupts the job and records a running action unknown without retry', async t => {
  const dir = directory(t);
  const dbPath = join(dir, 'recover.db');
  const workspaceId = 'service-recovery';
  const ownerId = 'owner';
  const store = new SqliteStore(dbPath, { serviceQueue: { upgradeExisting: false } });
  store.bindLocalMode('ordinary');
  store.createWorkspace(workspaceId, ownerId);
  const registry = new OperationRegistry();
  let effects = 0;
  registry.register({
    id: 'contact.update', version: '1', provider: 'synthetic-accounts',
    catalog: { description: 'Synthetic', connectionKind: 'synthetic', resourceIds: ['resource'],
      argumentsSchema: { type: 'object' }, exampleArguments: {} },
    validateArguments(value) { return value; },
    async identify({ connection }) { return connection.subject; },
    async observe({ connection, resourceId }) { return { state: {}, providerVersion: 'v1', source: connection.provider,
      resourceId, observedAt: '2026-09-21T12:00:00.000Z' }; },
    prepare({ arguments: args, observation }) { return { arguments: args,
      affectedResourceIds: [observation.resourceId], expectedResult: args }; },
    comparePrecondition() { return true; },
    async execute() { effects++; return { status: 'accepted', evidence: 'must not run' }; },
    verify() { return { status: 'satisfied' }; }
  });
  const operations = new OperationService(store, registry, () => '2026-09-21T12:00:00.000Z', workspaceId);
  operations.registerConnection({ workspaceId, ownerId, connection: {
    id: 'account', provider: 'synthetic-accounts', subject: 'synthetic-person', label: 'Synthetic'
  } });
  const state = store.state(workspaceId);
  store.append(workspaceId, state.version, [{ type: 'work.created', data: {
    id: 'work', title: 'Synthetic', goal: 'Recover', threadId: 'thread'
  } }]);
  const action = await operations.prepare({ workspaceId, ownerId, workId: 'work', key: 'recover',
    connectionId: 'account', operationId: 'contact.update', operationVersion: '1', resourceId: 'resource', arguments: {} });
  operations.approveBatch({ workspaceId, ownerId, expiresAt: '2026-09-21T12:10:00.000Z',
    approvals: [{ actionId: action.id, digest: action.digest }] });
  const admitted = store.admitActionJob({ workspaceId, source: 'owner:service', requestId: 'execute-recover', ownerId,
    envelope: { kind: 'execute', actionId: action.id, digest: action.digest }, instanceId: 'crashed-service',
    at: '2026-09-21T12:00:00.000Z' });
  const claimed = store.claimServiceJob(workspaceId, 'crashed-service', '2026-09-21T12:00:01.000Z');
  assert.equal(claimed.id, admitted.job.id);
  store.startActionAttempt(workspaceId, store.state(workspaceId).version, action.id, 'attempt-crashed', {}, undefined,
    claimed.claim);
  store.close();

  const beforeRecovery = await startLocalService({
    dbPath, bootstrapDirectory: join(dir, 'bootstrap-before-recovery'), workspaceId, ownerId,
    assets: ASSETS, syntheticOperations: false, upgradeStorage: false, port: 0
  });
  const beforeStatus = await requestControl(beforeRecovery.origin, 'GET', '/api/service', await pair(beforeRecovery));
  assert.deepEqual(beforeStatus.body.unresolvedActions, [{
    actionId: action.id, status: 'running', kind: 'crash_preserved_execution'
  }]);
  assert.equal(await beforeRecovery.shutdown(), true);

  const result = recoverLocalService({ dbPath, workspaceId, exclusiveMaintenance: true });
  assert.deepEqual(result, { jobsInterrupted: 0, jobsRepaired: 0, actionsUnknown: 1 });
  assert.equal(effects, 0);
  const afterRecovery = await startLocalService({
    dbPath, bootstrapDirectory: join(dir, 'bootstrap-after-recovery'), workspaceId, ownerId,
    assets: ASSETS, syntheticOperations: false, upgradeStorage: false, port: 0
  });
  const afterStatus = await requestControl(afterRecovery.origin, 'GET', '/api/service', await pair(afterRecovery));
  assert.deepEqual(afterStatus.body.unresolvedActions, [{
    actionId: action.id, status: 'unknown', kind: 'unknown_outcome'
  }]);
  assert.equal(await afterRecovery.shutdown(), true);
  const check = new SqliteStore(dbPath, { serviceQueue: { upgradeExisting: false } });
  assert.equal(check.serviceJob(workspaceId, admitted.job.id).status, 'interrupted');
  assert.equal(check.state(workspaceId).actions[action.id].status, 'unknown');
  check.close();
});
