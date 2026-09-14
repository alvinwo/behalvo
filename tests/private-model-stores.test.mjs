import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { constants } from 'node:fs';
import { copyFile, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PiCredentialFileStore } from '../dist/model/pi-auth-store.js';
import { ModelSettingsStore } from '../dist/cli/model-settings.js';
import { ModelStateCodec, MODEL_STATE_LIMITS } from '../dist/storage/model-state-codec.js';
import { createStorageKeyFile, loadStorageKeyFile } from '../dist/storage/key-file.js';

const CHILD = fileURLToPath(new URL('./private-model-state-child.mjs', import.meta.url));

function safeError(message) {
  return error => error instanceof Error && error.message === message && !Object.hasOwn(error, 'cause');
}

async function privateFixture(t, prefix = 'behalvo-private-stores-') {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  await (await import('node:fs/promises')).chmod(dir, 0o700);
  t.after(() => rm(dir, { recursive: true, force: true }));
  const key = Buffer.alloc(32, 9);
  return { dir, key, options: { encryptionKey: key } };
}

function nestedArrays(depth) {
  let value = 'synthetic-leaf';
  for (let index = 0; index < depth; index += 1) value = [value];
  return value;
}

async function writeProtected(path, purpose, key, value) {
  const bytes = new ModelStateCodec(key, purpose).seal(JSON.stringify(value)).bytes;
  await writeFile(path, bytes, { mode: 0o600 });
}

function waitFor(child, messages, predicate, milliseconds = 8_000) {
  const buffered = messages.findIndex(predicate);
  if (buffered !== -1) return Promise.resolve(messages.splice(buffered, 1)[0]);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('synthetic child IPC timeout')), milliseconds);
    const onMessage = message => {
      if (!predicate(message)) return;
      const index = messages.indexOf(message);
      if (index !== -1) messages.splice(index, 1);
      finish(undefined, message);
    };
    const onError = error => finish(error);
    const onExit = (code, signal) => finish(new Error(`synthetic child exited before message (${code ?? signal})`));
    function finish(error, value) {
      clearTimeout(timer);
      child.off('message', onMessage);
      child.off('error', onError);
      child.off('exit', onExit);
      if (error) reject(error); else resolve(value);
    }
    child.on('message', onMessage);
    child.on('error', onError);
    child.on('exit', onExit);
  });
}

function waitForExit(child, milliseconds = 8_000) {
  if (child.exitCode !== null || child.signalCode !== null)
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('synthetic child exit timeout')), milliseconds);
    const onExit = (code, signal) => finish(undefined, { code, signal });
    const onError = error => finish(error);
    function finish(error, value) {
      clearTimeout(timer);
      child.off('exit', onExit);
      child.off('error', onError);
      if (error) reject(error); else resolve(value);
    }
    child.on('exit', onExit);
    child.on('error', onError);
  });
}

