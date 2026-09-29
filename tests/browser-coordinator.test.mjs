import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchDedicatedChrome, runChromeBridgeDiagnostic, SYNTHETIC_PORTAL_ORIGIN } from '../dist/index.js';

const posix = process.platform !== 'win32';

test('dedicated Chrome launcher uses only the owned profile and fixed synthetic portal URL',
  { skip: !posix }, async t => {
    const temp = mkdtempSync(join(tmpdir(), 'behalvo-chrome-launch-'));
    chmodSync(temp, 0o700);
    t.after(() => rmSync(temp, { recursive: true, force: true }));
    const profilePath = join(temp, 'profile with spaces');
    const chromePath = join(temp, 'fake chrome');
    const capturePath = join(temp, 'argv.txt');
    writeFileSync(chromePath,
      '#!/bin/sh\nprintf "%s\\n" "$@" > "' + capturePath.replaceAll('"', '\\"') + '"\nexit 0\n',
      { mode: 0o700 });
    chmodSync(chromePath, 0o700);

    const launched = launchDedicatedChrome({ chromePath, profilePath });
    const exit = await launched.exited;
    assert.deepEqual(exit, { code: 0, signal: null });
    assert.equal(launched.stderr(), '');

    const argv = readFileSync(capturePath, 'utf8').trimEnd().split('\n');
    assert.deepEqual(argv, [
      `--user-data-dir=${profilePath}`,
      `${SYNTHETIC_PORTAL_ORIGIN}/`
    ]);
    assert.equal(argv.some(value => /remote-debugging|automation|load-extension|profile-directory/i.test(value)), false);
  });

test('dedicated Chrome launcher rejects non-absolute or mismatched inputs before spawning', () => {
  for (const input of [
    { chromePath: 'relative-chrome', profilePath: '/private/profile' },
    { chromePath: '/private/chrome', profilePath: 'relative-profile' },
    { chromePath: '/private/chrome', profilePath: '/private/profile', extra: true }
  ]) {
    assert.throws(() => launchDedicatedChrome(input), /Chrome bridge launch failed\./);
  }
});


test('dedicated Chrome launcher reports asynchronous spawn failure with one fixed bounded error',
  { skip: !posix }, async t => {
    const temp = mkdtempSync(join(tmpdir(), 'behalvo-chrome-launch-missing-'));
    chmodSync(temp, 0o700);
    t.after(() => rmSync(temp, { recursive: true, force: true }));
    const missingChrome = join(temp, 'missing chrome private marker');
    const profilePath = join(temp, 'profile');

    const launched = launchDedicatedChrome({ chromePath: missingChrome, profilePath });
    let timer;
    const bounded = Promise.race([
      launched.exited,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('launcher did not settle')), 750);
      })
    ]).finally(() => clearTimeout(timer));

    await assert.rejects(bounded, error => {
      assert.equal(error.message, 'Chrome bridge launch failed.');
      assert.doesNotMatch(error.message, /missing chrome private marker|ENOENT/);
      return true;
    });
  });


