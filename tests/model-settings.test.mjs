import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ModelSettingsStore, settingsPathForDatabase } from '../dist/cli/model-settings.js';

test('model settings persist provider and model per workspace without credentials', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'behalvo-settings-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'agent.db.settings.json');
  const settings = new ModelSettingsStore(path);

  await settings.write('personal', { provider: 'openai-codex', model: 'gpt-5.6-sol' });
  await settings.write('business', { provider: 'synthetic', model: 'planner' });

  assert.deepEqual(await new ModelSettingsStore(path).read('personal'), {
    provider: 'openai-codex', model: 'gpt-5.6-sol'
  });
  assert.deepEqual(await new ModelSettingsStore(path).read('business'), {
    provider: 'synthetic', model: 'planner'
  });
  const serialized = await readFile(path, 'utf8');
  assert.doesNotMatch(serialized, /credential|access|refresh|api.?key|token|secret/i);
  if (process.platform !== 'win32') assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal(settingsPathForDatabase(join(dir, 'agent.db')), path);
});

test('malformed settings fail closed with recovery guidance and do not echo content', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'behalvo-settings-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'agent.db.settings.json');
  await writeFile(path, '{"accessToken":"DO-NOT-ECHO"}');

  await assert.rejects(
    () => new ModelSettingsStore(path).read('personal'),
    error => /settings.*malformed.*remove|remove.*settings/i.test(error.message) && !error.message.includes('DO-NOT-ECHO')
  );
});

test('workspace names matching object prototype properties persist independently', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'behalvo-settings-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const settings = new ModelSettingsStore(join(dir, 'settings.json'));
  assert.equal(await settings.read('toString'), undefined);
  await settings.write('toString', { provider: 'synthetic', model: 'one' });
  assert.deepEqual(await settings.read('toString'), { provider: 'synthetic', model: 'one' });
});

test('concurrent processes preserve every successful workspace selection', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'behalvo-settings-processes-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'settings.json');
  const moduleUrl = new URL('../dist/cli/model-settings.js', import.meta.url).href;
  const children = Array.from({ length: 16 }, (_, index) => new Promise((resolve, reject) => {
    const script = `import { ModelSettingsStore } from ${JSON.stringify(moduleUrl)}; await new ModelSettingsStore(process.argv[1]).write(process.argv[2], { provider: 'fake', model: process.argv[2] });`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, path, `workspace-${index}`], {
      stdio: ['ignore', 'ignore', 'pipe']
    });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve() : reject(new Error(stderr || `child exited ${code}`)));
  }));
  await Promise.all(children);

  const settings = new ModelSettingsStore(path);
  for (let index = 0; index < children.length; index += 1)
    assert.deepEqual(await settings.read(`workspace-${index}`), { provider: 'fake', model: `workspace-${index}` });
});

test('failed update releases its lock so a corrected file can be updated', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'behalvo-settings-cleanup-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'settings.json');
  const store = new ModelSettingsStore(path);
  await writeFile(path, '{"malformed":"DO-NOT-ECHO"}');
  await assert.rejects(() => store.write('personal', { provider: 'fake', model: 'one' }), /malformed/i);
  await assert.rejects(() => access(`${path}.lock`), error => error.code === 'ENOENT');
  await writeFile(path, '{"version":1,"workspaces":{}}\n');
  await store.write('personal', { provider: 'fake', model: 'one' });
  assert.deepEqual(await store.read('personal'), { provider: 'fake', model: 'one' });
});
