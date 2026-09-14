import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { PayloadCipher } from '../dist/storage/payload-cipher.js';
import {
  MODEL_STATE_LIMITS,
  ModelStateCodec,
  ModelStateError,
  copyModelStateKey,
  validModelStateIdentifier
} from '../dist/storage/model-state-codec.js';

const KEY = Buffer.alloc(32, 7);
const ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CONTEXT = ['behalvo/private-model-state/v1', 'pi-credentials', 1];
const UNAVAILABLE = 'Private model state is unavailable.';
const UPDATE = 'Private model state update failed.';

function assertSafeError(message) {
  return error => {
    assert.equal(error.message, message);
    assert.equal(error.cause, undefined);
    return true;
  };
}

function validDocument(plaintext = '{}') {
  const payload = new PayloadCipher(KEY, ID).seal(plaintext, CONTEXT);
  return { format: 'behalvo-private-model-state', version: 1,
    purpose: 'pi-credentials', documentId: ID, payload };
}

function mutateInner(document, field) {
  const inner = JSON.parse(document.payload);
  const bytes = Buffer.from(inner[field], 'base64');
  bytes[0] ^= 1;
  return { ...document, payload: JSON.stringify({ ...inner, [field]: bytes.toString('base64') }) };
}

test('model-state ciphertext binds purpose and ID while preserving key capture', () => {
  const callerKey = Buffer.alloc(32, 7);
  const recoveryKey = Buffer.from(callerKey);
  const codec = new ModelStateCodec(callerKey, 'pi-credentials');
  callerKey.fill(0);
  const plaintext = '{"synthetic-provider":{"type":"api_key","key":"secret-canary"}}';
  const first = codec.seal(plaintext);
  const second = codec.seal(plaintext, first.documentId);
  assert.equal(codec.open(first.bytes).plaintext, plaintext);
  assert.notDeepEqual(first.bytes, second.bytes);
  assert.equal(first.bytes.includes(Buffer.from('secret-canary')), false);
  assert.throws(() => new ModelStateCodec(recoveryKey, 'model-settings').open(first.bytes), assertSafeError(UNAVAILABLE));
  const changed = JSON.parse(first.bytes.toString('utf8'));
  changed.documentId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  assert.throws(() => codec.open(Buffer.from(JSON.stringify(changed))), assertSafeError(UNAVAILABLE));
  assert.equal(new ModelStateCodec(recoveryKey, 'pi-credentials').open(first.bytes).plaintext, plaintext);
});

test('model-state codec rejects malformed outer and authenticated inner envelopes safely', () => {
  const codec = new ModelStateCodec(KEY, 'pi-credentials');
  const valid = validDocument();
  const malformed = [
    Buffer.from('{'),
    Buffer.from('null'),
    Buffer.from('[]'),
    Buffer.from([0xff]),
    Buffer.from(JSON.stringify({ ...valid, payload: undefined })),
    Buffer.from(JSON.stringify({ ...valid, payload: 1 })),
    Buffer.from(JSON.stringify({ ...valid, extra: true })),
    Buffer.from(JSON.stringify({ ...valid, format: 'other' })),
    Buffer.from(JSON.stringify({ ...valid, version: 2 })),
    Buffer.from(JSON.stringify({ ...valid, purpose: 'model-settings' })),
    Buffer.from(JSON.stringify({ ...valid, documentId: ID.toUpperCase() })),
    Buffer.from(JSON.stringify({ ...valid, documentId: 'aaaaaaaa-aaaa-1aaa-8aaa-aaaaaaaaaaaa' })),
    Buffer.from(JSON.stringify(mutateInner(valid, 'iv'))),
    Buffer.from(JSON.stringify(mutateInner(valid, 'tag'))),
    Buffer.from(JSON.stringify(mutateInner(valid, 'data'))),
    new ModelStateCodec(randomBytes(32), 'pi-credentials').seal('{}', ID).bytes,
    Buffer.alloc(MODEL_STATE_LIMITS.outerBytes + 1, 0x20)
  ];
  for (const bytes of malformed)
    assert.throws(() => codec.open(bytes), assertSafeError(UNAVAILABLE));
});

test('model-state codec accepts exact bounds and preserves a leading BOM inside plaintext', () => {
  const codec = new ModelStateCodec(KEY, 'pi-credentials');
  const plaintext = '\uFEFF' + 'a'.repeat(MODEL_STATE_LIMITS.plaintextBytes - 3);
  assert.equal(Buffer.byteLength(plaintext), MODEL_STATE_LIMITS.plaintextBytes);
  const sealed = codec.seal(plaintext, ID);
  assert.equal(codec.open(sealed.bytes).plaintext, plaintext);

  const padding = MODEL_STATE_LIMITS.outerBytes - sealed.bytes.byteLength;
  const exactOuter = Buffer.concat([sealed.bytes, Buffer.alloc(padding, 0x20)]);
  assert.equal(exactOuter.byteLength, MODEL_STATE_LIMITS.outerBytes);
  assert.equal(codec.open(exactOuter).plaintext, plaintext);
  assert.throws(() => codec.seal(`${plaintext}x`, ID), assertSafeError(UPDATE));
  assert.equal(codec.open(codec.seal('arbitrary non-JSON plaintext', ID).bytes).plaintext,
    'arbitrary non-JSON plaintext');
});

test('model-state codec rejects authenticated plaintext over the limit on open', () => {
  const plaintext = 'a'.repeat(MODEL_STATE_LIMITS.plaintextBytes + 1);
  const document = validDocument(plaintext);
  assert.throws(
    () => new ModelStateCodec(KEY, 'pi-credentials').open(Buffer.from(JSON.stringify(document))),
    assertSafeError(UNAVAILABLE)
  );
});

test('model-state key and identifier helpers reject ambiguous inputs', () => {
  const caller = Buffer.alloc(32, 9);
  const copied = copyModelStateKey(caller);
  caller.fill(0);
  assert.deepEqual(Buffer.from(copied), Buffer.alloc(32, 9));
  assert.notEqual(copied, caller);
  for (const key of [Buffer.alloc(31), new Uint8Array(33), 'not-bytes', undefined])
    assert.throws(() => copyModelStateKey(key), assertSafeError('Invalid private model state configuration.'));

  assert.equal(validModelStateIdentifier('synthetic'), true);
  assert.equal(validModelStateIdentifier('x'.repeat(512)), true);
  for (const value of ['', 'x'.repeat(513), 'line\nfeed', 'delete\x7f', 1, null])
    assert.equal(validModelStateIdentifier(value), false);
  for (const [code, message] of [
    ['configuration', 'Invalid private model state configuration.'],
    ['key', 'Private model state key is unavailable.'],
    ['unavailable', 'Private model state is unavailable.'],
    ['busy', 'Private model state is busy.'],
    ['cancelled', 'Private model state operation cancelled.'],
    ['update', 'Private model state update failed.']
  ]) {
    const error = new ModelStateError(code);
    assert.equal(error.code, code);
    assert.equal(error.message, message);
    assert.equal(error.cause, undefined);
  }
  assert.throws(() => new ModelStateCodec(KEY, 'invalid-purpose'),
    assertSafeError('Invalid private model state configuration.'));
  assert.throws(() => new ModelStateCodec(KEY, 'pi-credentials').seal('{}', ID.toUpperCase()),
    assertSafeError(UPDATE));
});
