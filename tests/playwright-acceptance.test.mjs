import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readdirSync, readFileSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { PlaywrightBrowserOwner } from '../dist/browser/playwright-owner.js';
import { runPlaywrightDiagnostic } from '../dist/browser/playwright-diagnostic.js';
import { startSyntheticPortal } from '../dist/synthetic-portal/server.js';
const enabled = process.env.BEHALVO_PLAYWRIGHT_ACCEPTANCE === '1';
const origin = 'http://127.0.0.1:43117';
const binding = { profileId: 'p1-acceptance', connectionGeneration: 1, serviceGeneration: 'p1-acceptance-service' };
const request = (sequence = 1) => ({ protocolVersion: 1, requestId: `request-${sequence}`, ...binding,
  epoch: 'a'.repeat(64), origin, tabId: 1, sequence, kind: 'recognize' });
const environment = Object.fromEntries(['PATH', 'TMPDIR', 'LANG', 'DISPLAY', 'XAUTHORITY'].filter(k => process.env[k]).map(k => [k, process.env[k]]));
async function fixture(t, portalFactory = startSyntheticPortal) {
  const { chromium } = await import('playwright');
  const portal = await portalFactory();
  const controller = new AbortController(); let server, page;
  const owner = new PlaywrightBrowserOwner({ ...binding, signal: controller.signal }, { environment, loadChromium: async () => ({
    executablePath: () => chromium.executablePath(), launchServer: async options => { server = await chromium.launchServer(options); return server; },
    connect: async (...args) => {
      const browser = await chromium.connect(...args); const newContext = browser.newContext.bind(browser);
      browser.newContext = async options => {
        const context = await newContext(options); const newPage = context.newPage.bind(context);
        context.newPage = async () => { page = await newPage(); return page; }; return context;
      }; return browser;
    }
  }) });
  t.after(async () => {
    await owner.close();
    await Promise.race([portal.close(), new Promise((_, reject) => { const timer = setTimeout(() => reject(Error('fixture portal cleanup deadline')), 5000); timer.unref(); })]);
    rmSync(dirname(owner.receiptPath), { recursive: true, force: true });
  });
  const ready = await owner.start();
  return { owner, ready, portal, controller, server, page };
}
test('visible matched Chromium completes production diagnostic and confirms cleanup', { skip: !enabled, timeout: 30_000 }, async () => {
  const result = await runPlaywrightDiagnostic({ signal: new AbortController().signal });
  assert.equal(result.ok, true, JSON.stringify(result)); assert.deepEqual(result.snapshot, { state: 'login' });
  assert.equal(result.cleanup, 'confirmed'); assert.equal(result.playwrightVersion, '1.63.0');
  console.log(JSON.stringify({ playwright: result.playwrightVersion, browser: result.browserVersion, cleanup: result.cleanup }));
});
test('visible actual DOM snapshot and owned profile evidence', { skip: !enabled, timeout: 30_000 }, async t => {
  const f = await fixture(t); const result = await f.ready.transport.inspect(request());
  assert.deepEqual(result.snapshot, { state: 'login' });
  const evidence = 'data/verification/playwright-p1'; mkdirSync(evidence, { recursive: true });
  await f.page.screenshot({ path: `${evidence}/visible-login.png` });
  const receipt = JSON.parse(readFileSync(f.owner.receiptPath, 'utf8'));
  assert.ok(receipt.profilePath.includes('playwright_chromiumdev_profile-'));
  assert.equal((await f.owner.close()).confirmed, true); assert.equal(existsSync(receipt.profilePath), false);
});
test('actual missing/changed DOM fails closed without retaining page canaries', { skip: !enabled, timeout: 30_000 }, async t => {
  const f = await fixture(t);
  await f.page.evaluate(() => document.querySelector('main').setAttribute('data-behalvo-page-state', 'CANARY-PAGE'));
  await assert.rejects(f.ready.transport.inspect(request()), error => !error.message.includes('CANARY'));
  assert.equal(readFileSync(f.owner.receiptPath, 'utf8').includes('CANARY'), false);
});
for (const interruption of ['navigation', 'crash', 'cancel']) {
  test(`actual pending DOM read settles on ${interruption} and cannot reconnect`, { skip: !enabled, timeout: 30_000 }, async t => {
    const f = await fixture(t); let entered;
    const waiting = new Promise(r => { entered = r; }); const locator = f.page.locator.bind(f.page);
    f.page.locator = selector => { const value = locator(selector); value.count = async () => {
      entered(); await f.page.waitForSelector('[data-behalvo-never-present]', { timeout: 10000 }); return 1;
    }; return value; };
    const pending = f.ready.transport.inspect(request()); const rejected = assert.rejects(pending); await waiting;
    if (interruption === 'navigation') await f.page.reload({ waitUntil: 'domcontentloaded' });
    if (interruption === 'crash') await f.server.kill();
    if (interruption === 'cancel') f.controller.abort();
    await rejected; await assert.rejects(f.ready.transport.inspect(request(2)));
    assert.equal((await f.owner.close()).confirmed, true);
  });
}
for (const attempt of ['post', 'off_origin', 'popup']) {
  test(`browser ${attempt} is blocked before any forbidden server request`, { skip: !enabled, timeout: 30_000 }, async t => {
    let forbidden = 0, roots = 0;
    const fixturePortal = async () => {
      const server = createServer((req, res) => {
        if (req.method !== 'GET' || req.url !== '/') forbidden++; else roots++;
        res.setHeader('content-type', 'text/html'); res.end('<main data-behalvo-page-state="login">Synthetic fixture</main>');
      }); server.listen(43117, '127.0.0.1'); await once(server, 'listening');
      return { origin, close: () => new Promise(r => { server.closeAllConnections(); server.close(r); }) };
    };
    const f = await fixture(t, fixturePortal);
    let outside = 0;
    const external = createServer((_, res) => { outside++; res.end('synthetic sentinel'); });
    external.listen(0, '127.0.0.1'); await once(external, 'listening'); t.after(() => new Promise(r => external.close(r)));
    const address = `http://127.0.0.1:${external.address().port}/`;
    if (attempt === 'post') await f.page.evaluate(() => fetch('/api/gesture', { method: 'POST', body: 'synthetic' }).catch(() => {}));
    if (attempt === 'off_origin') await f.page.goto(address).catch(() => {});
    if (attempt === 'popup') {
      // Test-only script on the owned synthetic page. Production exposes no script surface.
      await f.page.evaluate(url => { window.open(url); }, address);
      await new Promise(r => setTimeout(r, 100));
    }
    assert.equal(forbidden, 0); assert.equal(outside, 0); assert.equal(roots, 1);
    await assert.rejects(f.ready.transport.inspect(request()));
    assert.equal((await f.owner.close()).confirmed, true);
  });
}
for (const signal of ['SIGINT', 'SIGTERM']) {
  test(`actual CLI ${signal} during launch has bounded exit and owned cleanup evidence`, { skip: !enabled, timeout: 30_000 }, async t => {
    const root = mkdtempSync(join(tmpdir(), 'behalvo-p1-signal-')); t.after(() => rmSync(root, { recursive: true, force: true }));
    const child = spawn(process.execPath, ['dist/cli/playwright-main.js', 'diagnostic'], {
      env: { ...process.env, TMPDIR: root }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; child.stdout.on('data', c => { output += c; }); child.stderr.on('data', c => { output += c; });
    const exit = once(child, 'exit'); let receiptPath;
    const deadline = Date.now() + 12000;
    while (Date.now() < deadline && child.exitCode === null) {
      const entry = readdirSync(root).find(name => name.startsWith('behalvo-playwright-'));
      if (entry) {
        const path = join(root, entry, 'receipt.json');
        try { if (JSON.parse(readFileSync(path, 'utf8')).phase === 'launching') { receiptPath = path; break; } } catch {}
      }
      await new Promise(r => setTimeout(r, 5));
    }
    assert.ok(receiptPath, output); const start = Date.now(); child.kill(signal);
    const [code, exitSignal] = await exit;
    assert.notEqual(code, 0); assert.equal(exitSignal, null); assert.ok(Date.now() - start < 6500);
    const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
    assert.equal(receipt.cleanup, 'confirmed', output);
    if (receipt.profilePath) assert.equal(existsSync(receipt.profilePath), false);
  });
}
for (const redirect of ['off_origin', 'wrong_path']) test(`root ${redirect} redirect is rejected before forbidden dispatch`, { skip: !enabled, timeout: 30_000 }, async t => {
  const { chromium } = await import('playwright'); let outside = 0;
  const sentinel = createServer((_, res) => { outside++; res.end('<main data-behalvo-page-state="login">CANARY-REDIRECT</main>'); });
  sentinel.listen(0, '127.0.0.1'); await once(sentinel, 'listening'); t.after(() => new Promise(r => sentinel.close(r)));
  const portal = createServer((req, res) => {
    if (req.url !== '/') { outside++; res.end('CANARY-WRONG-PATH'); return; }
    res.writeHead(302, { location: redirect === 'off_origin' ? `http://127.0.0.1:${sentinel.address().port}/` : '/api/gesture' }); res.end();
  });
  portal.listen(43117, '127.0.0.1'); await once(portal, 'listening'); t.after(() => new Promise(r => portal.close(r)));
  const owner = new PlaywrightBrowserOwner({ ...binding, signal: new AbortController().signal }, { environment, loadChromium: async () => chromium });
  t.after(async () => { await owner.close(); rmSync(dirname(owner.receiptPath), { recursive: true, force: true }); });
  await assert.rejects(owner.start(), { code: 'page_rejected' });
  assert.equal(outside, 0, 'redirect must never reach a forbidden destination');
  assert.equal((await owner.close()).confirmed, true);
});
test('ambient Selenium override never connects to the synthetic sentinel', { skip: !enabled, timeout: 30_000 }, async t => {
  let contacted = 0, loaded = 0;
  const sentinel = createServer((_, res) => { contacted++; res.end('CANARY-REMOTE'); });
  sentinel.listen(0, '127.0.0.1'); await once(sentinel, 'listening'); t.after(() => new Promise(r => sentinel.close(r)));
  const owner = new PlaywrightBrowserOwner({ ...binding, signal: new AbortController().signal }, {
    environment: { ...environment, SELENIUM_REMOTE_URL: `http://127.0.0.1:${sentinel.address().port}` },
    loadChromium: async () => { loaded++; throw Error('must not load'); }
  });
  t.after(() => rmSync(dirname(owner.receiptPath), { recursive: true, force: true }));
  await assert.rejects(owner.start(), { code: 'unsafe_environment' });
  assert.equal((await owner.close()).confirmed, true); assert.equal(contacted, 0); assert.equal(loaded, 0);
});
test('crashing one owned browser leaves a second synthetic browser usable', { skip: !enabled, timeout: 30_000 }, async t => {
  const { chromium } = await import('playwright');
  const sentinel = await chromium.launchServer({ host: '127.0.0.1', port: 0, headless: false, chromiumSandbox: true });
  const sentinelBrowser = await chromium.connect(sentinel.wsEndpoint());
  const sentinelPage = await sentinelBrowser.newPage();
  t.after(async () => { await sentinel.close(); });
  const f = await fixture(t); await f.server.kill(); await assert.rejects(f.ready.transport.inspect(request()));
  assert.equal((await f.owner.close()).confirmed, true);
  assert.equal(sentinelBrowser.isConnected(), true); assert.equal(sentinel.process().exitCode, null);
  assert.equal(await sentinelPage.title(), '');
});
