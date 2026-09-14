import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, cp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

function runMain(args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['dist/cli/main.js', ...args], { cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'] });
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
