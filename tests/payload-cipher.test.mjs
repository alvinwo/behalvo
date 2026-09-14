import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

const DATABASE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_DATABASE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CONTEXT = ['artifact', 'body', 'personal', 'artifact-1'];

async function cipherApi() {
  return import('../dist/storage/payload-cipher.js');
}

function replaceByte(base64) {
  const bytes = Buffer.from(base64, 'base64');
  bytes[0] ^= 1;
  return bytes.toString('base64');
}

test('PayloadCipher round trips randomized Unicode text with fresh authenticated envelopes', async () => {
  const { PayloadCipher } = await cipherApi();
  const callerKey = randomBytes(32);
  const retainedKey = Buffer.from(callerKey);
  const cipher = new PayloadCipher(callerKey, DATABASE_ID);
  callerKey.fill(0);
  const plaintext = `synthetic private text 你好 ${randomBytes(24).toString('hex')}`;

  const first = cipher.seal(plaintext, CONTEXT);
  const second = cipher.seal(plaintext, CONTEXT);

  assert.equal(cipher.open(first, CONTEXT), plaintext);
  assert.equal(new PayloadCipher(retainedKey, DATABASE_ID).open(first, CONTEXT), plaintext);
  assert.equal(cipher.open(second, CONTEXT), plaintext);
  assert.notEqual(second, first);
  assert.deepEqual(Object.keys(JSON.parse(first)), ['v', 'iv', 'tag', 'data']);
});

test('PayloadCipher preserves a leading Unicode BOM in authenticated plaintext', async () => {
  const { PayloadCipher } = await cipherApi();
  const cipher = new PayloadCipher(randomBytes(32), DATABASE_ID);
  const plaintext = '\uFEFFsynthetic text';

  assert.equal(cipher.open(cipher.seal(plaintext, CONTEXT), CONTEXT), plaintext);
});

test('PayloadCipher rejects lone UTF-16 surrogates without changing valid Unicode', async t => {
  const { PayloadCipher } = await cipherApi();
  const cipher = new PayloadCipher(randomBytes(32), DATABASE_ID);
  for (const [name, plaintext] of [
    ['high surrogate', 'synthetic-\uD800'],
    ['low surrogate', 'synthetic-\uDC00'],
    ['high surrogate before text', '\uD800synthetic'],
    ['reversed surrogate pair', '\uDC00\uD800']
  ]) await t.test(name, () => {
    assert.throws(() => cipher.seal(plaintext, CONTEXT), { message: 'Unable to seal encrypted payload.' });
  });
  const plaintext = '\uFEFFsynthetic-你好-\uD83D\uDE80';
  assert.equal(cipher.open(cipher.seal(plaintext, CONTEXT), CONTEXT), plaintext);
});

test('PayloadCipher rejects wrong keys and substitutions in every AAD identity dimension', async () => {
  const { PayloadCipher } = await cipherApi();
  const key = randomBytes(32);
  const cipher = new PayloadCipher(key, DATABASE_ID);
  const sealed = cipher.seal('synthetic private text', CONTEXT);

  assert.throws(() => new PayloadCipher(randomBytes(32), DATABASE_ID).open(sealed, CONTEXT));
  assert.throws(() => new PayloadCipher(key, OTHER_DATABASE_ID).open(sealed, CONTEXT));
  for (const substitute of [
    ['journal', 'body', 'personal', 'artifact-1'],
    ['artifact', 'metadata', 'personal', 'artifact-1'],
    ['artifact', 'body', 'business', 'artifact-1'],
    ['artifact', 'body', 'personal', 'artifact-2']
  ]) {
    assert.throws(() => cipher.open(sealed, substitute));
  }
});

test('PayloadCipher rejects tampered IV, authentication tag, and ciphertext', async () => {
  const { PayloadCipher } = await cipherApi();
  const cipher = new PayloadCipher(randomBytes(32), DATABASE_ID);
  const envelope = JSON.parse(cipher.seal('synthetic private text', CONTEXT));

  for (const field of ['iv', 'tag', 'data']) {
    const tampered = { ...envelope, [field]: replaceByte(envelope[field]) };
    assert.throws(() => cipher.open(JSON.stringify(tampered), CONTEXT));
  }
});

test('PayloadCipher strictly rejects malformed and unsupported envelopes', async () => {
  const { PayloadCipher } = await cipherApi();
  const cipher = new PayloadCipher(randomBytes(32), DATABASE_ID);
  const valid = JSON.parse(cipher.seal('', CONTEXT));
  const malformed = [
    '',
    'null',
    '[]',
    '{',
    JSON.stringify({ ...valid, extra: true }),
    JSON.stringify({ ...valid, v: 2 }),
    JSON.stringify({ ...valid, iv: Buffer.alloc(11).toString('base64') }),
    JSON.stringify({ ...valid, tag: Buffer.alloc(15).toString('base64') }),
    JSON.stringify({ ...valid, data: '*' }),
    JSON.stringify({ ...valid, data: 'YQ' }),
    JSON.stringify({ ...valid, data: 1 })
  ];

  for (const value of malformed)
    assert.throws(() => cipher.open(value, CONTEXT));
});

test('PayloadCipher validates constructor and context inputs without exposing secrets', async () => {
  const { PayloadCipher } = await cipherApi();
  const secret = 'synthetic-secret-marker';

  for (const make of [
    () => new PayloadCipher(randomBytes(31), DATABASE_ID),
    () => new PayloadCipher(randomBytes(32), 'not-a-database-uuid'),
    () => new PayloadCipher(randomBytes(32), DATABASE_ID).seal(secret, ['artifact', Number.NaN]),
    () => new PayloadCipher(randomBytes(32), DATABASE_ID).open(secret, CONTEXT)
  ]) {
    assert.throws(make, error => {
      assert.equal(error.message.includes(secret), false);
      assert.equal(error.cause, undefined);
      return true;
    });
  }
});

test('PayloadCipher lookup tokens are stable and separated by purpose, workspace, and values', async () => {
  const { PayloadCipher } = await cipherApi();
  const cipher = new PayloadCipher(randomBytes(32), DATABASE_ID);
  const token = cipher.lookup('inbox/source', 'personal', ['relay:synthetic', 'delivery-1']);

  assert.equal(cipher.lookup('inbox/source', 'personal', ['relay:synthetic', 'delivery-1']), token);
  assert.notEqual(cipher.lookup('inbox/fingerprint', 'personal', ['relay:synthetic', 'delivery-1']), token);
  assert.notEqual(cipher.lookup('inbox/source', 'business', ['relay:synthetic', 'delivery-1']), token);
  assert.notEqual(cipher.lookup('inbox/source', 'personal', ['relay:synthetic', 'delivery-2']), token);
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
});
