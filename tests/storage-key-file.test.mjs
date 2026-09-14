import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { api } from './helpers.mjs';

const POSIX = process.platform !== 'win32';

async function privateFileApi() {
  return import('../dist/storage/private-files.js');
}

async function privateFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'behalvo-private-storage-'));
  chmodSync(root, 0o700);
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('storage key files are generated exclusively with private permissions and reload exactly', { skip: !POSIX }, async t => {
  const { createStorageKeyFile, loadStorageKeyFile } = await api();
  const root = await privateFixture(t);
  const path = join(root, 'storage.behalvo-key');

  await createStorageKeyFile(path);
  const first = loadStorageKeyFile(path);
  const document = JSON.parse(await readFile(path, 'utf8'));

  assert.equal(first.byteLength, 32);
  assert.deepEqual(Object.keys(document), ['version', 'key']);
  assert.equal(document.version, 1);
  assert.equal(Buffer.from(document.key, 'base64').byteLength, 32);
  assert.equal(statSync(path).mode & 0o777, 0o600);

  await assert.rejects(() => createStorageKeyFile(path));
  assert.deepEqual(loadStorageKeyFile(path), first);
});

test('storage key loading rejects malformed documents with fixed safe errors', { skip: !POSIX }, async t => {
  const { loadStorageKeyFile } = await api();
  const root = await privateFixture(t);
  const path = join(root, 'storage.behalvo-key');
  const key = Buffer.alloc(32, 7).toString('base64');
  const invalidDocuments = [
    '{',
    'null',
    '[]',
    JSON.stringify({ version: 2, key }),
    JSON.stringify({ version: 1, key, extra: true }),
    JSON.stringify({ version: 1, key: Buffer.alloc(31).toString('base64') }),
    JSON.stringify({ version: 1, key: key.replace(/=$/, '') }),
    JSON.stringify({ version: 1, key: '*' }),
    'x'.repeat(4097)
  ];

  const messages = new Set();
  for (const document of invalidDocuments) {
    writeFileSync(path, document, { mode: 0o600 });
    chmodSync(path, 0o600);
    assert.throws(() => loadStorageKeyFile(path), error => {
      messages.add(error.message);
      assert.equal(error.message.includes(document.slice(0, 64)), false);
      assert.equal(error.message.includes(path), false);
      assert.equal(error.cause, undefined);
      return true;
    });
  }
  assert.deepEqual([...messages], ['Invalid storage key file.']);
});

test('storage key files reject unsafe permissions, symlinks, hard links, and unsafe directories', { skip: !POSIX }, async t => {
  const { createStorageKeyFile, loadStorageKeyFile } = await api();
  const root = await privateFixture(t);
  const keyPath = join(root, 'real.behalvo-key');
  await createStorageKeyFile(keyPath);

  chmodSync(keyPath, 0o644);
  assert.throws(() => loadStorageKeyFile(keyPath));
  chmodSync(keyPath, 0o600);

  const symlinkPath = join(root, 'link.behalvo-key');
  symlinkSync(keyPath, symlinkPath);
  assert.throws(() => loadStorageKeyFile(symlinkPath));

  const hardlinkPath = join(root, 'hard.behalvo-key');
  linkSync(keyPath, hardlinkPath);
  assert.throws(() => loadStorageKeyFile(keyPath));
  assert.throws(() => loadStorageKeyFile(hardlinkPath));
  await rm(hardlinkPath);

  const unsafeDirectory = join(root, 'unsafe');
  mkdirSync(unsafeDirectory, { mode: 0o755 });
  await assert.rejects(() => createStorageKeyFile(join(unsafeDirectory, 'new.behalvo-key')));
  assert.equal(statSync(unsafeDirectory).mode & 0o777, 0o755);
});

test('private file validation permits read-only key modes but requires writable file mode 0600', { skip: !POSIX }, async t => {
  const { validatePrivateFile } = await privateFileApi();
  const root = await privateFixture(t);
  const path = join(root, 'private-file');
  writeFileSync(path, 'synthetic', { mode: 0o600 });

  validatePrivateFile(path);
  validatePrivateFile(path, { readOnly: true });
  chmodSync(path, 0o400);
  validatePrivateFile(path, { readOnly: true });
  assert.throws(() => validatePrivateFile(path));
});

