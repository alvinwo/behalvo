import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { browserFixture, binding, origin } from './helpers/playwright-fixture.mjs';
const module = await import('../dist/browser/playwright-owner.js').catch(() => ({}));
function create(t, options = {}) {
  assert.equal(typeof module.PlaywrightBrowserOwner, 'function', 'owned browser lifecycle must exist');
  const f = browserFixture(); t.after(f.dispose);
  const controller = new AbortController();
  const owner = new module.PlaywrightBrowserOwner({ ...binding, signal: controller.signal }, {
    loadChromium: async () => f.chromium, environment: {}, setupTimeoutMs: 50, shutdownTimeoutMs: 60, ...options });
  t.after(() => rmSync(dirname(owner.receiptPath), { recursive: true, force: true }));
  return { f, owner, controller };
}
test('owner uses isolated fixed launch and confirms exact process/profile cleanup', async t => {
  const { f, owner } = create(t); const result = await owner.start();
  assert.equal(result.tabId, 1); assert.equal(result.browserVersion, '154.0.8037.93');
  assert.equal(f.options.host, '127.0.0.1'); assert.equal(f.options.port, 0); assert.equal(f.options.headless, false);
  assert.equal(f.options.handleSIGINT, false); assert.equal(f.options.handleSIGTERM, false); assert.equal(f.options.handleSIGHUP, false);
  assert.equal(f.options.chromiumSandbox, true); assert.equal(f.options.timeout <= 15000, true);
  assert.equal(f.contextOptions.serviceWorkers, 'block'); assert.equal(f.contextOptions.acceptDownloads, false);
  assert.equal(f.options.env.SECRET, undefined);
  const close = owner.close(); assert.equal(close, owner.close());
  assert.equal((await close).confirmed, true); assert.equal(existsSync(f.profile), false);
  assert.equal(f.counts().closes, 1);
});
for (const key of ['SELENIUM_REMOTE_URL', 'PLAYWRIGHT_BROWSERS_PATH', 'PLAYWRIGHT_HOST_PLATFORM_OVERRIDE', 'DEBUG', 'PWDEBUG']) {
  test(`owner rejects ambient ${key} before importing or launching`, async t => {
    let loads = 0; const { owner, f } = create(t, { environment: { [key]: 'CANARY' }, loadChromium: async () => { loads++; return f.chromium; } });
    await assert.rejects(owner.start(), { code: 'unsafe_environment' }); assert.equal(loads, 0);
    assert.equal((await owner.close()).confirmed, true);
  });
}
test('owner cancellation before start never launches', async t => {
  const { owner, f, controller } = create(t); controller.abort(); await assert.rejects(owner.start(), { code: 'cancelled' });
  assert.equal(f.counts().launches, 0); assert.equal((await owner.close()).confirmed, true);
});
test('owner reports missing browser without silently installing', async t => {
  const { owner, f } = create(t); f.chromium.executablePath = () => '/not-installed-p1-browser';
  await assert.rejects(owner.start(), { code: 'browser_missing' }); assert.equal(f.counts().launches, 0);
  assert.equal((await owner.close()).confirmed, true);
});
test('owner retains unknown launch receipt and retires a late handle without connecting', async t => {
  const { owner, f, controller } = create(t); let resolve;
  f.launchHook = () => new Promise(r => { resolve = r; });
  const start = owner.start(); const reject = assert.rejects(start, { code: 'cancelled' });
  await new Promise(r => setImmediate(r)); controller.abort(); await reject;
  const cleanup = await owner.close(); assert.equal(cleanup.confirmed, false);
  const receipt = JSON.parse(readFileSync(owner.receiptPath, 'utf8'));
  assert.equal(receipt.cleanup, 'pending'); assert.equal(receipt.profilePath, null);
  assert.equal(JSON.stringify(receipt).includes('CANARY'), false);
  resolve(f.server); await new Promise(r => setTimeout(r, 20));
  assert.equal(f.counts().connects, 0); assert.equal(existsSync(f.profile), false);
});
test('owner setup timeout never admits a late browser', async t => {
  const { owner, f } = create(t, { setupTimeoutMs: 15 });
  f.launchHook = () => new Promise(() => {});
  await assert.rejects(owner.start(), { code: 'setup_timeout' }); assert.equal((await owner.close()).confirmed, false);
});
test('owner escalates only its own handle and bounds unresolved cleanup', async t => {
  for (const unresolved of [false, true]) {
    const { owner, f } = create(t); await owner.start(); f.closeHook = () => new Promise(() => {});
    if (unresolved) f.killHook = () => new Promise(() => {});
    const before = Date.now(); const cleanup = await owner.close();
    assert.equal(cleanup.confirmed, !unresolved); assert.equal(f.counts().kills, 1); assert.ok(Date.now() - before < 300);
  }
});
test('owner refuses success when upstream close leaves the profile behind', async t => {
  const { owner, f } = create(t); await owner.start();
  const finish = async () => { f.proc.exitCode = 0; f.proc.emit('exit'); f.server.emit('close'); };
  f.closeHook = finish; f.killHook = finish;
  assert.equal((await owner.close()).confirmed, false); assert.equal(existsSync(f.profile), true);
});
test('owner rejects all non-root or mutation requests before route continuation', async t => {
  const { owner, f } = create(t); await owner.start();
  for (const [method, url] of [['POST', `${origin}/api/gesture`], ['GET', `${origin}/api/state`], ['GET', 'https://example.invalid/']]) {
    let continued = false, aborted = false;
    await f.routes[0]({ request: () => ({ method: () => method, url: () => url, frame: () => f.frame }),
      continue: async () => { continued = true; }, abort: async () => { aborted = true; } });
    assert.equal(continued, false); assert.equal(aborted, true);
  }
  await owner.close();
});
test('final pending receipt cannot be upgraded by a later owner close', async t => {
  const { owner, f } = create(t); await owner.start(); let resolve;
  f.closeHook = () => new Promise(r => { resolve = r; });
  const closing = owner.close(); owner.finishReceipt(false, 'cleanup_pending', false);
  f.proc.exitCode = 0; f.server.emit('close'); rmSync(f.profile, { recursive: true }); resolve(); await closing;
  assert.equal(JSON.parse(readFileSync(owner.receiptPath, 'utf8')).cleanup, 'pending');
});
test('late handle with invalid profile still receives exact owned cleanup', async t => {
  const { owner, f, controller } = create(t); let resolve;
  f.launchHook = () => new Promise(r => { resolve = r; });
  const start = owner.start(); const rejected = assert.rejects(start);
  await new Promise(r => setImmediate(r)); controller.abort(); await rejected; await owner.close();
  f.proc.spawnargs = ['chromium']; resolve(f.server); await new Promise(r => setTimeout(r, 20));
  assert.equal(f.counts().closes, 1); assert.equal(existsSync(f.profile), false);
});
test('shutdown waits within its budget for a launch handle and confirms late cleanup', async t => {
  const { owner, f, controller } = create(t); let resolve;
  f.launchHook = () => new Promise(r => { resolve = r; });
  const start = owner.start(); const rejected = assert.rejects(start);
  await new Promise(r => setImmediate(r)); controller.abort(); await rejected;
  const closing = owner.close(); setTimeout(() => resolve(f.server), 5);
  assert.equal((await closing).confirmed, true); assert.equal(f.counts().connects, 0); assert.equal(existsSync(f.profile), false);
});
