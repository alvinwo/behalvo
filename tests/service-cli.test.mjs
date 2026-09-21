import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { parseServiceArgs, runServiceCli } from '../dist/cli/service-main.js';

test('service CLI parses explicit foreground run and exclusive recovery without network defaults', () => {
  const cwd = '/tmp/behalvo-service-cli';
  assert.deepEqual(parseServiceArgs([
    'run', '--db', 'service.db', '--bootstrap-dir', 'bootstrap', '--workspace', 'personal',
    '--owner', 'owner', '--port', '4312', '--synthetic-operations', '--offline', '--upgrade-storage'
  ], cwd), {
    kind: 'run', dbPath: join(cwd, 'service.db'), bootstrapDirectory: join(cwd, 'bootstrap'),
    workspaceId: 'personal', ownerId: 'owner', port: 4312, syntheticOperations: true,
    offline: true, upgradeStorage: true
  });
  assert.deepEqual(parseServiceArgs([
    'recover', '--db', 'service.db', '--workspace', 'personal', '--exclusive-maintenance'
  ], cwd), {
    kind: 'recover', dbPath: join(cwd, 'service.db'), workspaceId: 'personal',
    exclusiveMaintenance: true
  });
  assert.deepEqual(parseServiceArgs([
    'recover', '--db', 'service.db', '--workspace', 'personal', '--exclusive-maintenance',
    '--storage-key-file', 'private/storage.key'
  ], cwd), {
    kind: 'recover', dbPath: join(cwd, 'service.db'), workspaceId: 'personal',
    exclusiveMaintenance: true, storageKeyPath: join(cwd, 'private/storage.key')
  });
  assert.throws(() => parseServiceArgs(['recover', '--db', 'service.db'], cwd));
  assert.throws(() => parseServiceArgs(['run', '--db', 'service.db', '--bootstrap-dir', 'bootstrap', '--login'], cwd));
  assert.throws(() => parseServiceArgs(['run', '--db', 'service.db', '--bootstrap-dir', 'bootstrap', '--browser'], cwd));

  assert.deepEqual(parseServiceArgs([
    'run', '--db', 'service.db', '--bootstrap-dir', 'bootstrap',
    '--model', 'openai-codex/synthetic-model', '--auth', 'private/auth.json',
    '--storage-key-file', 'private/storage.key', '--model-state-key-file', 'private/model.key'
  ], cwd), {
    kind: 'run', dbPath: join(cwd, 'service.db'), bootstrapDirectory: join(cwd, 'bootstrap'),
    workspaceId: 'personal', ownerId: 'owner', port: 0, syntheticOperations: false,
    offline: false, upgradeStorage: false,
    model: { provider: 'openai-codex', model: 'synthetic-model' },
    authPath: join(cwd, 'private/auth.json'), storageKeyPath: join(cwd, 'private/storage.key'),
    modelStateKeyPath: join(cwd, 'private/model.key')
  });
});

test('service run stays foreground until the stop signal and performs one owned shutdown', async () => {
  const controller = new AbortController();
  const events = [];
  const output = { stdout: '', stderr: '' };
  const run = runServiceCli([
    'run', '--db', 'service.db', '--bootstrap-dir', 'bootstrap', '--offline'
  ], {
    cwd: '/tmp/behalvo-service-cli', signal: controller.signal,
    writeStdout(text) { output.stdout += text; }, writeStderr(text) { output.stderr += text; },
    async start(options) {
      events.push(['start', options]);
      return { origin: 'http://127.0.0.1:4312', bootstrapPath: '/tmp/bootstrap/file',
        async shutdown() { events.push(['shutdown']); return true; } };
    }
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(events.length, 1);
  controller.abort();
  assert.equal(await run, 0);
  assert.deepEqual(events.map(entry => entry[0]), ['start', 'shutdown']);
  assert.match(output.stdout, /127\.0\.0\.1:4312/);
  assert.equal(output.stderr, '');
});

test('service recovery invokes only the exclusive maintenance path and returns a fixed summary', async () => {
  const calls = [];
  let stdout = '';
  const code = await runServiceCli([
    'recover', '--db', 'service.db', '--workspace', 'personal', '--exclusive-maintenance'
  ], {
    cwd: '/tmp/behalvo-service-cli', writeStdout(text) { stdout += text; }, writeStderr() {},
    async recover(options) { calls.push(options); return { jobsInterrupted: 2, actionsUnknown: 1 }; }
  });
  assert.equal(code, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].exclusiveMaintenance, true);
  assert.match(stdout, /2 service jobs.*1 running action/i);
});
