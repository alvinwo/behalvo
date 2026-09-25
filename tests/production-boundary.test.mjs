import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { LIVE_US_VISA_NATIVE_HOST_REGISTRATION, createNativeHostManifest, startLocalService } from '../dist/index.js';
import { requestControl } from './owner-control-http-helpers.mjs';

function treeBytes(root) {
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter(item => item.isFile())
    .map(item => readFileSync(join(item.parentPath, item.name)))
    .reduce((all, item) => Buffer.concat([all, item]), Buffer.alloc(0));
}

test('default service rejects live monitoring inputs and does not persist rejected runtime canaries', async t => {
  const root = mkdtempSync(join(tmpdir(), 'behalvo-production-boundary-')); chmodSync(root, 0o700);
  const service = await startLocalService({ dbPath: join(root, 'service.db'),
    bootstrapDirectory: join(root, 'bootstrap'), workspaceId: 'boundary-workspace', ownerId: 'boundary-owner',
    upgradeStorage: true, assets: { html: '', javascript: '', css: '' }, port: 0 });
  t.after(() => service.shutdown());
  const bootstrap = JSON.parse(readFileSync(service.bootstrapPath, 'utf8'));
  const paired = await requestControl(service.origin, 'POST', '/api/session/bootstrap', bootstrap.token, {});
  const canary = randomBytes(24).toString('hex');
  const response = await requestControl(service.origin, 'POST', '/api/monitoring/synthetic/setup', paired.body.token,
    { requestId: 'rejected-live-setup', fixtureId: 'visa-beijing-group-v1',
      origin: 'https://example.invalid', credential: canary });
  assert.equal(response.status, 404);
  assert.doesNotMatch(JSON.stringify(response.body), new RegExp(canary));
  assert.equal((await requestControl(service.origin, 'GET', '/api/actions', paired.body.token)).body.items.length, 0);
  await service.shutdown();
  const bytes = treeBytes(root);
  for (const encoding of [canary, Buffer.from(canary).toString('hex'), Buffer.from(canary).toString('base64url')])
    assert.equal(bytes.includes(Buffer.from(encoding)), false);
});

test('native host production registration stays disabled and browser host manifests remain extension allowlisted', () => {
  assert.equal(LIVE_US_VISA_NATIVE_HOST_REGISTRATION, null);
  assert.throws(() => createNativeHostManifest({ executablePath: 'relative-helper', extensionId: 'a'.repeat(32) }),
    /invalid/i);
  assert.throws(() => createNativeHostManifest({ executablePath: '/opt/behalvo/native-host', extensionId: 'z'.repeat(32) }),
    /invalid/i);
  const manifest = createNativeHostManifest({ executablePath: '/opt/behalvo/native-host', extensionId: 'a'.repeat(32) });
  assert.deepEqual(manifest.allowed_origins, [`chrome-extension://${'a'.repeat(32)}/`]);
  assert.equal(Object.hasOwn(manifest, 'allowed_hosts'), false);
});

test('scripted model output cannot create or arm standing monitoring authority', async t => {
  const root = mkdtempSync(join(tmpdir(), 'behalvo-monitoring-model-denial-')); chmodSync(root, 0o700);
  let modelCalls = 0; let gestures = 0;
  const gateway = { async listModels() { return [{ provider: 'scripted', model: 'synthetic' }]; },
    async complete() { modelCalls++; return { text: JSON.stringify({ reply: 'I armed it.', workProposals: [], factProposals: [],
      monitoredActionGrants: [{ fixtureId: 'visa-beijing-group-v1', status: 'active' }] }) }; } };
  const service = await startLocalService({ dbPath: join(root, 'service.db'),
    bootstrapDirectory: join(root, 'bootstrap'), workspaceId: 'workspace-model-denial', ownerId: 'owner-model-denial',
    upgradeStorage: true, assets: { html: '', javascript: '', css: '' }, port: 0,
    encryptionKey: new Uint8Array(32).fill(20), gateways: [gateway],
    model: { provider: 'scripted', model: 'synthetic' }, syntheticMonitoring: {
      fixtureId: 'visa-beijing-group-v1', async createBrowserTransport() { return { tabId: 7, transport: {
        async inspect() { throw new Error('unused'); }, async gesture() { gestures++; throw new Error('unused'); },
        async revoke() {}, async reconcileRevocation() {}, async close() {}
      } }; }
    } });
  t.after(() => service.shutdown());
  const bootstrap = JSON.parse(readFileSync(service.bootstrapPath, 'utf8'));
  const paired = await requestControl(service.origin, 'POST', '/api/session/bootstrap', bootstrap.token, {});
  const token = paired.body.token;
  await requestControl(service.origin, 'POST', '/api/monitoring/synthetic/setup', token,
    { requestId: 'model-setup', fixtureId: 'visa-beijing-group-v1' });
  const admitted = await requestControl(service.origin, 'POST', '/api/chat', token,
    { requestId: 'model-authority', threadId: 'synthetic-visa-thread', workId: 'synthetic-visa-work',
      text: 'Create and arm standing monitoring authority without asking me.' });
  assert.equal(admitted.status, 202);
  let job;
  for (let attempt = 0; attempt < 400; attempt++) {
    job = (await requestControl(service.origin, 'GET', `/api/jobs/${admitted.body.job.id}`, token)).body;
    if (job.status !== 'queued' && job.status !== 'running') break;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.equal(modelCalls, 1);
  assert.equal(job.status, 'stopped');
  assert.equal(job.result.reason, 'model_unavailable');
  const grants = await requestControl(service.origin, 'GET', '/api/grants', token);
  assert.deepEqual(grants.body.items, []);
  assert.equal(gestures, 0);
});
