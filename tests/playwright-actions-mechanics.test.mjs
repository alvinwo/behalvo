import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { PlaywrightProcessOwner } from '../dist/browser/playwright-process-owner.js';
import { startSyntheticPortal } from '../dist/synthetic-portal/server.js';
import { SyntheticPortalState } from '../dist/synthetic-portal/state.js';
const enabled = process.env.BEHALVO_PLAYWRIGHT_P2_ACCEPTANCE === '1';
const origin = 'http://127.0.0.1:43117';

for (const mode of ['document', 'revoked', 'redirect']) {
  test(`visible mechanism: ${mode} preserves exact form dispatch boundary`, { skip: !enabled, timeout: 20000 }, async t => {
    const state = new SyntheticPortalState({ scenario: 'calendar_match' });
    const portal = await startSyntheticPortal({ state, formResponse: 'document', ...(mode === 'redirect' ? { port: 0 } : {}) });
    let sentinelRequests = 0;
    const sentinel = createServer((_, res) => { sentinelRequests++; res.end('outside'); });
    sentinel.listen(0, '127.0.0.1'); await once(sentinel, 'listening');
    let redirectServer;
    if (mode === 'redirect') {
      redirectServer = createServer(async (req, res) => {
        res.setHeader('connection', 'close');
        if (req.method === 'POST') { res.writeHead(303, { location: `http://127.0.0.1:${sentinel.address().port}/` }); res.end(); }
        else { const response = await fetch(portal.origin + '/'); res.setHeader('content-type', 'text/html'); res.end(await response.text()); }
      });
      redirectServer.listen(43117, '127.0.0.1'); await once(redirectServer, 'listening');
    }
    const owner = new PlaywrightProcessOwner({ signal: new AbortController().signal });
    t.after(async () => {
      const closed = await owner.close();
      if (redirectServer) await new Promise(r => redirectServer.close(r));
      await portal.close(); await new Promise(r => sentinel.close(r));
      assert.equal(closed.confirmed, true);
      owner.finishReceipt(true, null, true);
    });
    let page, permitted = true, dispatched = 0, guards = 0, rootGets = 0;
    let reached, release;
    const held = new Promise(r => { release = r; });
    const entered = new Promise(r => { reached = r; });
    const token = randomBytes(32).toString('hex');
    const ready = await owner.start(async browser => {
      const context = await browser.newContext({ javaScriptEnabled: false, serviceWorkers: 'block', acceptDownloads: false });
      await context.route('**/*', async route => {
        const request = route.request();
        assert.equal(request.frame(), page.mainFrame());
        if (request.method() === 'GET') {
          assert.equal(request.url(), origin + '/'); rootGets++;
        } else {
          assert.equal(request.url(), origin + '/gesture');
          assert.equal(request.isNavigationRequest(), true);
          const fields = new URLSearchParams(request.postData());
          assert.equal(fields.get('kind'), 'calendar.next_page');
          if (mode !== 'redirect') assert.equal(fields.get('_behalvo_dispatch'), token);
          reached(); await held;
          if (!permitted) { await route.abort(); return; }
          guards++; permitted = false; dispatched++;
        }
        const response = await route.fetch({ maxRedirects: 0, maxRetries: 0, timeout: 3000 });
        try {
          if (response.status() !== 200 || response.headers().location) { await route.abort(); return; }
          await route.fulfill({ response });
        } finally { await response.dispose(); }
      });
      page = await context.newPage(); await page.goto(origin + '/'); return page;
    });
    assert.match(ready.browserVersion, /^\d+\./);
    const source = await page.$('main');
    await source.evaluate(root => { root.dataset.probeSource = 'source-document'; });
    const navigation = page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 5000 }).catch(() => null);
    await source.evaluate((root, token) => {
      const button = root.querySelector('[data-behalvo-gesture="calendar.next_page"]');
      if (token) { const input = document.createElement('input'); input.type = 'hidden';
        input.name = '_behalvo_dispatch'; input.value = token; button.form.append(input); }
      button.form.requestSubmit(button);
    }, mode === 'redirect' ? null : token);
    await entered;
    if (mode === 'revoked') permitted = false;
    release(); await navigation;
    assert.equal(rootGets, 1);
    assert.equal(dispatched, mode === 'revoked' ? 0 : 1);
    assert.equal(guards, dispatched);
    assert.equal(state.inspect().page, mode === 'document' ? 2 : 1);
    assert.equal(sentinelRequests, 0);
    if (mode === 'document') {
      assert.equal(page.url(), origin + '/gesture');
      assert.equal(await page.locator('main').getAttribute('data-behalvo-page'), '2');
      assert.equal(await page.locator('main').getAttribute('data-probe-source'), null);
      await assert.rejects(source.evaluate(root => root.ownerDocument === document));
    }
  });
}
