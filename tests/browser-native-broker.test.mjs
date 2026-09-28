import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync
} from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BridgeIpcReader,
  NativeMessageReader,
  NATIVE_HOST_NAME,
  SYNTHETIC_PORTAL_ORIGIN,
  finalizeChromeBridgeInstallation,
  stageChromeBridgeInstallation,
  writeBridgeIpcMessage,
  writeNativeMessage
} from '../dist/index.js';

const posix = process.platform !== 'win32' && typeof process.geteuid === 'function';
const extensionId = 'a'.repeat(32);
const extensionOrigin = `chrome-extension://${extensionId}/`;
const capability = 'A'.repeat(43);
const enrollment = 'B'.repeat(43);
const channelId = 'C'.repeat(43);

function timeout(promise, label, ms = 7_000) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timeout`)), ms); })
  ]);
}

function privateDir(parent, name) {
  const path = join(parent, name);
  mkdirSync(path, { mode: 0o700 });
  chmodSync(path, 0o700);
  return path;
}

function configuredInstallation(t) {
  const temp = mkdtempSync(join(tmpdir(), 'behalvo-native-broker-'));
  chmodSync(temp, 0o700);
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const root = privateDir(temp, 'install');
  const registrationDirectory = privateDir(temp, 'registration');
  const chromePath = join(temp, 'chrome');
  writeFileSync(chromePath, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  chmodSync(chromePath, 0o700);
  const staged = stageChromeBridgeInstallation({
    root,
    packageRoot: process.cwd(),
    chromePath,
    nodePath: process.execPath,
    registrationDirectory
  });
  const installation = finalizeChromeBridgeInstallation({ root, extensionId });
  assert.equal(installation.registrationPath, join(registrationDirectory, `${NATIVE_HOST_NAME}.json`));
  return { temp, root, staged, installation };
}

async function runtimeFixture(t, installation) {
  const runtimeDirectory = privateDir(installation.root, 'runtime');
  const socketPath = join(runtimeDirectory, 'bridge.sock');
  const descriptorPath = join(runtimeDirectory, 'bridge-run.json');
  const descriptor = {
    version: 1,
    installationId: installation.installationId,
    runId: 'run-a',
    serviceGeneration: 'service-generation-a',
    socketPath,
    capability,
    expiresAt: Date.now() + 60_000
  };
  writeFileSync(descriptorPath, JSON.stringify(descriptor) + '\n', { mode: 0o600 });

  let resolveSocket, rejectSocket;
  const socketPromise = new Promise((resolve, reject) => { resolveSocket = resolve; rejectSocket = reject; });
  const server = createServer(socket => resolveSocket(socket));
  server.on('error', rejectSocket);
  await timeout(new Promise((resolve, reject) => {
    server.listen(socketPath, () => resolve());
    server.once('error', reject);
  }), 'socket listen');
  chmodSync(socketPath, 0o600);
  t.after(() => { try { server.close(); } catch {} });
  return { runtimeDirectory, socketPath, descriptorPath, descriptor, server, socketPromise };
}

function launch(installation, origin = extensionOrigin, extra = []) {
  const child = spawn(installation.launcherPath, [origin, ...extra], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { stderr += chunk; });
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  return { child, exited, stderr: () => stderr };
}

function enrollmentMessage(overrides = {}) {
  return {
    bridgeVersion: 1,
    kind: 'bridge.enroll',
    enrollment,
    tabId: 7,
    origin: SYNTHETIC_PORTAL_ORIGIN,
    ...overrides
  };
}

function serviceMessage(kind = 'session.activate') {
  return {
    protocolVersion: 1,
    kind,
    controlId: 'control-a',
    profileId: 'profile-a',
    connectionGeneration: 1,
    epoch: 'd'.repeat(64),
    serviceGeneration: 'service-generation-a',
    origin: SYNTHETIC_PORTAL_ORIGIN,
    tabId: 7
  };
}

test('actual installed launcher forwards Chrome origin and broker relays one enrolled channel bidirectionally',
  { skip: !posix }, async t => {
    const { installation } = configuredInstallation(t);
    assert.match(readFileSync(installation.launcherPath, 'utf8'), /"\$@"/);
    const runtime = await runtimeFixture(t, installation);
    const running = launch(installation);
    t.after(() => running.child.kill());

    const nativeReader = new NativeMessageReader(running.child.stdout);
    await writeNativeMessage(running.child.stdin, enrollmentMessage());
    const socket = await timeout(runtime.socketPromise, 'broker connect');
    const ipcReader = new BridgeIpcReader(socket);
    const hello = await timeout(ipcReader.read(), 'IPC hello');
    assert.deepEqual(hello, {
      bridgeVersion: 1,
      kind: 'bridge.enroll',
      installationId: installation.installationId,
      runId: 'run-a',
      serviceGeneration: 'service-generation-a',
      extensionOrigin,
      capability,
      enrollment,
      tabId: 7,
      origin: SYNTHETIC_PORTAL_ORIGIN
    });

    await writeBridgeIpcMessage(socket, {
      bridgeVersion: 1,
      kind: 'bridge.enrollment.accepted',
      channelId,
      tabId: 7,
      origin: SYNTHETIC_PORTAL_ORIGIN
    });
    assert.deepEqual(await timeout(nativeReader.read(), 'native enrollment ack'), {
      bridgeVersion: 1,
      kind: 'bridge.enrollment.accepted',
      tabId: 7,
      origin: SYNTHETIC_PORTAL_ORIGIN
    });

    const outbound = serviceMessage();
    await writeBridgeIpcMessage(socket, { bridgeVersion: 1, kind: 'browser.frame', channelId, message: outbound });
    assert.deepEqual(await timeout(nativeReader.read(), 'service to Chrome frame'), outbound);

    const inbound = { ...outbound, kind: 'session.activated' };
    await writeNativeMessage(running.child.stdin, inbound);
    assert.deepEqual(await timeout(ipcReader.read(), 'Chrome to service frame'), {
      bridgeVersion: 1,
      kind: 'browser.frame',
      channelId,
      message: inbound
    });

    running.child.stdin.end();
    const exit = await timeout(running.exited, 'broker exit');
    assert.equal(exit.code, 0, running.stderr());
    assert.equal(running.stderr(), '');
    socket.destroy();
    runtime.server.close();
  });

test('broker rejects wrong or extra Chrome invocation arguments before IPC and never echoes them',
  { skip: !posix }, async t => {
    const { installation } = configuredInstallation(t);
    for (const args of [
      [`chrome-extension://${'b'.repeat(32)}/`],
      [extensionOrigin, 'unexpected-extra']
    ]) {
      const child = spawn(installation.launcherPath, args, { stdio: ['pipe', 'pipe', 'pipe'] });
      let stderr = '', stdout = '';
      child.stderr.setEncoding('utf8'); child.stderr.on('data', chunk => { stderr += chunk; });
      child.stdout.on('data', chunk => { stdout += chunk.toString('hex'); });
      const exit = await timeout(new Promise(resolve => child.once('exit', code => resolve(code))), 'bad broker exit');
      assert.notEqual(exit, 0);
      assert.equal(stdout, '');
      assert.match(stderr, /^BRIDGE_BROKER_[A-Z_]+\n$/);
      assert.doesNotMatch(stderr, /chrome-extension|unexpected|BBBB|AAAA/);
    }
  });

