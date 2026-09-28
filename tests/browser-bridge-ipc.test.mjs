import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';
import {
  BridgeEnrollmentGate,
  BridgeIpcReader,
  encodeBridgeIpcMessage,
  MAX_BRIDGE_IPC_BYTES,
  parseBridgeFrameEnvelope,
  SYNTHETIC_PORTAL_ORIGIN,
  writeBridgeIpcMessage
} from '../dist/index.js';

const capability = 'A'.repeat(43);
const enrollment = 'B'.repeat(43);
const extensionId = 'a'.repeat(32);
const extensionOrigin = `chrome-extension://${extensionId}/`;
const expected = {
  installationId: 'installation-a',
  runId: 'run-a',
  serviceGeneration: 'service-generation-a',
  extensionOrigin,
  capability,
  enrollment,
  expiresAt: Date.now() + 60_000
};

function hello(overrides = {}) {
  return {
    bridgeVersion: 1,
    kind: 'bridge.enroll',
    installationId: 'installation-a',
    runId: 'run-a',
    serviceGeneration: 'service-generation-a',
    extensionOrigin,
    capability,
    enrollment,
    tabId: 7,
    origin: SYNTHETIC_PORTAL_ORIGIN,
    ...overrides
  };
}

test('enrollment gate binds the complete run identity and consumes one successful channel exactly once', () => {
  const gate = new BridgeEnrollmentGate(expected);
  const accepted = gate.accept(hello());
  assert.match(accepted.channelId, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(accepted.tabId, 7);
  assert.equal(accepted.origin, SYNTHETIC_PORTAL_ORIGIN);
  assert.equal(gate.consumed, true);
  assert.throws(() => gate.accept(hello()), /Bridge IPC enrollment rejected\./);
  gate.close();
});

test('invalid enrollment attempts fail closed without consuming the valid one', () => {
  const mutations = [
    { installationId: 'installation-b' },
    { runId: 'run-b' },
    { serviceGeneration: 'service-generation-b' },
    { extensionOrigin: `chrome-extension://${'b'.repeat(32)}/` },
    { capability: 'C'.repeat(43) },
    { enrollment: 'D'.repeat(43) },
    { tabId: 0 },
    { tabId: '7' },
    { origin: 'http://127.0.0.1:43118' },
    { extra: true }
  ];
  const gate = new BridgeEnrollmentGate(expected);
  for (const mutation of mutations) {
    assert.throws(() => gate.accept(hello(mutation)), /Bridge IPC enrollment rejected\./);
    assert.equal(gate.consumed, false);
  }
  assert.equal(gate.accept(hello()).tabId, 7);
  assert.equal(gate.consumed, true);
});

test('expired or closed enrollment never accepts a channel and exposes no input in errors', () => {
  const expired = new BridgeEnrollmentGate({ ...expected, expiresAt: Date.now() - 1 });
  assert.throws(() => expired.accept(hello()), error => {
    assert.equal(error.message, 'Bridge IPC enrollment rejected.');
    assert.doesNotMatch(error.message, /AAAA|BBBB|installation|run-a/);
    return true;
  });
  const closed = new BridgeEnrollmentGate(expected);
  closed.close();
  assert.throws(() => closed.accept(hello()), /Bridge IPC enrollment rejected\./);
});

test('one IPC reader preserves coalesced frames and enforces the 64 KiB outer framing bound', async () => {
  assert.equal(MAX_BRIDGE_IPC_BYTES, 64 * 1024);
  const channelId = 'C'.repeat(43);
  const first = { bridgeVersion: 1, kind: 'browser.frame', channelId,
    message: { protocolVersion: 1, kind: 'recognize' } };
  const second = { bridgeVersion: 1, kind: 'browser.frame', channelId,
    message: { protocolVersion: 1, kind: 'result' } };
  const input = new PassThrough();
  const reader = new BridgeIpcReader(input);
  input.end(Buffer.concat([encodeBridgeIpcMessage(first), encodeBridgeIpcMessage(second)]));
  assert.deepEqual(await reader.read(), first);
  assert.deepEqual(await reader.read(), second);
  assert.equal(await reader.read(), undefined);

  assert.throws(() => encodeBridgeIpcMessage({ data: 'x'.repeat(MAX_BRIDGE_IPC_BYTES) }),
    /Bridge IPC framing failed\./);
});

test('IPC reader rejects invalid UTF-8, truncation, and declared overflow with one fixed error', async () => {
  const cases = [];
  const invalidUtf8 = Buffer.alloc(6);
  invalidUtf8.writeUInt32LE(2, 0);
  invalidUtf8[4] = 0xc3; invalidUtf8[5] = 0x28;
  cases.push(invalidUtf8);

  const truncated = Buffer.alloc(7);
  truncated.writeUInt32LE(8, 0);
  Buffer.from('{"x').copy(truncated, 4);
  cases.push(truncated);

  const overflow = Buffer.alloc(4);
  overflow.writeUInt32LE(MAX_BRIDGE_IPC_BYTES + 1, 0);
  cases.push(overflow);

  for (const bytes of cases) {
    const input = new PassThrough();
    const reader = new BridgeIpcReader(input);
    input.end(bytes);
    await assert.rejects(reader.read(), error => {
      assert.equal(error.message, 'Bridge IPC framing failed.');
      return true;
    });
  }
});

test('browser frame envelope enforces exact channel and preserves the existing 32 KiB message ceiling', () => {
  const channelId = 'C'.repeat(43);
  const message = { protocolVersion: 1, kind: 'recognize', requestId: 'request-a' };
  assert.deepEqual(parseBridgeFrameEnvelope({
    bridgeVersion: 1, kind: 'browser.frame', channelId, message
  }, channelId), { bridgeVersion: 1, kind: 'browser.frame', channelId, message });

  for (const invalid of [
    { bridgeVersion: 1, kind: 'browser.frame', channelId: 'D'.repeat(43), message },
    { bridgeVersion: 1, kind: 'browser.frame', channelId, message, extra: true },
    { bridgeVersion: '1', kind: 'browser.frame', channelId, message },
    { bridgeVersion: 1, kind: 'wrong', channelId, message },
    { bridgeVersion: 1, kind: 'browser.frame', channelId, message: 'not-an-object' }
  ]) assert.throws(() => parseBridgeFrameEnvelope(invalid, channelId), /Bridge IPC framing failed\./);

  assert.throws(() => parseBridgeFrameEnvelope({
    bridgeVersion: 1, kind: 'browser.frame', channelId,
    message: { kind: 'result', value: 'x'.repeat(33 * 1024) }
  }, channelId), /Bridge IPC framing failed\./);
});

test('IPC writer reports a broken output as a fixed framing failure', async () => {
  const output = new Writable({ write(_chunk, _encoding, callback) { callback(new Error('secret broken pipe')); } });
  await assert.rejects(writeBridgeIpcMessage(output, { bridgeVersion: 1, kind: 'test' }), error => {
    assert.equal(error.message, 'Bridge IPC framing failed.');
    assert.doesNotMatch(error.message, /secret broken pipe/);
    return true;
  });
});
