import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chmod, mkdtemp, rm, cp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

function runMain(args, input, environment = {}, executable = 'dist/cli/main.js') {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, ...environment };
    if (!Object.hasOwn(environment, 'BEHALVO_MODEL_STATE_KEY_FILE'))
      delete env.BEHALVO_MODEL_STATE_KEY_FILE;
    if (!Object.hasOwn(environment, 'BEHALVO_STORAGE_KEY_FILE'))
      delete env.BEHALVO_STORAGE_KEY_FILE;
    const child = spawn(process.execPath, [executable, ...args], {
      cwd: process.cwd(), env, stdio: ['pipe', 'pipe', 'pipe']
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

test('CLI main boots from an empty database in offline mode and accepts scripted input', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'behalvo-main-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const result = await runMain(['--offline', '--db', join(dir, 'agent.db')], '/model\n/quit\n');
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Behalvo/);
  assert.match(result.stdout, /offline\/deterministic/);
  assert.doesNotMatch(result.stderr, /Error:/);
});

test('model-state key CLI option is strict online, explicit wins, and offline ignores only ambient configuration', async () => {
  const { parseCliArgs } = await import('../dist/cli/main.js');
  const before = process.env.BEHALVO_MODEL_STATE_KEY_FILE;
  process.env.BEHALVO_MODEL_STATE_KEY_FILE = 'environment-model-state.key';
  try {
    assert.equal(parseCliArgs([]).modelStateKeyPath, join(process.cwd(), 'environment-model-state.key'));
    assert.equal(parseCliArgs(['--model-state-key-file', 'flag-model-state.key']).modelStateKeyPath,
      join(process.cwd(), 'flag-model-state.key'));
    assert.equal(parseCliArgs(['--offline']).modelStateKeyPath, undefined);
    assert.throws(() => parseCliArgs(['--offline', '--model-state-key-file', 'key']), /private model state configuration/i);
    assert.throws(() => parseCliArgs(['--model-state-key-file']), /model-state-key-file/i);
    assert.throws(() => parseCliArgs(['--model-state-key-file', '']), /model-state-key-file/i);
    assert.throws(() => parseCliArgs(['--model-state-key-file=a']), /model-state-key-file/i);
    assert.throws(() => parseCliArgs([
      '--model-state-key-file', 'a', '--model-state-key-file', 'b'
    ]), /model-state-key-file/i);
    process.env.BEHALVO_MODEL_STATE_KEY_FILE = '';
    assert.throws(() => parseCliArgs([]), /private model state configuration/i);
    assert.equal(parseCliArgs(['--offline']).modelStateKeyPath, undefined);
  } finally {
    if (before === undefined) delete process.env.BEHALVO_MODEL_STATE_KEY_FILE;
    else process.env.BEHALVO_MODEL_STATE_KEY_FILE = before;
  }
});

