import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { api } from './helpers.mjs';

test('PiCredentialFileStore reads Pi auth.json and persists serialized refresh updates', async () => {
  const { PiCredentialFileStore } = await api();
  const dir = await mkdtemp(join(tmpdir(), 'personal-operator-auth-'));
  const path = join(dir, 'auth.json');
  const store = new PiCredentialFileStore(path);

  assert.equal(await store.read('openai-codex'), undefined);
  const original = { type: 'oauth', access: 'access-1', refresh: 'refresh-1', expires: 10 };
  const written = await store.modify('openai-codex', async current => {
    assert.equal(current, undefined);
    return original;
  });
  assert.deepEqual(written, original);
  assert.deepEqual(await store.read('openai-codex'), original);

  const refreshA = store.modify('openai-codex', async current => {
    assert.equal(current.access, 'access-1');
    await new Promise(resolve => setTimeout(resolve, 15));
    return { ...current, access: 'access-2', expires: 20 };
  });
  const refreshB = store.modify('openai-codex', async current => {
    assert.equal(current.access, 'access-2');
    return { ...current, access: 'access-3', expires: 30 };
  });
  await Promise.all([refreshA, refreshB]);

  assert.equal((await store.read('openai-codex')).access, 'access-3');
  const onDisk = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(onDisk['openai-codex'].access, 'access-3');
  if (process.platform !== 'win32')
    assert.equal((await stat(path)).mode & 0o777, 0o600);
});

test('PiCredentialFileStore delete removes only one provider and malformed auth fails closed', async () => {
  const { PiCredentialFileStore } = await api();
  const dir = await mkdtemp(join(tmpdir(), 'personal-operator-auth-'));
  const path = join(dir, 'auth.json');
  const store = new PiCredentialFileStore(path);

  await store.modify('a', async () => ({ type: 'api_key', key: 'secret-a' }));
  await store.modify('b', async () => ({ type: 'api_key', key: 'secret-b' }));
  await store.delete('a');
  assert.equal(await store.read('a'), undefined);
  assert.equal((await store.read('b')).key, 'secret-b');

  await import('node:fs/promises').then(fs => fs.writeFile(path, '{bad json', 'utf8'));
  await assert.rejects(() => store.read('b'), /auth|json|parse|invalid/i);
});
