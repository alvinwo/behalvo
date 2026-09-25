import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { PassThrough, Writable } from 'node:stream';
import { createNativeHostManifest, encodeNativeMessage, NativeHostBoundary, NativeMessageReader,
  NativeMessagingTransport, readNativeMessage, writeNativeMessage } from '../dist/index.js';

const epoch = { profileId: 'profile-a', connectionGeneration: 2, epoch: 'a'.repeat(64),
  serviceGeneration: 'service-a', allowedOrigin: 'http://127.0.0.1:43117' };

function calendarSnapshot() {
  return { state: 'calendar', contractVersion: 1, location: 'Beijing', timeZone: 'Asia/Shanghai',
    startDate: '2026-12-15', endDate: '2027-01-31', identityDigest: '1'.repeat(64),
    subjectDigest: '2'.repeat(64), rosterDigest: '3'.repeat(64), termsDigest: '4'.repeat(64),
    termsVersion: 'terms-1', appointmentAbsent: true, page: 1, hasNext: false, candidates: [] };
}

function request(sequence = 1, extra = {}) {
  return { protocolVersion: 1, kind: 'inspect', requestId: `request-${sequence}`, profileId: epoch.profileId,
    connectionGeneration: epoch.connectionGeneration, epoch: epoch.epoch,
    serviceGeneration: epoch.serviceGeneration, origin: epoch.allowedOrigin, tabId: 7, sequence,
    expectedPageState: 'calendar', ...extra };
}

function response(input) {
  return { protocolVersion: 1, kind: 'result', requestId: input.requestId, profileId: input.profileId,
    connectionGeneration: input.connectionGeneration, epoch: input.epoch,
    serviceGeneration: input.serviceGeneration, origin: input.origin, tabId: input.tabId,
    sequence: input.sequence, documentId: 'document-a', pageState: 'calendar',
    snapshot: calendarSnapshot() };
}

function controlResponse(input, kind) {
  return { protocolVersion: 1, kind, controlId: input.controlId, profileId: input.profileId,
    connectionGeneration: input.connectionGeneration, epoch: input.epoch,
    serviceGeneration: input.serviceGeneration, origin: input.origin, tabId: input.tabId };
}

function preparedResponse(input) {
  return { ...response(input), kind: 'gesture.prepared' };
}

function assertGestureOperation(actual, expected) {
  const { operationId, operationExpiresAt, ...requestFields } = actual;
  assert.deepEqual(requestFields, expected);
  assert.match(operationId, /^[A-Za-z0-9._:-]{1,128}$/);
  const remaining = operationExpiresAt - (performance.timeOrigin + performance.now());
  assert.ok(remaining >= 1 && remaining <= 60_000);
  return operationId;
}

test('native messaging reads a message across arbitrary backpressure-safe chunks', async () => {
  const encoded = encodeNativeMessage({ kind: 'synthetic', value: 7 });
  const input = new PassThrough();
  const pending = readNativeMessage(input);
  input.write(encoded.subarray(0, 2));
  input.write(encoded.subarray(2, 9));
  input.end(encoded.subarray(9));
  assert.deepEqual(await pending, { kind: 'synthetic', value: 7 });
});

test('native messaging rejects truncated, oversized, and trailing frames with fixed safe errors', async () => {
  for (const bytes of [Buffer.from([5, 0]), Buffer.from([5, 0, 0, 0, 123]),
    Buffer.from([255, 255, 255, 127])]) {
    const input = new PassThrough();
    input.end(bytes);
    await assert.rejects(readNativeMessage(input, 64), /native message (framing|size) is invalid/i);
  }
  assert.throws(() => encodeNativeMessage({ value: 'x'.repeat(100) }, 16), /native message size is invalid/i);
  const invalidUtf8 = new PassThrough();
  invalidUtf8.end(Buffer.from([3, 0, 0, 0, 0x22, 0xff, 0x22]));
  await assert.rejects(readNativeMessage(invalidUtf8), /native message framing is invalid/i);
});

