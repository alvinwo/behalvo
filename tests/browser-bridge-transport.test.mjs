import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import {
  BridgeIpcReader,
  createBridgeBrowserTransport,
  writeBridgeIpcMessage
} from '../dist/index.js';

const channelId = 'C'.repeat(43);
const epoch = {
  profileId: 'profile-a',
  connectionGeneration: 2,
  epoch: 'a'.repeat(64),
  serviceGeneration: 'service-a',
  allowedOrigin: 'http://127.0.0.1:43117'
};

function calendarSnapshot() {
  return {
    state: 'calendar',
    contractVersion: 1,
    location: 'Beijing',
    timeZone: 'Asia/Shanghai',
    startDate: '2026-12-15',
    endDate: '2027-01-31',
    identityDigest: '1'.repeat(64),
    subjectDigest: '2'.repeat(64),
    rosterDigest: '3'.repeat(64),
    termsDigest: '4'.repeat(64),
    termsVersion: 'terms-1',
    appointmentAbsent: true,
    page: 1,
    hasNext: false,
    candidates: []
  };
}

function request(sequence = 1) {
  return {
    protocolVersion: 1,
    kind: 'inspect',
    requestId: `request-${sequence}`,
    profileId: epoch.profileId,
    connectionGeneration: epoch.connectionGeneration,
    epoch: epoch.epoch,
    serviceGeneration: epoch.serviceGeneration,
    origin: epoch.allowedOrigin,
    tabId: 7,
    sequence,
    expectedPageState: 'calendar'
  };
}

function controlResponse(input, kind) {
  return {
    protocolVersion: 1,
    kind,
    controlId: input.controlId,
    profileId: input.profileId,
    connectionGeneration: input.connectionGeneration,
    epoch: input.epoch,
    serviceGeneration: input.serviceGeneration,
    origin: input.origin,
    tabId: input.tabId
  };
}

function response(input) {
  return {
    protocolVersion: 1,
    kind: 'result',
    requestId: input.requestId,
    profileId: input.profileId,
    connectionGeneration: input.connectionGeneration,
    epoch: input.epoch,
    serviceGeneration: input.serviceGeneration,
    origin: input.origin,
    tabId: input.tabId,
    sequence: input.sequence,
    documentId: 'document-a',
    pageState: 'calendar',
    snapshot: calendarSnapshot()
  };
}

function fixture() {
  const inbound = new PassThrough();
  const outbound = new PassThrough();
  const reader = new BridgeIpcReader(inbound);
  let closed = 0;
  const transport = createBridgeBrowserTransport({
    reader,
    output: outbound,
    channelId,
    closeChannel() {
      closed++;
      inbound.end();
      outbound.end();
    }
  });
  return { inbound, outbound, transport, get closed() { return closed; } };
}

async function writeEnvelope(input, message, id = channelId) {
  await writeBridgeIpcMessage(input, {
    bridgeVersion: 1,
    kind: 'browser.frame',
    channelId: id,
    message
  });
}

test('bridge browser transport preserves NativeMessagingTransport semantics through one enrolled envelope', async () => {
  const bridge = fixture();
  const peer = new BridgeIpcReader(bridge.outbound);
  const pending = bridge.transport.inspect(request());

  const activation = await peer.read();
  assert.deepEqual(Object.keys(activation).sort(), ['bridgeVersion', 'channelId', 'kind', 'message'].sort());
  assert.equal(activation.channelId, channelId);
  assert.equal(activation.message.kind, 'session.activate');
  await writeEnvelope(bridge.inbound, controlResponse(activation.message, 'session.activated'));

  const operation = await peer.read();
  assert.equal(operation.channelId, channelId);
  assert.deepEqual(operation.message, request());
  await writeEnvelope(bridge.inbound, response(operation.message));

  assert.deepEqual(await pending, response(request()));
  await bridge.transport.close();
  await bridge.transport.completion;
  assert.equal(bridge.closed, 1);
});

test('wrong enrolled channel fails stop the adapter and rejects current and later browser work', async () => {
  const bridge = fixture();
  const peer = new BridgeIpcReader(bridge.outbound);
  const pending = bridge.transport.inspect(request());
  void pending.catch(() => {});
  const activation = await peer.read();

  await writeEnvelope(bridge.inbound, controlResponse(activation.message, 'session.activated'), 'D'.repeat(43));
  await assert.rejects(pending, /bridge|framing|unavailable|closed/i);
  await assert.rejects(bridge.transport.completion, /Bridge IPC channel failed\./);
  await assert.rejects(bridge.transport.inspect(request()), /bridge|framing|unavailable|closed/i);
  assert.equal(bridge.closed, 1);
});

test('clean peer EOF is channel loss until the owner explicitly closes the adapter', async () => {
  const bridge = fixture();
  bridge.inbound.end();
  await assert.rejects(bridge.transport.completion, /Bridge IPC channel failed\./);
  await assert.rejects(bridge.transport.inspect(request()), /bridge|framing|unavailable|closed/i);
  assert.equal(bridge.closed, 1);
});
