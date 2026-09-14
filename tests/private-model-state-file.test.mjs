import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync
} from 'node:fs';
import { mkdtemp, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModelStateCodec } from '../dist/storage/model-state-codec.js';
import { readPrivateFileSnapshot } from '../dist/storage/private-files.js';
import { PrivateModelStateFile, resolveModelStatePath } from '../dist/storage/private-model-state-file.js';

const POSIX = process.platform !== 'win32' && typeof process.geteuid === 'function';

const schema = {
  empty: () => ({ count: 0 }),
  validate(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        Object.keys(value).length !== 1 || !Number.isSafeInteger(value.count))
      throw new Error('synthetic-schema-secret');
  }
};

function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

async function fixture(t, name = 'state.json') {
  const root = await mkdtemp(join(tmpdir(), 'behalvo-private-file-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'nested');
  mkdirSync(directory, { mode: 0o700 });
  const path = join(directory, name);
  return { root, directory, path, lockPath: `${path}.behalvo-model-state-lock`, key: Buffer.alloc(32, 8) };
}

async function seeded(t) {
  const f = await fixture(t);
  const file = new PrivateModelStateFile(f.path, 'model-settings', f.key, schema);
  await file.update(async () => ({ next: { count: 0 }, result: undefined }));
  return { ...f, file };
}

function envelopeId(path) {
  return JSON.parse(readFileSync(path, 'utf8')).documentId;
}

async function runFaultChild(path, mode, marker) {
  const child = spawn(process.execPath, ['tests/private-model-state-fault-child.mjs', path, mode], {
    cwd: new URL('..', import.meta.url),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`${mode} child timeout`)); }, 10_000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', value => { clearTimeout(timer); resolve(value); });
  });
  assert.equal(code, 0, stderr);
  assert.equal(stdout, `${marker}\n`);
}

test('a protected model-state file supports missing read, first write, and reopen', { skip: !POSIX }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'behalvo-private-file-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'nested', 'state.json');
  const key = Buffer.alloc(32, 8);
  const file = new PrivateModelStateFile(path, 'model-settings', key, schema);
  await file.preflight({ writable: true });
  assert.equal(existsSync(path), false);
  assert.equal(lstatSync(join(root, 'nested')).mode & 0o777, 0o700);
  assert.deepEqual(await file.read(), { count: 0 });
  assert.equal(await file.update(async current => ({ next: { count: current.count + 1 }, result: 'saved' })), 'saved');
  assert.equal(lstatSync(path).mode & 0o777, 0o600);
  assert.deepEqual(await file.read(), { count: 1 });

  const reopened = new PrivateModelStateFile(path, 'model-settings', Buffer.alloc(32, 8), schema);
  assert.deepEqual(await reopened.read(), { count: 1 });
  await unlink(path);
  await assert.rejects(() => file.read(), { message: 'Private model state is unavailable.' });
});

test('protected model-state refuses Windows with a fixed safe error', { skip: POSIX }, async () => {
  const file = new PrivateModelStateFile('synthetic.json', 'model-settings', Buffer.alloc(32, 8), schema);
  await assert.rejects(() => file.read(), { message: 'Private model state is unavailable.' });
});

test('private snapshot reads exact descriptor bytes and enforces read versus write modes', { skip: !POSIX }, async t => {
  const { path } = await fixture(t);
  writeFileSync(path, 'synthetic', { mode: 0o600 });
  const stat = lstatSync(path, { bigint: true });
  const snapshot = readPrivateFileSnapshot(path, 9);
  assert.equal(snapshot.bytes.toString(), 'synthetic');
  assert.equal(snapshot.device, stat.dev);
  assert.equal(snapshot.inode, stat.ino);
  assert.throws(() => readPrivateFileSnapshot(path, 8));
  chmodSync(path, 0o400);
  assert.equal(readPrivateFileSnapshot(path, 9).bytes.toString(), 'synthetic');
  assert.throws(() => readPrivateFileSnapshot(path, 9, { readOnly: false }));
});

