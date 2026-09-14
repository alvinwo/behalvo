import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, link, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  assertModelStatePathSeparation,
  loadModelStateProtection,
  resolveModelStateKeyPath
} from '../dist/cli/model-state-config.js';
import { createStorageKeyFile, loadStorageKeyFile } from '../dist/storage/key-file.js';

function configurationError(error) {
  return error instanceof Error && error.message === 'Invalid private model state configuration.' &&
    !Object.hasOwn(error, 'cause');
}

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'behalvo-model-state-config-'));
  await chmod(dir, 0o700);
  t.after(() => rm(dir, { recursive: true, force: true }));
  const modelStateKeyPath = join(dir, 'model-state.behalvo-key');
  const storageKeyPath = join(dir, 'storage.behalvo-key');
  await createStorageKeyFile(modelStateKeyPath);
  await createStorageKeyFile(storageKeyPath);
  return {
    dir,
    modelStateKeyPath,
    storageKeyPath,
    dbPath: join(dir, 'agent.db'),
    authPath: join(dir, 'pi-auth.json'),
    settingsPath: join(dir, 'agent.db.settings.json')
  };
}

test('model-state key path honors explicit precedence and ignores ambient configuration when disabled', async t => {
  const { dir } = await fixture(t);
  assert.equal(resolveModelStateKeyPath(undefined, 'environment.key', dir, true), join(dir, 'environment.key'));
  assert.equal(resolveModelStateKeyPath('flag.key', '', dir, true), join(dir, 'flag.key'));
  assert.throws(() => resolveModelStateKeyPath(undefined, '', dir, true), configurationError);
  assert.equal(resolveModelStateKeyPath(undefined, '/missing/key', dir, false), undefined);
  assert.equal(resolveModelStateKeyPath(undefined, '', dir, false), undefined);
  assert.throws(() => resolveModelStateKeyPath('flag.key', undefined, dir, false), configurationError);
});

test('loading model-state protection returns the generated key and sanitizes key failures', async t => {
  const paths = await fixture(t);
  const protection = loadModelStateProtection(paths);
  assert.deepEqual(protection.encryptionKey, loadStorageKeyFile(paths.modelStateKeyPath));
  protection.encryptionKey.fill(0);

  assert.throws(() => loadModelStateProtection({
    ...paths, modelStateKeyPath: join(paths.dir, 'missing.behalvo-key')
  }), error => error instanceof Error && error.message === 'Private model state key is unavailable.' &&
    !Object.hasOwn(error, 'cause'));
});

test('path separation rejects every ordinary and synthetic database reservation without creating files', async t => {
  const paths = await fixture(t);
  const db = paths.dbPath;
  const reservedDatabasePaths = [
    db, `${db}-wal`, `${db}-shm`, `${db}-journal`, `${db}.behalvo-lock`,
    `${db}.synthetic.sqlite`, `${db}.synthetic.sqlite-wal`,
    `${db}.synthetic.sqlite-shm`, `${db}.synthetic.sqlite-journal`
  ];
  for (const path of reservedDatabasePaths) {
    assert.throws(() => assertModelStatePathSeparation({
      modelStateKeyPath: paths.modelStateKeyPath,
      authPath: path,
      settingsPath: paths.settingsPath,
      dbPath: db,
      syntheticOperations: true
    }), configurationError, path);
    await assert.rejects(() => lstat(path), error => error.code === 'ENOENT', path);
  }
});

test('path separation uses labeled collision groups and permits only intentional key equality', async t => {
  const paths = await fixture(t);
  const authLock = `${paths.authPath}.behalvo-model-state-lock`;
  const settingsLock = `${paths.settingsPath}.behalvo-model-state-lock`;
  const rejected = [
    { authPath: paths.settingsPath },
    { authPath: settingsLock },
    { settingsPath: authLock }
  ];
  for (const override of rejected) {
    assert.throws(() => assertModelStatePathSeparation({
      ...paths,
      ...override
    }), configurationError, JSON.stringify(override));
  }
  const forbiddenForKeys = [
    paths.authPath, paths.settingsPath, authLock, settingsLock,
    paths.dbPath, `${paths.dbPath}-wal`, `${paths.dbPath}-shm`,
    `${paths.dbPath}-journal`, `${paths.dbPath}.behalvo-lock`,
    `${paths.dbPath}.synthetic.sqlite`, `${paths.dbPath}.synthetic.sqlite-wal`,
    `${paths.dbPath}.synthetic.sqlite-shm`, `${paths.dbPath}.synthetic.sqlite-journal`
  ];
  for (const keyName of ['modelStateKeyPath', 'storageKeyPath']) {
    for (const forbidden of forbiddenForKeys) {
      assert.throws(() => assertModelStatePathSeparation({
        ...paths,
        [keyName]: forbidden,
        syntheticOperations: true
      }), configurationError, `${keyName}: ${forbidden}`);
    }
  }
  assert.doesNotThrow(() => assertModelStatePathSeparation({
    ...paths,
    storageKeyPath: paths.modelStateKeyPath
  }));
});

test('path separation canonicalizes dot spellings and trusted ancestor aliases', async t => {
  const paths = await fixture(t);
  assert.throws(() => assertModelStatePathSeparation({
    ...paths,
    authPath: join(paths.dir, 'nested', '..', 'pi-auth.json'),
    settingsPath: join(paths.dir, '.', 'pi-auth.json')
  }), configurationError);

  if (process.platform === 'win32') return t.skip('POSIX symlink path behavior');
  const realRoot = join(paths.dir, 'real-root');
  const nested = join(realRoot, 'nested');
  const aliasRoot = join(paths.dir, 'trusted-alias');
  await mkdir(nested, { recursive: true, mode: 0o700 });
  await symlink(realRoot, aliasRoot, 'dir');
  assert.doesNotThrow(() => assertModelStatePathSeparation({
    ...paths,
    authPath: join(aliasRoot, 'nested', 'auth.json')
  }));

  const immediateAlias = join(paths.dir, 'immediate-alias');
  await symlink(nested, immediateAlias, 'dir');
  assert.throws(() => assertModelStatePathSeparation({
    ...paths,
    authPath: join(immediateAlias, 'auth.json')
  }), configurationError);
});

test('path separation rejects unsafe existing leaves and inode aliases without changing bytes or modes', async t => {
  if (process.platform === 'win32') return t.skip('POSIX inode and mode behavior');
  const paths = await fixture(t);
  const first = join(paths.dir, 'first.json');
  const second = join(paths.dir, 'second.json');
  const linked = join(paths.dir, 'linked.json');
  const directoryLeaf = join(paths.dir, 'directory-leaf');
  const symlinkLeaf = join(paths.dir, 'symlink-leaf');
  await writeFile(first, 'FIRST', { mode: 0o600 });
  await writeFile(second, 'SECOND', { mode: 0o600 });
  await link(first, linked);
  await mkdir(directoryLeaf, { mode: 0o700 });
  await symlink(second, symlinkLeaf);
  const watched = [paths.modelStateKeyPath, paths.storageKeyPath, first, second, linked];
  const before = await Promise.all(watched.map(async path => ({
    path, bytes: await readFile(path), mode: (await lstat(path)).mode
  })));

  for (const authPath of [first, linked, directoryLeaf, symlinkLeaf]) {
    assert.throws(() => assertModelStatePathSeparation({ ...paths, authPath }), configurationError, authPath);
  }
  for (const snapshot of before) {
    assert.deepEqual(await readFile(snapshot.path), snapshot.bytes);
    assert.equal((await lstat(snapshot.path)).mode, snapshot.mode);
  }
});