test('diagnostic coordinator starts one service and performs one read-only inspect bound to its generation', async () => {
  const events = [];
  let serviceStarts = 0;
  let releaseChromeExit;
  const chromeExited = new Promise(resolve => { releaseChromeExit = resolve; });
  const installation = {
    version: 1,
    installationId: 'installation-a',
    root: '/private/install',
    packageRoot: '/private/package',
    chromePath: '/private/chrome',
    nodePath: '/private/node',
    brokerPath: '/private/broker',
    profilePath: '/private/install/chrome-profile',
    extensionPath: '/private/install/extension',
    launcherPath: '/private/install/native-host',
    metadataPath: '/private/install/chrome-bridge-installation.json',
    registrationDirectory: '/private/native-hosts',
    registrationPath: '/private/native-hosts/com.behalvo.browser.json',
    extensionId: 'a'.repeat(32),
    profileDevice: '1',
    profileInode: '2',
    hashes: { chrome: 'x', node: 'x', broker: 'x', launcher: 'x', extension: {}, registration: 'x' }
  };
  const transport = {
    async inspect(request) {
      events.push(['inspect', structuredClone(request)]);
      releaseChromeExit({ code: 0, signal: null });
      return {
        ...request,
        kind: 'result',
        documentId: 'document-a',
        pageState: 'login',
        snapshot: { state: 'login' }
      };
    },
    async gesture() { throw new Error('diagnostic must not gesture'); },
    async revoke() { events.push('revoke'); },
    async reconcileRevocation() { throw new Error('diagnostic must not reconcile'); },
    async close() { events.push('transport.close'); },
    completion: Promise.resolve()
  };

  const result = await runChromeBridgeDiagnostic({
    root: '/private/install',
    dbPath: '/private/data/service.db',
    bootstrapDirectory: '/private/data/bootstrap',
    workspaceId: 'diagnostic-workspace',
    ownerId: 'owner'
  }, {
    doctor() {
      events.push('doctor');
      return { configured: true, registered: true, handshakeObserved: false, issues: [], installation };
    },
    acquireProfileLease(input) {
      events.push(['lease', structuredClone(input)]);
      return {
        custodyId: 'custody-a',
        profilePath: installation.profilePath,
        profileDevice: '1',
        profileInode: '2',
        release() { events.push('lease.release'); }
      };
    },
    async startPortal() {
      events.push('portal.start');
      return {
        origin: SYNTHETIC_PORTAL_ORIGIN,
        state: {},
        async close() { events.push('portal.close'); }
      };
    },
    async startService(options) {
      serviceStarts++;
      events.push(['service.start', {
        workspaceId: options.workspaceId,
        ownerId: options.ownerId,
        syntheticOperations: options.syntheticOperations,
        hasSyntheticMonitoring: options.syntheticMonitoring !== undefined
      }]);
      return {
        origin: 'http://127.0.0.1:45555',
        bootstrapPath: '/private/data/bootstrap/service.json',
        serviceGeneration: 'service-generation-a',
        control: {},
        async shutdown() { events.push('service.shutdown'); return true; }
      };
    },
    async startRendezvous(input) {
      events.push(['rendezvous.start', structuredClone(input)]);
      return {
        runtimeDirectory: '/private/install/runtime',
        descriptorPath: '/private/install/runtime/bridge-run.json',
        enrollmentPath: '/private/install/runtime/bridge-enrollment.json',
        async waitForEnrollment() {
          events.push('rendezvous.enrolled');
          return { transport, tabId: 7 };
        },
        async close() { events.push('rendezvous.close'); }
      };
    },
    launchChrome(input) {
      events.push(['chrome.launch', structuredClone(input)]);
      return {
        child: { kill() { throw new Error('coordinator must not kill a cleanly exiting Chrome'); } },
        exited: chromeExited,
        stderr() { return ''; }
      };
    },
    assets: { html: '<!doctype html>', javascript: '', css: '' }
  });

  assert.equal(serviceStarts, 1);
  assert.deepEqual(result, {
    serviceOrigin: 'http://127.0.0.1:45555',
    bootstrapPath: '/private/data/bootstrap/service.json',
    enrollmentPath: '/private/install/runtime/bridge-enrollment.json',
    tabId: 7,
    pageState: 'login'
  });
  const inspect = events.find(item => Array.isArray(item) && item[0] === 'inspect')[1];
  assert.deepEqual({
    protocolVersion: inspect.protocolVersion,
    kind: inspect.kind,
    profileId: inspect.profileId,
    connectionGeneration: inspect.connectionGeneration,
    serviceGeneration: inspect.serviceGeneration,
    origin: inspect.origin,
    tabId: inspect.tabId,
    sequence: inspect.sequence,
    expectedPageState: inspect.expectedPageState,
    command: inspect.command
  }, {
    protocolVersion: 1,
    kind: 'inspect',
    profileId: 'synthetic-chrome',
    connectionGeneration: 1,
    serviceGeneration: 'service-generation-a',
    origin: SYNTHETIC_PORTAL_ORIGIN,
    tabId: 7,
    sequence: 1,
    expectedPageState: 'login',
    command: undefined
  });
  assert.deepEqual(events.filter(item => typeof item === 'string').slice(-6), [
    'rendezvous.enrolled',
    'transport.close',
    'service.shutdown',
    'rendezvous.close',
    'portal.close',
    'lease.release'
  ]);
  assert.equal(events.at(-1), 'lease.release');
});