test('storage key CLI option is strict, overrides the environment, and never silently starts plaintext', async t => {
  const { parseCliArgs } = await import('../dist/cli/main.js');
  const before = process.env.BEHALVO_STORAGE_KEY_FILE;
  process.env.BEHALVO_STORAGE_KEY_FILE = '/tmp/environment-key';
  try {
    assert.equal(parseCliArgs([]).storageKeyPath, '/tmp/environment-key');
    assert.equal(parseCliArgs(['--storage-key-file', '/tmp/flag-key']).storageKeyPath, '/tmp/flag-key');
    assert.throws(() => parseCliArgs(['--storage-key-file']), /storage-key-file/i);
    assert.throws(() => parseCliArgs(['--storage-key-file', '']), /storage-key-file/i);
    assert.throws(() => parseCliArgs(['--storage-key-file=a']), /storage-key-file/i);
    assert.throws(() => parseCliArgs(['--storage-key-file', 'a', '--storage-key-file', 'b']), /storage-key-file/i);
    process.env.BEHALVO_STORAGE_KEY_FILE = '';
    assert.throws(() => parseCliArgs([]), /storage.*key/i);
  } finally {
    if (before === undefined) delete process.env.BEHALVO_STORAGE_KEY_FILE;
    else process.env.BEHALVO_STORAGE_KEY_FILE = before;
  }

  const dir = await mkdtemp(join(tmpdir(), 'behalvo-main-private-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const missingKey = join(dir, 'missing.behalvo-key');
  const db = join(dir, 'agent.db');
  const result = await runMain(['--offline', '--db', db, '--storage-key-file', missingKey], '/quit\n');
  assert.notEqual(result.code, 0);
  assert.equal(existsSync(db), false);
  assert.equal(existsSync(`${db}-wal`), false);

  const { createStorageKeyFile, SqliteStore } = await import('../dist/index.js');
  const keyPath = join(dir, 'storage.behalvo-key');
  await createStorageKeyFile(keyPath);
  const first = await runMain(['--offline', '--db', db, '--storage-key-file', keyPath], '/quit\n');
  assert.equal(first.code, 0, first.stderr);
  const second = await runMain(['--offline', '--db', db, '--storage-key-file', keyPath], '/state\n/quit\n');
  assert.equal(second.code, 0, second.stderr);
  assert.match(second.stdout, /"workspaceId": "personal"/);
  assert.throws(() => new SqliteStore(db));

  const syntheticDb = join(dir, 'synthetic.db');
  const rejected = await runMain(['--offline', '--synthetic-operations', '--db', syntheticDb, '--storage-key-file', keyPath], '/quit\n');
  assert.notEqual(rejected.code, 0);
  assert.equal(existsSync(syntheticDb), false);
  assert.equal(existsSync(`${syntheticDb}.synthetic.sqlite`), false);
});

test('CLI starts from a checkout path containing spaces', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'behalvo spaced checkout '));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await cp('dist', join(dir, 'dist'), { recursive: true });
  await writeFile(join(dir, 'package.json'), '{"type":"module"}');
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(dir, 'dist/cli/main.js'), '--offline', '--db', join(dir, 'agent.db'), '--auth', join(dir, 'auth.json')], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
    child.stdin.end('/model\n/quit\n');
  });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /offline\/deterministic/);
});

test('offline CLI neither consumes nor overwrites saved real-model selection', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'behalvo-main-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const db = join(dir, 'agent.db');
  const settings = `${db}.settings.json`;
  const original = '{"version":1,"workspaces":{"personal":{"provider":"real","model":"saved"}}}\n';
  await writeFile(settings, original);
  const result = await runMain(['--offline', '--db', db], '/model\n/quit\n');
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /offline\/deterministic/);
  assert.equal(await readFile(settings, 'utf8'), original);
});

test('saved selection is restored and an explicit startup selection overrides and replaces it', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'behalvo-main-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const db = join(dir, 'agent.db');
  const settings = `${db}.settings.json`;
  await writeFile(settings, '{"version":1,"workspaces":{"personal":{"provider":"openai-codex","model":"gpt-5.6-luna"}}}\n');

  const restored = await runMain(['--db', db, '--auth', join(dir, 'unused-auth.json')], '/quit\n');
  assert.equal(restored.code, 0, restored.stderr);
  assert.match(restored.stdout, /Active model: openai-codex\/gpt-5\.6-luna/);

  const overridden = await runMain([
    '--db', db, '--auth', join(dir, 'unused-auth.json'), '--model', 'openai-codex/gpt-5.6-sol'
  ], '/quit\n');
  assert.equal(overridden.code, 0, overridden.stderr);
  assert.match(overridden.stdout, /Active model: openai-codex\/gpt-5\.6-sol/);
  assert.deepEqual(JSON.parse(await readFile(settings, 'utf8')).workspaces.personal,
    { provider: 'openai-codex', model: 'gpt-5.6-sol' });
});

test('unknown saved selection gives recovery guidance without echoing settings values', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'behalvo-main-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const db = join(dir, 'agent.db');
  await writeFile(`${db}.settings.json`,
    '{"version":1,"workspaces":{"personal":{"provider":"DO-NOT-ECHO","model":"SECRET-VALUE"}}}\n');
  const result = await runMain(['--db', db, '--auth', join(dir, 'unused-auth.json')], '/quit\n');
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /saved model selection.*--model|--model.*saved model selection/i);
  assert.doesNotMatch(result.stderr, /DO-NOT-ECHO|SECRET-VALUE/);
});