test('native messaging waits for a delayed write callback', async () => {
  let callback;
  const chunks = [];
  const output = new Writable({ write(chunk, _encoding, done) { chunks.push(Buffer.from(chunk)); callback = done; } });
  const pending = writeNativeMessage(output, { ok: true });
  let settled = false;
  pending.then(() => { settled = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  callback();
  await pending;
  assert.deepEqual(JSON.parse(Buffer.concat(chunks).subarray(4).toString('utf8')), { ok: true });
});

test('native writer contains callback, destroy, and delayed raw stream errors behind fixed safe failures', () => {
  const moduleUrl = new URL('../dist/browser/native-host.js', import.meta.url).href;
  const cases = [
    `const output = new Writable({write(_c,_e,done){done(new Error('private-callback'));}});
     try { await writeNativeMessage(output,{ok:true}); } catch(error) { console.log(error.message); }
     await new Promise(resolve=>setImmediate(resolve));`,
    `let callback; const output = new Writable({write(_c,_e,done){callback=done;}});
     const pending=writeNativeMessage(output,{ok:true}); output.destroy(new Error('private-destroy'));
     try { await pending; } catch(error) { console.log(error.message); } if(callback) callback();
     await new Promise(resolve=>setImmediate(resolve));`,
    `const output = new Writable({write(_c,_e,done){done();}}); await writeNativeMessage(output,{ok:true});
     output.emit('error',new Error('private-late')); console.log('late error contained');`
  ];
  for (const body of cases) {
    const script = `import { Writable } from 'node:stream'; import { writeNativeMessage } from '${moduleUrl}'; ${body}`;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.doesNotMatch(result.stdout, /private-/);
  }
});

test('native transport bounds a stalled write on timeout and close without unhandled rejection', () => {
  const moduleUrl = new URL('../dist/browser/native-host.js', import.meta.url).href;
  const encodedRequest = JSON.stringify(request(1));
  const cases = [
    `const transport=new NativeMessagingTransport(new PassThrough(),output,32768,10);
     const pending=transport.inspect(${encodedRequest}).then(()=>"resolved",error=>error.message);
     const outcome=await Promise.race([pending,new Promise(resolve=>setTimeout(()=>resolve("still-pending"),60))]);
     console.log(outcome); await transport.close(); if(callback) callback(); await new Promise(resolve=>setImmediate(resolve));`,
    `const transport=new NativeMessagingTransport(new PassThrough(),output,32768,1000);
     const pending=transport.inspect(${encodedRequest}).then(()=>"resolved",error=>error.message);
     await new Promise(resolve=>setImmediate(resolve)); await transport.close();
     const outcome=await Promise.race([pending,new Promise(resolve=>setTimeout(()=>resolve("still-pending"),60))]);
     console.log(outcome); if(callback) callback(); await new Promise(resolve=>setImmediate(resolve));`
  ];
  for (const body of cases) {
    const script = `import { PassThrough, Writable } from 'node:stream';
      import { NativeMessagingTransport } from '${moduleUrl}';
      let callback; const output=new Writable({write(_c,_e,done){callback=done;}}); ${body}`;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.doesNotMatch(result.stdout, /still-pending|private-/);
    assert.match(result.stdout, /timed out|closed/i);
  }
});

test('native host independently rejects wrong binding and replay before dispatch', async () => {
  let dispatches = 0;
  const boundary = new NativeHostBoundary({ epoch, tabId: 7, async dispatch(value) {
    dispatches++;
    return response(value);
  } });
  assert.deepEqual(await boundary.handle(request(1)), response(request(1)));
  for (const invalid of [
    request(2, { origin: 'http://127.0.0.1:43118' }),
    request(2, { tabId: 8 }), request(2, { profileId: 'profile-b' }),
    request(2, { serviceGeneration: 'service-b' }), request(2, { epoch: 'b'.repeat(64) }),
    request(2, { connectionGeneration: 3 }), request(1)
  ]) await assert.rejects(boundary.handle(invalid), /native message binding or replay is invalid/i);
  assert.equal(dispatches, 1);
  assert.deepEqual(await boundary.handle(request(2)), response(request(2)));
  assert.equal(dispatches, 2);
});

test('native host transport sends one framed request and validates the exact framed extension response', async () => {
  const fromExtension = new PassThrough();
  const toExtension = new PassThrough();
  const transport = new NativeMessagingTransport(fromExtension, toExtension);
  const reader = new NativeMessageReader(toExtension);
  const pending = transport.inspect(request(1));
  const activate = await reader.read();
  assert.equal(activate.kind, 'session.activate');
  await writeNativeMessage(fromExtension, controlResponse(activate, 'session.activated'));
  const sent = await reader.read();
  assert.deepEqual(sent, request(1));
  await writeNativeMessage(fromExtension, response(sent));
  assert.deepEqual(await pending, response(request(1)));
  await transport.close();
});

test('native transport reconciles an exact retired epoch without an in-memory binding', async () => {
  const fromExtension = new PassThrough();
  const toExtension = new PassThrough();
  const transport = new NativeMessagingTransport(fromExtension, toExtension);
  const reader = new NativeMessageReader(toExtension);

  const firstPending = transport.reconcileRevocation(epoch, 7);
  const first = await reader.read();
  assert.equal(first.kind, 'session.revoke');
  await writeNativeMessage(fromExtension, controlResponse(first, 'session.revoked'));
  await firstPending;

  const secondPending = transport.reconcileRevocation(epoch, 7);
  const second = await reader.read();
  assert.equal(second.kind, 'session.revoke');
  assert.notEqual(second.controlId, first.controlId);
  await writeNativeMessage(fromExtension, controlResponse(second, 'session.revoked'));
  await secondPending;
  await transport.close();
});

test('native transport activates an exact browser binding and commits a gesture only after final authorization', async () => {
  const fromExtension = new PassThrough();
  const toExtension = new PassThrough();
  const transport = new NativeMessagingTransport(fromExtension, toExtension);
  const reader = new NativeMessageReader(toExtension);
  const gesture = request(1, { kind: 'gesture', command: { kind: 'calendar.next_page' } });
  let finalChecks = 0;
  const pending = transport.gesture(gesture, async () => () => { finalChecks++; });
  const activate = await reader.read();
  assert.equal(activate.kind, 'session.activate');
  await writeNativeMessage(fromExtension, controlResponse(activate, 'session.activated'));
  const operation = await reader.read();
  const operationId = assertGestureOperation(operation, gesture);
  await writeNativeMessage(fromExtension, preparedResponse(operation));
  const commit = await reader.read();
  assert.deepEqual(commit, { ...activate, kind: 'gesture.commit', controlId: commit.controlId,
    requestId: gesture.requestId, sequence: gesture.sequence, operationId });
  assert.equal(finalChecks, 1);
  await writeNativeMessage(fromExtension, response(gesture));
  assert.deepEqual(await pending, response(gesture));
  await transport.close();
});

test('native transport can queue an acknowledged revocation behind a prepared gesture without committing it', async () => {
  const fromExtension = new PassThrough();
  const toExtension = new PassThrough();
  const transport = new NativeMessagingTransport(fromExtension, toExtension);
  const reader = new NativeMessageReader(toExtension);
  const gesture = request(1, { kind: 'gesture', command: { kind: 'calendar.next_page' } });
  const pending = transport.gesture(gesture, async () => { throw new Error('stale epoch'); });
  const activate = await reader.read();
  await writeNativeMessage(fromExtension, controlResponse(activate, 'session.activated'));
  const operation = await reader.read();
  assertGestureOperation(operation, gesture);
  const revoking = transport.revoke(epoch, gesture.tabId);
  const revoke = await reader.read();
  assert.equal(revoke.kind, 'session.revoke');
  await writeNativeMessage(fromExtension, preparedResponse(operation));
  await writeNativeMessage(fromExtension, controlResponse(revoke, 'session.revoked'));
  await assert.rejects(pending, /stale epoch/);
  await revoking;
  await transport.close();
});

test('native transport waits for in-flight activation before sending revocation', async () => {
  const fromExtension = new PassThrough(); const toExtension = new PassThrough();
  const transport = new NativeMessagingTransport(fromExtension, toExtension);
  const reader = new NativeMessageReader(toExtension);
  const gestureRequest = request(1, { kind: 'gesture', command: { kind: 'calendar.next_page' } });
  const gesture = transport.gesture(gestureRequest, async () => { throw new Error('stale epoch'); });
  void gesture.catch(() => {});
  const activate = await reader.read();
  const revoking = transport.revoke(epoch, gestureRequest.tabId);
  void revoking.catch(() => {});
  const nextFrame = reader.read();
  const beforeActivation = await Promise.race([
    nextFrame.then(() => 'sent'),
    new Promise(resolve => setImmediate(() => resolve('blocked')))
  ]);
  assert.equal(beforeActivation, 'blocked');
  await writeNativeMessage(fromExtension, controlResponse(activate, 'session.activated'));
  const first = await nextFrame;
  const operation = first.kind === 'gesture' ? first : undefined;
  const revoke = first.kind === 'session.revoke' ? first : await reader.read();
  if (operation) {
    assert.deepEqual(operation, gestureRequest);
    await writeNativeMessage(fromExtension, preparedResponse(operation));
  }
  assert.equal(revoke.kind, 'session.revoke');
  await writeNativeMessage(fromExtension, controlResponse(revoke, 'session.revoked'));
  await assert.rejects(gesture, /stale epoch|binding/i);
  await revoking;
  await transport.close();
});

test('native transport bounds missing responses and fails closed after EOF without accepting late frames', async () => {
  {
    const fromExtension = new PassThrough(); const toExtension = new PassThrough();
    const transport = new NativeMessagingTransport(fromExtension, toExtension, 32 * 1024, 10);
    const reader = new NativeMessageReader(toExtension);
    const pending = transport.inspect(request(1));
    void pending.catch(() => {});
    assert.equal((await reader.read()).kind, 'session.activate');
    await assert.rejects(pending, /timed out/i);
    await assert.rejects(transport.inspect(request(1)), /unavailable|framing|closed/i);
    await transport.close();
  }
  {
    const fromExtension = new PassThrough(); const toExtension = new PassThrough();
    const transport = new NativeMessagingTransport(fromExtension, toExtension);
    const reader = new NativeMessageReader(toExtension);
    const pending = transport.inspect(request(1));
    void pending.catch(() => {});
    await reader.read();
    fromExtension.end();
    await assert.rejects(pending, /framing/i);
    await assert.rejects(transport.inspect(request(1)), /unavailable|framing|closed/i);
    await transport.close();
  }
});

test('native transport rejects type-coerced control acknowledgements before sending an operation', async () => {
  const fromExtension = new PassThrough(); const toExtension = new PassThrough();
  const transport = new NativeMessagingTransport(fromExtension, toExtension, 32 * 1024, 10);
  const reader = new NativeMessageReader(toExtension);
  const pending = transport.inspect(request(1));
  void pending.catch(() => {});
  const activate = await reader.read();
  await writeNativeMessage(fromExtension, { ...controlResponse(activate, 'session.activated'),
    connectionGeneration: String(activate.connectionGeneration) });
  await assert.rejects(pending, /framing/i);
  await transport.close();
});

test('native transport rejects every pending exchange when one concurrent write fails', async () => {
  const fromExtension = new PassThrough();
  const sent = []; const waiters = [];
  const output = new Writable({ write(chunk, _encoding, done) {
    const frame = Buffer.from(chunk); const length = frame.readUInt32LE(0);
    sent.push(JSON.parse(frame.subarray(4, 4 + length).toString('utf8')));
    waiters.shift()?.();
    if (sent.length === 3) done(new Error('private-concurrent-write')); else done();
  } });
  let cursor = 0;
  const nextSent = async () => {
    if (cursor === sent.length) await new Promise(resolve => waiters.push(resolve));
    return sent[cursor++];
  };
  const transport = new NativeMessagingTransport(fromExtension, output, 32 * 1024, 30);
  const gestureRequest = request(1, { kind: 'gesture', command: { kind: 'calendar.next_page' } });
  const gesture = transport.gesture(gestureRequest, async () => () => {});
  void gesture.catch(() => {});
  const activate = await nextSent();
  await writeNativeMessage(fromExtension, controlResponse(activate, 'session.activated'));
  assertGestureOperation(await nextSent(), gestureRequest);
  const revoking = transport.revoke(epoch, gestureRequest.tabId);
  void revoking.catch(() => {});
  assert.equal((await nextSent()).kind, 'session.revoke');
  const results = await Promise.race([
    Promise.allSettled([gesture, revoking]),
    new Promise(resolve => setTimeout(() => resolve(undefined), 80))
  ]);
  await transport.close();
  assert.ok(results, 'all pending exchanges must reject immediately after a write failure');
  for (const result of results) {
    assert.equal(result.status, 'rejected');
    assert.match(result.reason.message, /native message framing is invalid/i);
    assert.doesNotMatch(result.reason.message, /private-/);
  }
});

test('native host manifest binds one extension to an absolute executable path', () => {
  const extensionId = 'a'.repeat(32);
  assert.deepEqual(createNativeHostManifest({ executablePath: '/opt/behalvo/native-host', extensionId }), {
    name: 'com.behalvo.synthetic_browser', description: 'Behalvo local synthetic browser boundary',
    path: '/opt/behalvo/native-host', type: 'stdio', allowed_origins: [`chrome-extension://${extensionId}/`]
  });
  assert.throws(() => createNativeHostManifest({ executablePath: 'relative/native-host', extensionId }),
    /native host manifest/i);
});
