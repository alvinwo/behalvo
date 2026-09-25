import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { SyntheticSecretProvider } from '../dist/index.js';

const scope = Object.freeze({
  service: 'visa-scheduling',
  connectionId: 'connection-a',
  purpose: 'password',
  accountId: 'account-a'
});

test('synthetic secret provider exposes only metadata and callback-scoped bytes', async () => {
  const provider = new SyntheticSecretProvider({ clock: () => Date.parse('2026-09-21T12:00:00.000Z') });
  const source = randomBytes(48);
  const expected = Buffer.from(source);
  const metadata = await provider.put({ ...scope, value: source });
  source.fill(0);

  assert.equal('get' in provider, false);
  assert.deepEqual(Object.keys(metadata).sort(), [
    'accountId', 'connectionId', 'createdAt', 'provider', 'purpose', 'reference', 'service'
  ]);
  assert.equal(JSON.stringify(metadata).includes(expected.toString('hex')), false);
  assert.deepEqual(await provider.list({ service: scope.service, connectionId: scope.connectionId,
    accountId: scope.accountId }), [metadata]);

  let borrowed;
  const length = await provider.withSecret({ ...scope, reference: metadata.reference }, bytes => {
    borrowed = bytes;
    assert.deepEqual(bytes, expected);
    return bytes.byteLength;
  });
  assert.equal(length, expected.byteLength);
  assert.ok(borrowed.every(byte => byte === 0), 'the callback copy must be zeroed after use');

  await assert.rejects(provider.withSecret({ ...scope, purpose: 'username', reference: metadata.reference }, () => {}),
    /Secret storage operation failed\./);
  await assert.rejects(provider.withSecret({ ...scope, reference: metadata.reference, unexpected: true }, () => {}),
    /Secret storage operation failed\./);

  await provider.delete({ ...scope, reference: metadata.reference });
  assert.deepEqual(await provider.list({ service: scope.service, connectionId: scope.connectionId,
    accountId: scope.accountId }), []);
  await assert.rejects(provider.withSecret({ ...scope, reference: metadata.reference }, () => {}),
    /Secret storage operation failed\./);
  expected.fill(0);
});

test('callback failures and unknown fields never escape secret-bearing text', async () => {
  const provider = new SyntheticSecretProvider();
  const value = randomBytes(32);
  const marker = value.toString('base64url');
  const metadata = await provider.put({ ...scope, value });
  value.fill(0);

  let error;
  try {
    await provider.withSecret({ ...scope, reference: metadata.reference }, () => {
      throw new Error(marker);
    });
  } catch (caught) { error = caught; }
  assert.equal(error?.message, 'Secret callback failed.');
  assert.equal(String(error?.stack).includes(marker), false);
  await assert.rejects(provider.put({ ...scope, value: randomBytes(8), extra: marker }),
    /Secret storage operation failed\./);
  await provider.delete({ ...scope, reference: metadata.reference });
});