test('broker rejects unsafe run descriptors without opening the service socket',
  { skip: !posix }, async t => {
    const { installation } = configuredInstallation(t);
    const runtimeDirectory = privateDir(installation.root, 'runtime');
    const target = join(runtimeDirectory, 'foreign.json');
    writeFileSync(target, '{}\n', { mode: 0o600 });
    symlinkSync(target, join(runtimeDirectory, 'bridge-run.json'));

    const running = launch(installation);
    running.child.stdin.end();
    const exit = await timeout(running.exited, 'unsafe descriptor exit');
    assert.notEqual(exit.code, 0);
    assert.match(running.stderr(), /^BRIDGE_BROKER_[A-Z_]+\n$/);
  });

test('wrong enrolled channel from the service fails stop and is never forwarded to Chrome',
  { skip: !posix }, async t => {
    const { installation } = configuredInstallation(t);
    const runtime = await runtimeFixture(t, installation);
    const running = launch(installation);
    t.after(() => running.child.kill());
    const nativeReader = new NativeMessageReader(running.child.stdout);
    await writeNativeMessage(running.child.stdin, enrollmentMessage());
    const socket = await timeout(runtime.socketPromise, 'broker connect');
    const ipcReader = new BridgeIpcReader(socket);
    await timeout(ipcReader.read(), 'IPC hello');
    await writeBridgeIpcMessage(socket, {
      bridgeVersion: 1, kind: 'bridge.enrollment.accepted', channelId,
      tabId: 7, origin: SYNTHETIC_PORTAL_ORIGIN
    });
    await timeout(nativeReader.read(), 'native enrollment ack');

    await writeBridgeIpcMessage(socket, {
      bridgeVersion: 1, kind: 'browser.frame', channelId: 'D'.repeat(43),
      message: serviceMessage()
    });
    const exit = await timeout(running.exited, 'wrong channel exit');
    assert.notEqual(exit.code, 0);
    assert.match(running.stderr(), /^BRIDGE_BROKER_[A-Z_]+\n$/);
    assert.equal(await timeout(nativeReader.read(), 'native EOF'), undefined);
    socket.destroy();
    runtime.server.close();
  });
