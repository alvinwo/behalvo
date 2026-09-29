import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  NativeMessageReader,
  NATIVE_HOST_NAME,
  SYNTHETIC_PORTAL_ORIGIN,
  finalizeChromeBridgeInstallation,
  stageChromeBridgeInstallation,
  startChromeBridgeRendezvous,
  writeNativeMessage
} from '../dist/index.js';

const posix = process.platform !== 'win32' && typeof process.geteuid === 'function';
const extensionId = 'a'.repeat(32);
const extensionOrigin = `chrome-extension://${extensionId}/`;

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
  const temp = mkdtempSync(join(tmpdir(), 'behalvo-rendezvous-'));
  chmodSync(temp, 0o700);
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const root = privateDir(temp, 'install');
  const registrationDirectory = join(root, 'chrome-profile', 'NativeMessagingHosts');
  const chromePath = join(temp, 'chrome');
  writeFileSync(chromePath, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  chmodSync(chromePath, 0o700);
  stageChromeBridgeInstallation({
    root,
    packageRoot: process.cwd(),
    chromePath,
    nodePath: process.execPath,
    registrationDirectory
  });
  const installation = finalizeChromeBridgeInstallation({ root, extensionId });
  assert.equal(installation.registrationPath, join(registrationDirectory, `${NATIVE_HOST_NAME}.json`));
  return installation;
}

function launch(installation) {
  const child = spawn(installation.launcherPath, [extensionOrigin], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { stderr += chunk; });
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  return { child, exited, stderr: () => stderr };
}

const epoch = {
  profileId: 'profile-a',
  connectionGeneration: 1,
  epoch: 'd'.repeat(64),
  serviceGeneration: 'service-generation-a',
  allowedOrigin: SYNTHETIC_PORTAL_ORIGIN
};