test('canonical model-state paths resolve missing suffixes but reject root, NUL, and immediate symlink parents', { skip: !POSIX }, async t => {
  const { root } = await fixture(t);
  const existing = join(root, 'canonical');
  mkdirSync(existing, { mode: 0o700 });
  assert.equal(resolveModelStatePath(join(existing, 'missing', '..', 'new', 'state.json')),
    join(existing, 'new', 'state.json'));
  assert.equal(existsSync(join(existing, 'new')), false);
  const alias = join(root, 'alias');
  symlinkSync(existing, alias, 'dir');
  assert.throws(() => resolveModelStatePath(join(alias, 'state.json')),
    { message: 'Invalid private model state configuration.' });
  for (const value of ['', '/', 'bad\0path'])
    assert.throws(() => resolveModelStatePath(value), { message: 'Invalid private model state configuration.' });
});

test('two objects serialize updates and the second callback reads the first commit', { skip: !POSIX }, async t => {
  const f = await seeded(t);
  const firstEntered = deferred();
  const releaseFirst = deferred();
  const first = new PrivateModelStateFile(f.path, 'model-settings', f.key, schema);
  const second = new PrivateModelStateFile(f.path, 'model-settings', f.key, schema);
  const firstUpdate = first.update(async current => {
    firstEntered.resolve();
    await releaseFirst.promise;
    return { next: { count: current.count + 1 }, result: 'first' };
  });
  await firstEntered.promise;
  let secondCurrent;
  const secondEntered = deferred();
  const secondUpdate = second.update(async current => {
    secondCurrent = current.count;
    secondEntered.resolve();
    return { next: { count: current.count + 1 }, result: 'second' };
  });
  assert.equal(existsSync(f.lockPath), true);
  releaseFirst.resolve();
  assert.equal(await firstUpdate, 'first');
  await secondEntered.promise;
  assert.equal(await secondUpdate, 'second');
  assert.equal(secondCurrent, 1);
  assert.deepEqual(await first.read(), { count: 2 });
});

test('an undefined replacement preserves ciphertext bytes and document identity', { skip: !POSIX }, async t => {
  const f = await seeded(t);
  const before = readFileSync(f.path);
  const id = envelopeId(f.path);
  assert.equal(await f.file.update(async current => ({ next: undefined, result: current.count })), 0);
  assert.deepEqual(readFileSync(f.path), before);
  assert.equal(envelopeId(f.path), id);
});

test('preflight authenticates existing state without rewriting it', { skip: !POSIX }, async t => {
  const f = await seeded(t);
  const before = readFileSync(f.path);
  await f.file.preflight();
  await f.file.preflight({ writable: true });
  assert.deepEqual(readFileSync(f.path), before);
});

test('abort while waiting never invokes the callback and leaves the owned lock in place', { skip: !POSIX }, async t => {
  const f = await seeded(t);
  const entered = deferred();
  const release = deferred();
  const holder = f.file.update(async current => {
    entered.resolve();
    await release.promise;
    return { next: { count: current.count + 1 }, result: 'held' };
  });
  await entered.promise;
  const controller = new AbortController();
  let callbackCount = 0;
  const waiting = new PrivateModelStateFile(f.path, 'model-settings', f.key, schema).update(async current => {
    callbackCount++;
    return { next: current, result: undefined };
  }, { signal: controller.signal });
  controller.abort(new Error('synthetic-abort-secret'));
  await assert.rejects(() => waiting, { message: 'Private model state operation cancelled.' });
  assert.equal(callbackCount, 0);
  assert.equal(existsSync(f.lockPath), true);
  release.resolve();
  assert.equal(await holder, 'held');
});

test('a safe leftover lock waits for the full deadline and remains untouched', { skip: !POSIX }, async t => {
  const f = await seeded(t);
  writeFileSync(f.lockPath, '{"version":1,"pid":123,"instanceId":"synthetic"}\n', { mode: 0o600 });
  const before = readFileSync(f.lockPath);
  let callbackCount = 0;
  const started = performance.now();
  await assert.rejects(
    () => f.file.update(async current => { callbackCount++; return { next: current, result: undefined }; }),
    { message: 'Private model state is busy.' }
  );
  assert.ok(performance.now() - started >= 4_900);
  assert.equal(callbackCount, 0);
  assert.deepEqual(readFileSync(f.lockPath), before);
});