test('online protected startup validates both writer stores before creating SQLite state', async t => {
  if (process.platform === 'win32') return t.skip('protected model state requires POSIX');
  const root = await mkdtemp(join(tmpdir(), 'behalvo-main-model-state-fail-'));
  await chmod(root, 0o700);
  t.after(() => rm(root, { recursive: true, force: true }));
  const { createStorageKeyFile, loadStorageKeyFile } = await import('../dist/storage/key-file.js');
  const { PiCredentialFileStore } = await import('../dist/model/pi-auth-store.js');
  const { ModelSettingsStore } = await import('../dist/cli/model-settings.js');

  async function runCase(name, prepare, extraArgs = []) {
    const dir = join(root, name);
    await (await import('node:fs/promises')).mkdir(dir, { mode: 0o700 });
    const keyPath = join(dir, 'model-state.behalvo-key');
    const authPath = join(dir, 'auth.json');
    const dbPath = join(dir, 'agent.db');
    const settingsPath = `${dbPath}.settings.json`;
    await createStorageKeyFile(keyPath);
    const key = loadStorageKeyFile(keyPath);
    try {
      await prepare({ dir, keyPath, authPath, dbPath, settingsPath, key });
    } finally { key.fill(0); }
    const result = await runMain([
      '--db', dbPath, '--auth', authPath, '--model-state-key-file', keyPath, ...extraArgs
    ], '/quit\n');
    assert.notEqual(result.code, 0, `${name}: ${result.stderr}`);
    assert.match(result.stderr, /private model state|model state key|configuration/i, name);
    for (const path of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`, `${dbPath}-journal`, `${dbPath}.behalvo-lock`])
      assert.equal(existsSync(path), false, `${name}: ${path}`);
  }

  await runCase('missing-key', async ({ keyPath }) => rm(keyPath));
  await runCase('malformed-key', async ({ keyPath }) => writeFile(keyPath, 'malformed\n', { mode: 0o600 }));
  await runCase('corrupt-auth', async ({ authPath }) => writeFile(authPath, 'corrupt-ciphertext', { mode: 0o600 }));
  await runCase('corrupt-settings-explicit-model', async ({ settingsPath }) =>
    writeFile(settingsPath, 'corrupt-ciphertext', { mode: 0o600 }), ['--model', 'openai-codex/gpt-5.6-luna']);
  await runCase('wrong-key', async ({ dir, authPath, key }) => {
    const otherKeyPath = join(dir, 'other.behalvo-key');
    await createStorageKeyFile(otherKeyPath);
    const other = loadStorageKeyFile(otherKeyPath);
    try {
      await new PiCredentialFileStore(authPath, { encryptionKey: other })
        .modify('synthetic', async () => ({ type: 'api_key', key: 'synthetic-only' }));
    } finally {
      other.fill(0);
    }
  });
  await runCase('plaintext-auth', async ({ authPath }) =>
    writeFile(authPath, '{"synthetic":{"type":"api_key","key":"synthetic-only"}}\n', { mode: 0o600 }));
  await runCase('plaintext-settings', async ({ settingsPath }) =>
    writeFile(settingsPath, '{"version":1,"workspaces":{}}\n', { mode: 0o600 }));
  await runCase('readonly-auth', async ({ authPath, key }) => {
    await new PiCredentialFileStore(authPath, { encryptionKey: key })
      .modify('synthetic', async () => ({ type: 'api_key', key: 'synthetic-only' }));
    await chmod(authPath, 0o400);
  });
  await runCase('readonly-settings', async ({ settingsPath, key }) => {
    await new ModelSettingsStore(settingsPath, { encryptionKey: key })
      .write('personal', { provider: 'synthetic', model: 'test' });
    await chmod(settingsPath, 0o400);
  });
});

test('online protected startup rejects every database reservation before creating SQLite state', async t => {
  if (process.platform === 'win32') return t.skip('protected model state requires POSIX');
  const dir = await mkdtemp(join(tmpdir(), 'behalvo-main-model-state-collision-'));
  await chmod(dir, 0o700);
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { createStorageKeyFile } = await import('../dist/storage/key-file.js');
  const keyPath = join(dir, 'model-state.behalvo-key');
  await createStorageKeyFile(keyPath);
  for (let index = 0; index < 9; index += 1) {
    const db = join(dir, `agent-${index}.db`);
    const reserved = [
      db, `${db}-wal`, `${db}-shm`, `${db}-journal`, `${db}.behalvo-lock`,
      `${db}.synthetic.sqlite`, `${db}.synthetic.sqlite-wal`,
      `${db}.synthetic.sqlite-shm`, `${db}.synthetic.sqlite-journal`
    ];
    const result = await runMain([
      '--synthetic-operations', '--db', db, '--auth', reserved[index], '--model-state-key-file', keyPath
    ], '/quit\n');
    assert.notEqual(result.code, 0, result.stderr);
    assert.match(result.stderr, /invalid private model state configuration/i);
    for (const path of reserved) assert.equal(existsSync(path), false, path);
  }
});

test('offline startup ignores ambient model-state configuration and rejects the explicit flag before database creation', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'behalvo-main-model-state-offline-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const auth = join(dir, 'auth.json');
  const db = join(dir, 'offline.db');
  const missingKey = join(dir, 'missing.behalvo-key');
  const original = 'SYNTHETIC-AUTH-UNTOUCHED';
  await writeFile(auth, original);

  for (const value of [missingKey, '']) {
    const result = await runMain(['--offline', '--db', db, '--auth', auth], '/quit\n', {
      BEHALVO_MODEL_STATE_KEY_FILE: value
    });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(await readFile(auth, 'utf8'), original);
    assert.equal(existsSync(missingKey), false);
  }

  const explicitDb = join(dir, 'explicit.db');
  const rejected = await runMain([
    '--offline', '--db', explicitDb, '--auth', auth, '--model-state-key-file', missingKey
  ], '/quit\n');
  assert.notEqual(rejected.code, 0);
  assert.match(rejected.stderr, /private model state configuration/i);
  assert.equal(existsSync(explicitDb), false);
  assert.equal(existsSync(`${explicitDb}-wal`), false);
  assert.equal(await readFile(auth, 'utf8'), original);
});

test('protected startup and in-session model selection reuse one encrypted settings store', async t => {
  if (process.platform === 'win32') return t.skip('protected model state requires POSIX');
  const dir = await mkdtemp(join(tmpdir(), 'behalvo-main-model-state-green-'));
  await chmod(dir, 0o700);
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { createStorageKeyFile, loadStorageKeyFile } = await import('../dist/storage/key-file.js');
  const { ModelSettingsStore } = await import('../dist/cli/model-settings.js');
  const keyPath = join(dir, 'model-state.behalvo-key');
  const authPath = join(dir, 'auth.json');
  const db = join(dir, 'agent.db');
  const copiedDist = join(dir, 'dist');
  await cp('dist', copiedDist, { recursive: true });
  await writeFile(join(copiedDist, 'model', 'pi-gateway.js'), `
export function createPiRuntimeLoader() { return async () => ({}); }
export class PiModelGateway {
  async listModels() { return [{ provider: 'synthetic', model: 'test' }]; }
  async complete() { throw new Error('synthetic fixture must not infer'); }
  async login() { throw new Error('synthetic fixture must not login'); }
}
`);
  await createStorageKeyFile(keyPath);
  const result = await runMain([
    '--db', db, '--auth', authPath, '--model-state-key-file', keyPath
  ], '/model synthetic test\n/quit\n', {}, join(copiedDist, 'cli', 'main.js'));
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Model selected: synthetic\/test/);
  const key = loadStorageKeyFile(keyPath);
  try {
    assert.deepEqual(await new ModelSettingsStore(`${db}.settings.json`, { encryptionKey: key }).read('personal'), {
      provider: 'synthetic', model: 'test'
    });
  } finally { key.fill(0); }
  assert.equal(existsSync(authPath), false);
});