function request() {
  return {
    protocolVersion: 1,
    kind: 'inspect',
    requestId: 'request-a',
    profileId: epoch.profileId,
    connectionGeneration: epoch.connectionGeneration,
    epoch: epoch.epoch,
    serviceGeneration: epoch.serviceGeneration,
    origin: epoch.allowedOrigin,
    tabId: 7,
    sequence: 1,
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

test('production rendezvous enrolls the actual installed broker once and hands the same channel to browser transport',
  { skip: !posix }, async t => {
    const installation = configuredInstallation(t);
    const rendezvous = await startChromeBridgeRendezvous({
      root: installation.root,
      serviceGeneration: epoch.serviceGeneration
    });
    t.after(async () => { await rendezvous.close(); });

    assert.equal(rendezvous.runtimeDirectory, join(installation.root, 'runtime'));
    assert.equal(rendezvous.descriptorPath, join(rendezvous.runtimeDirectory, 'bridge-run.json'));
    assert.equal(rendezvous.enrollmentPath, join(rendezvous.runtimeDirectory, 'bridge-enrollment.json'));
    assert.equal(existsSync(rendezvous.descriptorPath), true);
    assert.equal(existsSync(rendezvous.enrollmentPath), true);

    const bootstrap = JSON.parse(readFileSync(rendezvous.enrollmentPath, 'utf8'));
    assert.deepEqual(Object.keys(bootstrap).sort(), ['enrollment', 'expiresAt', 'version'].sort());
    assert.equal(bootstrap.version, 1);
    assert.match(bootstrap.enrollment, /^[A-Za-z0-9_-]{43}$/);
    assert.ok(Number.isSafeInteger(bootstrap.expiresAt) && bootstrap.expiresAt > Date.now());

    const running = launch(installation);
    t.after(() => running.child.kill());
    const nativeReader = new NativeMessageReader(running.child.stdout);
    await writeNativeMessage(running.child.stdin, {
      bridgeVersion: 1,
      kind: 'bridge.enroll',
      enrollment: bootstrap.enrollment,
      tabId: 7,
      origin: SYNTHETIC_PORTAL_ORIGIN
    });

    const enrolled = await timeout(rendezvous.waitForEnrollment(), 'rendezvous enrollment');
    assert.equal(enrolled.tabId, 7);
    assert.equal(existsSync(rendezvous.descriptorPath), false);
    assert.equal(existsSync(rendezvous.enrollmentPath), false);
    assert.deepEqual(await timeout(nativeReader.read(), 'native enrollment acknowledgement'), {
      bridgeVersion: 1,
      kind: 'bridge.enrollment.accepted',
      tabId: 7,
      origin: SYNTHETIC_PORTAL_ORIGIN
    });

    const pending = enrolled.transport.inspect(request());
    const activate = await timeout(nativeReader.read(), 'native activation');
    assert.equal(activate.kind, 'session.activate');
    await writeNativeMessage(running.child.stdin, controlResponse(activate, 'session.activated'));
    const operation = await timeout(nativeReader.read(), 'native diagnostic request');
    assert.deepEqual(operation, request());
    await writeNativeMessage(running.child.stdin, response(operation));
    assert.deepEqual(await timeout(pending, 'diagnostic result'), response(request()));

    await enrolled.transport.close();
    await enrolled.transport.completion;
    running.child.stdin.end();
    const exit = await timeout(running.exited, 'broker exit');
    assert.notEqual(exit.code, 0);
    assert.equal(running.stderr(), 'BRIDGE_BROKER_CHANNEL_ERROR\n');
    assert.doesNotMatch(running.stderr(), new RegExp(bootstrap.enrollment));

    await rendezvous.close();
    assert.equal(existsSync(rendezvous.runtimeDirectory), false);
    assert.equal(existsSync(installation.profilePath), true);
  });

test('rejected enrollment does not consume the rendezvous and a later exact broker can still enroll',
  { skip: !posix }, async t => {
    const installation = configuredInstallation(t);
    const rendezvous = await startChromeBridgeRendezvous({
      root: installation.root,
      serviceGeneration: epoch.serviceGeneration
    });
    t.after(async () => { await rendezvous.close(); });
    const bootstrap = JSON.parse(readFileSync(rendezvous.enrollmentPath, 'utf8'));

    const bad = launch(installation);
    t.after(() => bad.child.kill());
    await writeNativeMessage(bad.child.stdin, {
      bridgeVersion: 1,
      kind: 'bridge.enroll',
      enrollment: 'Z'.repeat(43),
      tabId: 7,
      origin: SYNTHETIC_PORTAL_ORIGIN
    });
    const badReader = new NativeMessageReader(bad.child.stdout);
    assert.deepEqual(await timeout(badReader.read(), 'bad enrollment rejection'), {
      bridgeVersion: 1,
      kind: 'bridge.enrollment.rejected',
      code: 'enrollment_rejected'
    });
    bad.child.stdin.end();
    const badExit = await timeout(bad.exited, 'bad broker exit');
    assert.equal(badExit.code, 0, bad.stderr());
    assert.equal(existsSync(rendezvous.enrollmentPath), true);

    const good = launch(installation);
    t.after(() => good.child.kill());
    await writeNativeMessage(good.child.stdin, {
      bridgeVersion: 1,
      kind: 'bridge.enroll',
      enrollment: bootstrap.enrollment,
      tabId: 7,
      origin: SYNTHETIC_PORTAL_ORIGIN
    });
    const enrolled = await timeout(rendezvous.waitForEnrollment(), 'good enrollment');
    assert.equal(enrolled.tabId, 7);
    await enrolled.transport.close();
    good.child.stdin.end();
    await timeout(good.exited, 'good broker exit');
  });

test('review R5: rendezvous close terminates a stalled pre-enrollment subprocess socket',
  { skip: !posix }, async t => {
    const installation = configuredInstallation(t);
    const rendezvous = await startChromeBridgeRendezvous({ root: installation.root,
      serviceGeneration: 'review-stalled-client' });
    const socketPath = join(rendezvous.runtimeDirectory, 'bridge.sock');
    const client = spawn(process.execPath, ['--input-type=module', '-e', `
      import { createConnection } from 'node:net';
      const socket = createConnection({ path: process.argv[1], allowHalfOpen: true });
      socket.on('connect', () => process.stdout.write('ready'));
      socket.on('error', () => {});
    `, socketPath], { stdio: ['ignore', 'pipe', 'pipe'] });
    t.after(() => { client.kill('SIGKILL'); void rendezvous.close().catch(() => {}); });
    await timeout(new Promise(resolve => client.stdout.once('data', resolve)), 'client connect');
    await timeout(rendezvous.close(), 'rendezvous owned socket shutdown', 750);
    assert.equal(existsSync(rendezvous.descriptorPath), false);
    assert.equal(existsSync(rendezvous.enrollmentPath), false);
    assert.equal(existsSync(socketPath), false);
  });

test('review R3 follow-up: rendezvous preserves unknown runtime artifacts and reports incomplete cleanup',
  { skip: !posix }, async t => {
    const installation = configuredInstallation(t);
    const rendezvous = await startChromeBridgeRendezvous({ root: installation.root,
      serviceGeneration: 'review-cleanup-evidence' });
    const foreign = join(rendezvous.runtimeDirectory, 'unknown-artifact');
    writeFileSync(foreign, 'preserve synthetic evidence', { mode: 0o600 });
    await assert.rejects(rendezvous.close(), /Chrome bridge rendezvous failed/);
    assert.equal(readFileSync(foreign, 'utf8'), 'preserve synthetic evidence');
    assert.equal(existsSync(rendezvous.descriptorPath), false);
    assert.equal(existsSync(rendezvous.enrollmentPath), false);
  });