test('abort after callback entry does not release early and a valid result is persisted', { skip: !POSIX }, async t => {
  const f = await seeded(t);
  const entered = deferred();
  const release = deferred();
  const controller = new AbortController();
  const update = f.file.update(async current => {
    entered.resolve();
    await release.promise;
    return { next: { count: current.count + 1 }, result: 'persisted' };
  }, { signal: controller.signal });
  await entered.promise;
  controller.abort(new Error('synthetic-abort-secret'));
  assert.equal(existsSync(f.lockPath), true);
  let competitorCalls = 0;
  const competitorAbort = new AbortController();
  const competitor = new PrivateModelStateFile(f.path, 'model-settings', f.key, schema).update(async current => {
    competitorCalls++;
    return { next: current, result: undefined };
  }, { signal: competitorAbort.signal });
  competitorAbort.abort();
  await assert.rejects(() => competitor, { message: 'Private model state operation cancelled.' });
  assert.equal(competitorCalls, 0);
  assert.equal(existsSync(f.lockPath), true);
  release.resolve();
  assert.equal(await update, 'persisted');
  assert.deepEqual(await f.file.read(), { count: 1 });
});

test('callback rejection preserves its identity and prior bytes, then releases for a valid update', { skip: !POSIX }, async t => {
  const f = await seeded(t);
  const before = readFileSync(f.path);
  const rejection = new Error('synthetic-callback-secret');
  let calls = 0;
  await assert.rejects(() => f.file.update(async () => { calls++; throw rejection; }), error => error === rejection);
  assert.equal(calls, 1);
  assert.deepEqual(readFileSync(f.path), before);
  assert.equal(existsSync(f.lockPath), false);
  await f.file.update(async current => ({ next: { count: current.count + 1 }, result: undefined }));
  assert.deepEqual(await f.file.read(), { count: 1 });
});

for (const kind of ['lock', 'target', 'parent']) {
  test(`${kind} replacement during a callback rejects publication and preserves the replacement`, { skip: !POSIX }, async t => {
    const f = await seeded(t);
    let calls = 0;
    await assert.rejects(() => f.file.update(async current => {
      calls++;
      if (kind === 'lock') {
        unlinkSync(f.lockPath);
        writeFileSync(f.lockPath, 'foreign-lock', { mode: 0o600 });
      } else if (kind === 'target') {
        renameSync(f.path, `${f.path}.old`);
        writeFileSync(f.path, 'foreign-target', { mode: 0o600 });
      } else {
        renameSync(f.directory, `${f.directory}.old`);
        mkdirSync(f.directory, { mode: 0o700 });
        writeFileSync(join(f.directory, 'foreign-parent-marker'), 'foreign-parent', { mode: 0o600 });
      }
      return { next: { count: current.count + 1 }, result: 'unused' };
    }), { message: 'Private model state update failed.' });
    assert.equal(calls, 1);
    if (kind === 'lock') assert.equal(readFileSync(f.lockPath, 'utf8'), 'foreign-lock');
    if (kind === 'target') assert.equal(readFileSync(f.path, 'utf8'), 'foreign-target');
    if (kind === 'parent') assert.equal(readFileSync(join(f.directory, 'foreign-parent-marker'), 'utf8'), 'foreign-parent');
  });
}

test('malformed, empty, wrong-purpose, and schema-invalid documents remain unchanged', { skip: !POSIX }, async t => {
  const f = await fixture(t);
  const documents = [
    Buffer.alloc(0),
    Buffer.from('{'),
    new ModelStateCodec(f.key, 'pi-credentials').seal('{"count":0}').bytes,
    new ModelStateCodec(f.key, 'model-settings').seal('"synthetic-schema-secret"').bytes,
    new ModelStateCodec(f.key, 'model-settings').seal('not-json-at-all').bytes
  ];
  for (const [index, bytes] of documents.entries()) {
    const path = join(f.directory, `invalid-${index}.json`);
    writeFileSync(path, bytes, { mode: 0o600 });
    const file = new PrivateModelStateFile(path, 'model-settings', f.key, schema);
    await assert.rejects(() => file.read(), { message: 'Private model state is unavailable.' });
    let calls = 0;
    await assert.rejects(() => file.update(async current => { calls++; return { next: current, result: undefined }; }),
      { message: 'Private model state is unavailable.' });
    assert.equal(calls, 0);
    assert.deepEqual(readFileSync(path), bytes);
    assert.equal(lstatSync(path).mode & 0o777, 0o600);
  }
});