async function childFor(t, command) {
  const child = fork(CHILD, [], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  const messages = [];
  child.on('message', message => messages.push(message));
  let reaped = false;
  t.after(async () => {
    if (!reaped && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    if (!reaped) await waitForExit(child).catch(() => undefined);
  });
  await waitFor(child, messages, message => message?.kind === 'ready');
  child.send(command);
  return {
    child,
    wait: predicate => waitFor(child, messages, predicate),
    async reap() { const result = await waitForExit(child); reaped = true; return result; }
  };
}

test('protected credentials preserve extensions, safe key names, defensive copies, and undefined no-change bytes', async t => {
  const { dir, key, options } = await privateFixture(t);
  const path = join(dir, 'auth.json');
  const store = new PiCredentialFileStore(path, options);
  const credential = {
    type: 'oauth', access: 'synthetic-access-canary', refresh: 'synthetic-refresh-canary', expires: 123,
    account: { label: 'synthetic-account-canary', scopes: ['synthetic'] }, extension: nestedArrays(32)
  };
  const written = await store.modify('__proto__', async () => credential);
  credential.account.label = 'caller-mutated';
  assert.equal(written.account.label, 'synthetic-account-canary');
  const before = await readFile(path);
  const unchanged = await store.modify('__proto__', async current => {
    current.access = 'mutated-copy';
    current.account.label = 'mutated-copy';
    return undefined;
  });
  assert.equal(unchanged.access, 'synthetic-access-canary');
  assert.equal(unchanged.account.label, 'synthetic-account-canary');
  unchanged.account.label = 'return-mutated';
  assert.deepEqual(await readFile(path), before);
  assert.deepEqual(await store.list(), [{ providerId: '__proto__', type: 'oauth' }]);
  assert.equal(await store.read('constructor'), undefined);
  await store.modify('constructor', async () => ({ type: 'api_key', env: { REGION: 'synthetic' } }));
  const after = await readFile(path);
  assert.notDeepEqual(after, before, 'each successful write must publish fresh ciphertext');
  assert.doesNotMatch(after.toString('utf8'), /synthetic-access-canary|synthetic-refresh-canary|synthetic-account-canary|__proto__|constructor/);
  await store.delete('__proto__');
  assert.equal(await store.read('__proto__'), undefined);
  assert.deepEqual((await store.read('constructor')).env, { REGION: 'synthetic' });
  await store.preflight({ writable: true });
  assert.equal((await readdir(dir)).some(name => name.startsWith('.behalvo-model-state-stage-')), false);
});

test('protected settings preserve exact schema, safe workspace names, copied values, and same-purpose copies', async t => {
  const { dir, key, options } = await privateFixture(t);
  const path = join(dir, 'agent.settings.json');
  const store = new ModelSettingsStore(path, options);
  const selection = { provider: 'synthetic-provider-canary', model: 'synthetic-model-canary' };
  await store.write('__proto__', selection);
  selection.model = 'caller-mutated';
  await store.write('toString', { provider: 'synthetic-two', model: 'synthetic-second' });
  const returned = await store.read('__proto__');
  assert.deepEqual(returned, { provider: 'synthetic-provider-canary', model: 'synthetic-model-canary' });
  returned.model = 'return-mutated';
  assert.deepEqual(await store.read('__proto__'), { provider: 'synthetic-provider-canary', model: 'synthetic-model-canary' });
  assert.deepEqual(await store.read('toString'), { provider: 'synthetic-two', model: 'synthetic-second' });
  const raw = await readFile(path);
  assert.doesNotMatch(raw.toString('utf8'), /__proto__|toString|synthetic-provider-canary|synthetic-model-canary/);
  const decoded = new ModelStateCodec(key, 'model-settings').open(raw);
  assert.deepEqual(JSON.parse(decoded.plaintext), JSON.parse('{"version":1,"workspaces":{"__proto__":{"provider":"synthetic-provider-canary","model":"synthetic-model-canary"},"toString":{"provider":"synthetic-two","model":"synthetic-second"}}}'));
  const copied = join(dir, 'copied.settings.json');
  await copyFile(path, copied, constants.COPYFILE_EXCL);
  await (await import('node:fs/promises')).chmod(copied, 0o600);
  assert.deepEqual(await new ModelSettingsStore(copied, options).read('__proto__'), {
    provider: 'synthetic-provider-canary', model: 'synthetic-model-canary'
  });
});

test('protected stores reject wrong keys, purposes, invalid schemas, and plaintext mode mismatches without changing bytes', async t => {
  const { dir, key, options } = await privateFixture(t);
  const wrong = { encryptionKey: Buffer.alloc(32, 7) };
  const authPath = join(dir, 'auth.json');
  await new PiCredentialFileStore(authPath, options).modify('synthetic', async () => ({ type: 'api_key', key: 'synthetic-secret' }));
  const protectedAuth = await readFile(authPath);
  await assert.rejects(() => new PiCredentialFileStore(authPath, wrong).read('synthetic'), safeError('Private model state is unavailable.'));
  await assert.rejects(() => new ModelSettingsStore(authPath, options).read('synthetic'), safeError('Private model state is unavailable.'));
  await assert.rejects(() => new PiCredentialFileStore(authPath).read('synthetic'));
  await assert.rejects(() => new PiCredentialFileStore(authPath).modify('other', async () => ({ type: 'api_key', key: 'x' })));
  assert.deepEqual(await readFile(authPath), protectedAuth);

  const plaintextPath = join(dir, 'plaintext-auth.json');
  await writeFile(plaintextPath, '{"synthetic":{"type":"api_key","key":"synthetic-secret"}}\n', { mode: 0o600 });
  const plaintext = await readFile(plaintextPath);
  await assert.rejects(() => new PiCredentialFileStore(plaintextPath, options).read('synthetic'), safeError('Private model state is unavailable.'));
  await assert.rejects(() => new PiCredentialFileStore(plaintextPath, options).modify('other', async () => ({ type: 'api_key', key: 'x' })), safeError('Private model state is unavailable.'));
  assert.deepEqual(await readFile(plaintextPath), plaintext);

  const protectedSettingsPath = join(dir, 'protected-settings.json');
  await new ModelSettingsStore(protectedSettingsPath, options)
    .write('synthetic', { provider: 'synthetic', model: 'protected' });
  const protectedSettings = await readFile(protectedSettingsPath);
  await assert.rejects(() => new ModelSettingsStore(protectedSettingsPath).read('synthetic'));
  await assert.rejects(() => new ModelSettingsStore(protectedSettingsPath)
    .write('other', { provider: 'synthetic', model: 'other' }));
  assert.deepEqual(await readFile(protectedSettingsPath), protectedSettings);

  const plaintextSettingsPath = join(dir, 'plaintext-settings.json');
  await writeFile(plaintextSettingsPath,
    '{"version":1,"workspaces":{"synthetic":{"provider":"synthetic","model":"plaintext"}}}\n',
    { mode: 0o600 });
  const plaintextSettings = await readFile(plaintextSettingsPath);
  await assert.rejects(() => new ModelSettingsStore(plaintextSettingsPath, options).read('synthetic'),
    safeError('Private model state is unavailable.'));
  await assert.rejects(() => new ModelSettingsStore(plaintextSettingsPath, options)
    .write('other', { provider: 'synthetic', model: 'other' }), safeError('Private model state is unavailable.'));
  assert.deepEqual(await readFile(plaintextSettingsPath), plaintextSettings);

  const invalidPath = join(dir, 'invalid-auth.json');
  await writeProtected(invalidPath, 'pi-credentials', key, { synthetic: { type: 'oauth', access: 'a', refresh: 'r', expires: 'not-finite' } });
  await assert.rejects(() => new PiCredentialFileStore(invalidPath, options).read('synthetic'), safeError('Private model state is unavailable.'));
  const invalidSettingsPath = join(dir, 'invalid-settings.json');
  await writeProtected(invalidSettingsPath, 'model-settings', key, {
    version: 1, workspaces: { synthetic: { provider: 'synthetic', model: 'valid', extra: true } }
  });
  await assert.rejects(() => new ModelSettingsStore(invalidSettingsPath, options).read('synthetic'),
    safeError('Private model state is unavailable.'));
});

test('protected credential extension validation accepts depth 32 and rejects non-JSON-safe values at depth 33', async t => {
  const { dir, options } = await privateFixture(t);
  const store = new PiCredentialFileStore(join(dir, 'auth.json'), options);
  await store.modify('valid', async () => ({ type: 'oauth', access: 'a', refresh: 'r', expires: 1,
    scalar: null, nested: nestedArrays(32) }));

  const sparse = []; sparse[1] = 'value';
  const cycle = {}; cycle.self = cycle;
  const accessor = { type: 'oauth', access: 'a', refresh: 'r', expires: 1 };
  Object.defineProperty(accessor, 'secret', { enumerable: true, get() { throw new Error('synthetic getter secret'); } });
  const invalid = [
    nestedArrays(33), cycle, sparse, undefined, () => {}, Symbol('synthetic'), 1n,
    Number.NaN, Number.POSITIVE_INFINITY, new Date(), accessor
  ];
  for (const [index, extension] of invalid.entries()) {
    const candidate = index === invalid.length - 1 ? extension : {
      type: 'oauth', access: 'a', refresh: 'r', expires: 1, extension
    };
    await assert.rejects(
      () => store.modify(`invalid-${index}`, async () => candidate),
      safeError('Private model state update failed.')
    );
  }
  let envGetterCalls = 0;
  const env = {};
  Object.defineProperty(env, 'REGION', {
    enumerable: true,
    get() {
      envGetterCalls += 1;
      return 'synthetic';
    }
  });
  await assert.rejects(
    () => store.modify('invalid-env-accessor', async () => ({ type: 'api_key', env })),
    safeError('Private model state update failed.')
  );
  assert.equal(envGetterCalls, 0);
});

test('protected credential callback rejection preserves the original identity and prior bytes', async t => {
  const { dir, options } = await privateFixture(t);
  const path = join(dir, 'auth.json');
  const store = new PiCredentialFileStore(path, options);
  await store.modify('synthetic', async () => ({ type: 'api_key', key: 'before' }));
  const before = await readFile(path);
  const rejection = new Error('trusted synthetic callback rejection');
  await assert.rejects(() => store.modify('synthetic', async current => {
    current.key = 'mutated-copy';
    throw rejection;
  }), error => error === rejection);
  assert.deepEqual(await readFile(path), before);
  assert.equal((await store.read('synthetic')).key, 'before');
});

test('protected credential and settings schemas enforce cardinality and identifier bounds only in protected mode', async t => {
  const { dir, key, options } = await privateFixture(t);
  const authPath = join(dir, 'auth.json');
  const credentials256 = Object.create(null);
  for (let index = 0; index < MODEL_STATE_LIMITS.providers; index += 1)
    credentials256[`provider-${index}`] = { type: 'api_key', env: { REGION: 'synthetic' } };
  await writeProtected(authPath, 'pi-credentials', key, credentials256);
  assert.equal((await new PiCredentialFileStore(authPath, options).list()).length, 256);
  credentials256.extra = { type: 'api_key', key: 'synthetic' };
  await writeProtected(authPath, 'pi-credentials', key, credentials256);
  await assert.rejects(() => new PiCredentialFileStore(authPath, options).list(), safeError('Private model state is unavailable.'));

  const settingsPath = join(dir, 'settings.json');
  const workspaces = Object.create(null);
  for (let index = 0; index < MODEL_STATE_LIMITS.workspaces; index += 1)
    workspaces[`workspace-${index}`] = { provider: 'synthetic', model: 'model' };
  await writeProtected(settingsPath, 'model-settings', key, { version: 1, workspaces });
  assert.deepEqual(await new ModelSettingsStore(settingsPath, options).read('workspace-1023'), { provider: 'synthetic', model: 'model' });
  workspaces.extra = { provider: 'synthetic', model: 'model' };
  await writeProtected(settingsPath, 'model-settings', key, { version: 1, workspaces });
  await assert.rejects(() => new ModelSettingsStore(settingsPath, options).read('workspace-0'), safeError('Private model state is unavailable.'));

  const ids = ['x'.repeat(513), 'control\u0000name', ''];
  for (const id of ids) {
    await assert.rejects(() => new PiCredentialFileStore(join(dir, `bad-auth-${ids.indexOf(id)}.json`), options)
      .modify(id, async () => ({ type: 'api_key', key: 'synthetic' })), safeError('Private model state update failed.'));
    await assert.rejects(() => new ModelSettingsStore(join(dir, `bad-settings-${ids.indexOf(id)}.json`), options)
      .write(id, { provider: 'synthetic', model: 'model' }), safeError('Private model state update failed.'));
  }
  for (const [index, selection] of [
    { provider: 'p'.repeat(513), model: 'valid' },
    { provider: 'valid', model: 'm'.repeat(513) },
    { provider: 'valid', model: 'bad\u007fmodel' }
  ].entries()) {
    await assert.rejects(
      () => new ModelSettingsStore(join(dir, `bad-selection-${index}.json`), options).write('workspace', selection),
      safeError('Private model state update failed.')
    );
  }
  await new PiCredentialFileStore(join(dir, 'max-auth.json'), options)
    .modify('x'.repeat(512), async () => ({ type: 'api_key', key: 'synthetic' }));
  await new ModelSettingsStore(join(dir, 'max-settings.json'), options)
    .write('x'.repeat(512), { provider: 'y'.repeat(512), model: 'z'.repeat(512) });

  const legacyPath = join(dir, 'legacy.json');
  await writeFile(legacyPath, JSON.stringify({ ['x'.repeat(513)]: { type: 'api_key', key: 'synthetic' } }), { mode: 0o600 });
  assert.equal((await new PiCredentialFileStore(legacyPath).read('x'.repeat(513))).key, 'synthetic');
});

test('protected credential updates enforce the exact serialized plaintext byte boundary', async t => {
  const { dir, options } = await privateFixture(t);
  const base = { type: 'oauth', access: 'a', refresh: 'r', expires: 1, padding: '' };
  const withoutPadding = Buffer.byteLength(JSON.stringify({ synthetic: base }));
  const exactPadding = MODEL_STATE_LIMITS.plaintextBytes - withoutPadding;
  base.padding = 'x'.repeat(exactPadding);
  assert.equal(Buffer.byteLength(JSON.stringify({ synthetic: base })), MODEL_STATE_LIMITS.plaintextBytes);
  await new PiCredentialFileStore(join(dir, 'exact.json'), options).modify('synthetic', async () => base);
  base.padding += 'x';
  await assert.rejects(
    () => new PiCredentialFileStore(join(dir, 'over.json'), options).modify('synthetic', async () => base),
    safeError('Private model state update failed.')
  );
});

test('protected adapters serialize real child-process refresh, add, settings, and delete operations', async t => {
  const { dir } = await privateFixture(t, 'behalvo-private-processes-');
  const keyPath = join(dir, 'key.behalvo-key');
  await createStorageKeyFile(keyPath);
  const encryptionKey = loadStorageKeyFile(keyPath);
  const authPath = join(dir, 'auth.json');
  const settingsPath = join(dir, 'settings.json');
  const auth = new PiCredentialFileStore(authPath, { encryptionKey });
  await auth.modify('refresh', async () => ({ type: 'oauth', access: 'synthetic-expired', refresh: 'synthetic-once', expires: 1 }));
  await auth.modify('unrelated', async () => ({ type: 'api_key', env: { REGION: 'synthetic' } }));

  const first = await childFor(t, { kind: 'auth-refresh', authPath, keyPath, provider: 'refresh', hold: true });
  assert.deepEqual(await first.wait(message => message?.kind === 'entered'), { kind: 'entered', access: 'synthetic-expired' });
  const second = await childFor(t, { kind: 'auth-refresh', authPath, keyPath, provider: 'refresh', hold: false });
  first.child.send({ kind: 'release' });
  await first.wait(message => message?.kind === 'done');
  assert.deepEqual(await second.wait(message => message?.kind === 'entered'), { kind: 'entered', access: 'synthetic-refreshed' });
  await second.wait(message => message?.kind === 'done');
  assert.equal((await first.reap()).code, 0);
  assert.equal((await second.reap()).code, 0);
  assert.deepEqual(await auth.read('refresh'), { type: 'oauth', access: 'synthetic-refreshed', refresh: 'synthetic-rotated', expires: 2 });
  assert.deepEqual((await auth.read('unrelated')).env, { REGION: 'synthetic' });

  const addChildren = await Promise.all(Array.from({ length: 6 }, (_, index) => childFor(t, {
    kind: 'auth-add', authPath, keyPath, provider: `provider-${index}`
  })));
  const settingsChildren = await Promise.all(Array.from({ length: 6 }, (_, index) => childFor(t, {
    kind: 'settings-write', settingsPath, keyPath, workspace: `workspace-${index}`
  })));
  await Promise.all([...addChildren, ...settingsChildren].map(async worker => {
    await worker.wait(message => message?.kind === 'done');
    assert.equal((await worker.reap()).code, 0);
  }));
  for (let index = 0; index < 6; index += 1) {
    assert.deepEqual((await auth.read(`provider-${index}`)).env, { SYNTHETIC_PROVIDER: `provider-${index}` });
    assert.deepEqual(await new ModelSettingsStore(settingsPath, { encryptionKey }).read(`workspace-${index}`), {
      provider: 'synthetic', model: `workspace-${index}`
    });
  }

  const held = await childFor(t, { kind: 'auth-refresh', authPath, keyPath, provider: 'refresh', hold: true });
  await held.wait(message => message?.kind === 'entered');
  const deletion = await childFor(t, { kind: 'auth-delete', authPath, keyPath, provider: 'refresh' });
  held.child.send({ kind: 'release' });
  await held.wait(message => message?.kind === 'done');
  await deletion.wait(message => message?.kind === 'done');
  assert.equal((await held.reap()).code, 0);
  assert.equal((await deletion.reap()).code, 0);
  assert.equal(await auth.read('refresh'), undefined);
  encryptionKey.fill(0);
});

test('unclean child exit leaves the protected lock busy and prevents a second refresh callback', async t => {
  const { dir } = await privateFixture(t, 'behalvo-private-crash-');
  const keyPath = join(dir, 'key.behalvo-key');
  await createStorageKeyFile(keyPath);
  const encryptionKey = loadStorageKeyFile(keyPath);
  const authPath = join(dir, 'auth.json');
  await new PiCredentialFileStore(authPath, { encryptionKey }).modify('refresh', async () => ({
    type: 'oauth', access: 'synthetic-expired', refresh: 'synthetic-token', expires: 1
  }));
  const held = await childFor(t, { kind: 'auth-refresh', authPath, keyPath, provider: 'refresh', hold: true });
  await held.wait(message => message?.kind === 'entered');
  held.child.kill('SIGKILL');
  assert.equal((await held.reap()).signal, 'SIGKILL');
  assert.equal((await stat(`${authPath}.behalvo-model-state-lock`)).isFile(), true);
  let entered = false;
  await assert.rejects(
    () => new PiCredentialFileStore(authPath, { encryptionKey }).modify('refresh', async current => {
      entered = true;
      return current;
    }),
    safeError('Private model state is busy.')
  );
  assert.equal(entered, false);
  encryptionKey.fill(0);
});
