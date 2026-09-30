import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchDedicatedChrome, acquireSyntheticProfileLease, inspectPrivateProfileCustody, runChromeBridgeDiagnostic, SYNTHETIC_PORTAL_ORIGIN } from '../dist/index.js';

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  void promise.catch(() => {});
  return { promise, resolve, reject };
}

function fixture() {
  const events = [];
  const exit = deferred();
  const channel = deferred();
  const inspected = deferred();
  const installation = {
    installationId: 'review-install', root: '/private/install',
    profilePath: '/private/install/chrome-profile', chromePath: '/private/fake-chrome',
    extensionId: 'a'.repeat(32)
  };
  const input = {
    root: installation.root, dbPath: '/private/service.db',
    bootstrapDirectory: '/private/bootstrap', workspaceId: 'synthetic', ownerId: 'owner'
  };
  const transport = {
    completion: channel.promise,
    async close() { events.push('transport.close'); }
  };
  // Strict browser response schema omits request-only fields.
  transport.inspect = async request => {
    const { expectedPageState, ...binding } = request;
    inspected.resolve();
    return { ...binding, kind: 'result', documentId: 'document-review',
      pageState: 'login', snapshot: { state: 'login' } };
  };
  const service = { serviceGeneration: 'service-review', origin: 'http://127.0.0.1:12345',
    bootstrapPath: '/private/bootstrap/service.json',
    async shutdown() { events.push('service.shutdown'); return true; } };
  const rendezvous = { enrollmentPath: '/private/install/runtime/bridge-enrollment.json',
    async waitForEnrollment() { return { transport, tabId: 7 }; },
    async close() { events.push('rendezvous.close'); } };
  const dependencies = {
    doctor() { return { configured: true, registered: true, issues: [], installation }; },
    acquireProfileLease() { return { release() { events.push('lease.release'); } }; },
    async startPortal() { return { origin: SYNTHETIC_PORTAL_ORIGIN,
      async close() { events.push('portal.close'); } }; },
    async startService() { return service; },
    async startRendezvous() { return rendezvous; },
    launchChrome() { events.push('chrome.launch'); return { child: {
      kill() { events.push('chrome.kill'); exit.resolve({ code: null, signal: 'SIGTERM' }); }
    }, exited: exit.promise, stderr: () => '' }; },
    assets: { html: '', javascript: '', css: '' }
  };
  return { input, dependencies, events, exit, channel, inspected, transport, service, rendezvous };
}

test('review R2: channel failure after inspect cannot become success on later clean Chrome exit', async () => {
  const f = fixture();
  const result = runChromeBridgeDiagnostic(f.input, f.dependencies);
  const rejected = assert.rejects(result, /Chrome bridge diagnostic failed/);
  await f.inspected.promise;
  f.channel.reject(new Error('synthetic native channel lost'));
  await new Promise(resolve => setImmediate(resolve));
  f.exit.resolve({ code: 0, signal: null });
  await rejected;
  assert.ok(f.events.includes('service.shutdown'));
});

for (const phase of ['startPortal', 'startService', 'startRendezvous']) {
  test(`review R3: ${phase} failure before Chrome launch releases fully stopped custody`, async () => {
    const f = fixture();
    f.dependencies[phase] = async () => { throw new Error('synthetic startup failure'); };
    await assert.rejects(runChromeBridgeDiagnostic(f.input, f.dependencies), /Chrome bridge diagnostic failed/);
    assert.equal(f.events.includes('chrome.launch'), false);
    assert.equal(f.events.at(-1), 'lease.release');
  });
}

for (const phase of ['service', 'transport', 'rendezvous']) {
  test(`review R3: unsuccessful ${phase} cleanup retains custody after observed Chrome exit`, async () => {
    const f = fixture();
    if (phase === 'service') f.service.shutdown = async () => false;
    else f[phase].close = async () => { throw new Error('synthetic cleanup failure'); };
    const result = runChromeBridgeDiagnostic(f.input, f.dependencies);
    const rejected = assert.rejects(result, /Chrome bridge cleanup pending/);
    await f.inspected.promise;
    f.exit.resolve({ code: 0, signal: null });
    await rejected;
    assert.equal(f.events.includes('lease.release'), false);
  });
}

test('review R3: rejected Chrome exit observation is not evidence to release custody', async () => {
  const f = fixture();
  f.rendezvous.waitForEnrollment = () => new Promise(() => {});
  f.dependencies.launchChrome = () => ({ child: { kill() {} }, exited: Promise.reject(new Error('unknown exit')), stderr: () => '' });
  await assert.rejects(runChromeBridgeDiagnostic(f.input, f.dependencies), /Chrome bridge cleanup pending/);
  assert.equal(f.events.includes('lease.release'), false);
});


test('review R3 follow-up: confirmed OS spawn failure releases stopped real profile custody',
  { skip: process.platform === 'win32' }, async t => {
    const root = mkdtempSync(join(tmpdir(), 'behalvo-never-spawned-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const profilePath = join(root, 'profile');
    mkdirSync(profilePath, { mode: 0o700 });
    const f = fixture();
    const report = f.dependencies.doctor();
    report.installation.profilePath = profilePath;
    report.installation.chromePath = join(root, 'missing-synthetic-chrome');
    f.dependencies.doctor = () => report;
    f.dependencies.acquireProfileLease = acquireSyntheticProfileLease;
    f.dependencies.launchChrome = launchDedicatedChrome;
    f.rendezvous.waitForEnrollment = () => new Promise(() => {});
    await assert.rejects(runChromeBridgeDiagnostic(f.input, f.dependencies));
    assert.equal(inspectPrivateProfileCustody(profilePath), null);
    const lease = acquireSyntheticProfileLease({ installationId: 'review-install',
      profileId: 'synthetic-chrome', profilePath });
    lease.release();
    assert.deepEqual(f.events, ['service.shutdown', 'rendezvous.close', 'portal.close']);
  });