test('missing state with a leftover lock and disappearance after observation are unavailable', { skip: !POSIX }, async t => {
  const f = await fixture(t);
  writeFileSync(f.lockPath, 'leftover', { mode: 0o600 });
  const file = new PrivateModelStateFile(f.path, 'model-settings', f.key, schema);
  await assert.rejects(() => file.read(), { message: 'Private model state is unavailable.' });
  assert.equal(readFileSync(f.lockPath, 'utf8'), 'leftover');
  unlinkSync(f.lockPath);
  await file.update(async () => ({ next: { count: 2 }, result: undefined }));
  await file.read();
  unlinkSync(f.path);
  await assert.rejects(() => file.read(), { message: 'Private model state is unavailable.' });
});

test('unsafe leftover locks fail immediately and remain unchanged', { skip: !POSIX }, async t => {
  const f = await seeded(t);
  writeFileSync(f.lockPath, 'unsafe-lock', { mode: 0o644 });
  const before = readFileSync(f.lockPath);
  let calls = 0;
  const started = performance.now();
  await assert.rejects(() => f.file.update(async current => {
    calls++;
    return { next: current, result: undefined };
  }), { message: 'Private model state is busy.' });
  assert.ok(performance.now() - started < 1_000);
  assert.equal(calls, 0);
  assert.deepEqual(readFileSync(f.lockPath), before);
  assert.equal(lstatSync(f.lockPath).mode & 0o777, 0o644);
});

test('read-only data can be read but mutation and writable preflight stop before callbacks', { skip: !POSIX }, async t => {
  const f = await seeded(t);
  chmodSync(f.path, 0o400);
  assert.deepEqual(await f.file.read(), { count: 0 });
  let calls = 0;
  await assert.rejects(() => f.file.update(async current => { calls++; return { next: current, result: undefined }; }),
    { message: 'Private model state is unavailable.' });
  await assert.rejects(() => f.file.preflight({ writable: true }),
    { message: 'Private model state is unavailable.' });
  assert.equal(calls, 0);
  assert.equal(lstatSync(f.path).mode & 0o777, 0o400);
});

test('unsafe parent, symlink, hard-link, and foreign-owner paths fail without repair', { skip: !POSIX }, async t => {
  const unsafeParent = await fixture(t, 'unsafe.json');
  chmodSync(unsafeParent.directory, 0o755);
  const unsafeFile = new PrivateModelStateFile(unsafeParent.path, 'model-settings', unsafeParent.key, schema);
  await assert.rejects(() => unsafeFile.read(), { message: 'Private model state is unavailable.' });
  assert.equal(lstatSync(unsafeParent.directory).mode & 0o777, 0o755);

  const f = await seeded(t);
  const symlink = join(f.directory, 'symlink.json');
  symlinkSync(f.path, symlink);
  const symlinkFile = new PrivateModelStateFile(symlink, 'model-settings', f.key, schema);
  await assert.rejects(() => symlinkFile.read(), { message: 'Private model state is unavailable.' });
  assert.equal(lstatSync(symlink).isSymbolicLink(), true);

  const hardlink = join(f.directory, 'hardlink.json');
  linkSync(f.path, hardlink);
  const hardlinkFile = new PrivateModelStateFile(hardlink, 'model-settings', f.key, schema);
  await assert.rejects(() => hardlinkFile.read(), { message: 'Private model state is unavailable.' });
  assert.equal(lstatSync(hardlink).nlink, 2);

  if (process.geteuid() === 0 && typeof process.seteuid === 'function') {
    unlinkSync(hardlink);
    let changedOwner = false;
    try {
      process.seteuid(65_534);
      changedOwner = true;
      await assert.rejects(() => f.file.read(), { message: 'Private model state is unavailable.' });
    } catch (error) {
      if (error?.code !== 'EINVAL') throw error;
      t.diagnostic('foreign-owner assertion unavailable in this id-mapped test filesystem');
    } finally {
      if (changedOwner) process.seteuid(0);
    }
    assert.equal(lstatSync(f.path).uid, 0);
  }
});