test('preparePrivateDatabasePath creates new files safely and validates existing sidecars', { skip: !POSIX }, async t => {
  const { preparePrivateDatabasePath } = await privateFileApi();
  const root = await privateFixture(t);
  const nested = join(root, 'new', 'agent.db');

  preparePrivateDatabasePath(nested, false);
  assert.equal(statSync(dirname(nested)).mode & 0o777, 0o700);
  assert.equal(statSync(nested).mode & 0o777, 0o600);

  writeFileSync(`${nested}-wal`, 'synthetic wal', { mode: 0o600 });
  preparePrivateDatabasePath(nested, false);
  chmodSync(`${nested}-wal`, 0o644);
  assert.throws(() => preparePrivateDatabasePath(nested, false));

  const missing = join(root, 'missing.db');
  assert.throws(() => preparePrivateDatabasePath(missing, true));
  assert.equal(existsSync(missing), false);
});

test('preparePrivateDatabasePath rejects stale sidecars without modifying them', { skip: !POSIX }, async t => {
  const { preparePrivateDatabasePath } = await privateFileApi();
  const root = await privateFixture(t);

  for (const suffix of ['-wal', '-shm', '-journal']) {
    const path = join(root, `stale-${suffix.slice(1)}.db`);
    const sidecar = `${path}${suffix}`;
    writeFileSync(sidecar, `synthetic ${suffix}`, { mode: 0o600 });

    assert.throws(() => preparePrivateDatabasePath(path, false));
    assert.equal(existsSync(path), false);
    assert.equal(readFileSync(sidecar, 'utf8'), `synthetic ${suffix}`);
  }
});

test('publishPrivateFile fsyncs private staged output and removes its staging directory', { skip: !POSIX }, async t => {
  const { publishPrivateFile } = await privateFileApi();
  const root = await privateFixture(t);
  const destination = join(root, 'backup.db');
  const before = readdirSync(root);

  await publishPrivateFile(destination, stagedPath => writeFile(stagedPath, 'synthetic backup'));

  assert.equal(readFileSync(destination, 'utf8'), 'synthetic backup');
  assert.equal(statSync(destination).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(root).sort(), [...before, 'backup.db'].sort());
  assert.equal(lstatSync(destination).nlink, 1);
});

test('publishPrivateFile cleans up on writer failure and does not expose the writer error', { skip: !POSIX }, async t => {
  const { publishPrivateFile } = await privateFileApi();
  const root = await privateFixture(t);
  const destination = join(root, 'backup.db');
  const secret = 'synthetic-writer-secret';

  await assert.rejects(
    () => publishPrivateFile(destination, async stagedPath => {
      await writeFile(stagedPath, 'partial synthetic backup');
      throw new Error(secret);
    }),
    error => {
      assert.equal(error.message.includes(secret), false);
      assert.equal(error.message.includes(destination), false);
      assert.equal(error.cause, undefined);
      return true;
    }
  );
  assert.equal(existsSync(destination), false);
  assert.deepEqual(readdirSync(root), []);
});

test('publishPrivateFile preserves an existing destination on collision', { skip: !POSIX }, async t => {
  const { publishPrivateFile } = await privateFileApi();
  const root = await privateFixture(t);
  const destination = join(root, 'backup.db');
  writeFileSync(destination, 'existing backup', { mode: 0o600 });

  await assert.rejects(() => publishPrivateFile(destination, stagedPath => writeFile(stagedPath, 'replacement')));

  assert.equal(readFileSync(destination, 'utf8'), 'existing backup');
  assert.deepEqual(readdirSync(root), ['backup.db']);
});

test('SQLite publication rejects sidecars before staging and immediately before publication', { skip: !POSIX }, async t => {
  const { publishPrivateFile } = await privateFileApi();
  const root = await privateFixture(t);
  const beforeDestination = join(root, 'before.db');
  const beforeSidecar = `${beforeDestination}-wal`;
  writeFileSync(beforeSidecar, 'existing wal', { mode: 0o600 });

  await assert.rejects(() => publishPrivateFile(beforeDestination, stagedPath => writeFile(stagedPath, 'backup'), { sqlite: true }));
  assert.equal(readFileSync(beforeSidecar, 'utf8'), 'existing wal');
  assert.equal(existsSync(beforeDestination), false);

  const racingDestination = join(root, 'racing.db');
  const racingSidecar = `${racingDestination}-journal`;
  await assert.rejects(
    () => publishPrivateFile(racingDestination, async stagedPath => {
      await writeFile(stagedPath, 'backup');
      writeFileSync(racingSidecar, 'racing journal', { mode: 0o600 });
    }, { sqlite: true })
  );
  assert.equal(readFileSync(racingSidecar, 'utf8'), 'racing journal');
  assert.equal(existsSync(racingDestination), false);
  assert.deepEqual(readdirSync(root).sort(), ['before.db-wal', 'racing.db-journal']);
});