test('special file-mode bits introduced during a callback reject publication', { skip: !POSIX }, async t => {
  const f = await seeded(t);
  const before = readFileSync(f.path);
  let calls = 0;
  await assert.rejects(() => f.file.update(async current => {
    calls++;
    chmodSync(f.path, 0o4600);
    return { next: { count: current.count + 1 }, result: undefined };
  }), { message: 'Private model state update failed.' });
  assert.equal(calls, 1);
  assert.deepEqual(readFileSync(f.path), before);
  assert.equal(lstatSync(f.path).mode & 0o7777, 0o4600);
});

test('invalid proposed state maps schema and serialization details to a fixed update error', { skip: !POSIX }, async t => {
  const f = await seeded(t);
  const before = readFileSync(f.path);
  for (const next of [{ count: 'synthetic-schema-secret' }, { count: 1, extra: 2 }]) {
    await assert.rejects(() => f.file.update(async () => ({ next, result: undefined })), error => {
      assert.equal(error.message, 'Private model state update failed.');
      assert.equal(error.message.includes('synthetic-schema-secret'), false);
      assert.equal(error.cause, undefined);
      return true;
    });
    assert.deepEqual(readFileSync(f.path), before);
  }
  const returned = {};
  Object.defineProperty(returned, 'next', { enumerable: true, get() { throw new Error('synthetic-getter-secret'); } });
  Object.defineProperty(returned, 'result', { enumerable: true, value: undefined });
  await assert.rejects(() => f.file.update(async () => returned), {
    message: 'Private model state update failed.'
  });
  assert.deepEqual(readFileSync(f.path), before);
});

test('post-rename fsync uncertainty reports failure once while leaving valid published ciphertext', { skip: !POSIX }, async t => {
  const f = await fixture(t, 'fault.json');
  const child = spawn(process.execPath, ['tests/private-model-state-fault-child.mjs', f.path], {
    cwd: new URL('..', import.meta.url),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('fault child timeout'));
    }, 10_000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', value => { clearTimeout(timer); resolve(value); });
  });
  assert.equal(code, 0, stderr);
  assert.equal(stdout, 'POST_RENAME_FAULT_OK\n');
  assert.deepEqual(readdirSync(f.directory).sort(), ['fault.json']);
});

test('post-link fsync uncertainty still records that the instance wrote a file', { skip: !POSIX }, async t => {
  const f = await fixture(t, 'link-fault.json');
  const child = spawn(process.execPath, ['tests/private-model-state-fault-child.mjs', f.path, 'link'], {
    cwd: new URL('..', import.meta.url),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('link fault child timeout')); }, 10_000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', value => { clearTimeout(timer); resolve(value); });
  });
  assert.equal(code, 0, stderr);
  assert.equal(stdout, 'POST_LINK_FAULT_OK\n');
  assert.deepEqual(readdirSync(f.directory), []);
});

for (const [mode, marker] of [
  ['payload-replace', 'PAYLOAD_REPLACEMENT_OK'],
  ['stage-replace', 'STAGE_REPLACEMENT_OK'],
  ['link-replace', 'GUARDED_LINK_UNLINK_OK'],
  ['cleanup-failure', 'CLEANUP_FAILURE_OK'],
  ['lock-disappear', 'LOCK_DISAPPEARANCE_OK']
]) {
  test(`${mode} interposition follows the fixed ownership and lock-handoff contract`, { skip: !POSIX }, async t => {
    const f = await fixture(t, `${mode}.json`);
    await runFaultChild(f.path, mode, marker);
    assert.deepEqual(readdirSync(f.directory), [`${mode}.json`]);
  });
}
