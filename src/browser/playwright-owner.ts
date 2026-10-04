import type { Browser, Page } from 'playwright';
import { PlaywrightReadOnlyTransport, type PlaywrightBinding } from './playwright-transport.js';
import { PlaywrightDiagnosticError, type PlaywrightFailureCode } from './playwright-errors.js';
import { PlaywrightProcessOwner, type PlaywrightOwnerDependencies } from './playwright-process-owner.js';
import { SYNTHETIC_PORTAL_ORIGIN } from './types.js';
export type { PlaywrightOwnerDependencies, PlaywrightCleanup } from './playwright-process-owner.js';
export interface PlaywrightReady { transport: PlaywrightReadOnlyTransport; tabId: number; browserVersion: string }

/** Read-only P1 policy; process custody is shared without sharing action authority. */
export class PlaywrightBrowserOwner {
  readonly #process: PlaywrightProcessOwner;
  readonly #abort = new AbortController();
  #failure: PlaywrightFailureCode | undefined;
  constructor(private readonly input: PlaywrightBinding & { signal: AbortSignal },
    dependencies: PlaywrightOwnerDependencies = {}) {
    this.#process = new PlaywrightProcessOwner(input, dependencies);
  }
  get receiptPath(): string { return this.#process.receiptPath; }
  async start(): Promise<PlaywrightReady> {
    const ready = await this.#process.start(async (browser, signal, deadline) => {
      const stop = () => this.#stop('cancelled');
      signal.addEventListener('abort', stop, { once: true });
      if (signal.aborted) stop();
      const page = await this.#createPage(browser, deadline);
      return new PlaywrightReadOnlyTransport({ ...this.input, page, signal: this.#abort.signal,
        close: async () => { if (!(await this.close()).confirmed) throw new PlaywrightDiagnosticError('cleanup_pending'); } });
    }).catch(error => { this.#assert(); throw error; });
    return { transport: ready.value, tabId: 1, browserVersion: ready.browserVersion };
  }
  close() { this.#stop('browser_closed'); return this.#process.close(); }
  finishReceipt(confirmed: boolean, code: PlaywrightFailureCode | null, success: boolean): void {
    this.#process.finishReceipt(confirmed, code, success);
  }
  async #createPage(browser: Browser, deadline: number): Promise<Page> {
    const context = await browser.newContext({ serviceWorkers: 'block', acceptDownloads: false, javaScriptEnabled: false });
    this.#assert();
    let page: Page | undefined;
    context.on('page', candidate => {
      if (page && candidate !== page) { this.#stop('page_rejected'); void candidate.close().catch(() => {}); }
    });
    await context.route('**/*', async route => {
      const request = route.request();
      let allowed = false;
      try { allowed = !this.#abort.signal.aborted && request.method() === 'GET' &&
        request.url() === `${SYNTHETIC_PORTAL_ORIGIN}/` && !!page && request.frame() === page.mainFrame(); } catch { /* Reject frameless requests. */ }
      try {
        if (allowed) {
          // continue() follows redirect hops without re-entering the route guard.
          // Fetch only this approved URL, with redirects/retries disabled, and
          // expose a response to the page only while the same run is current.
          const response = await route.fetch({ maxRedirects: 0, maxRetries: 0, timeout: 10_000 });
          try {
            if (this.#abort.signal.aborted || response.url() !== `${SYNTHETIC_PORTAL_ORIGIN}/` ||
                response.status() !== 200) {
              this.#stop('page_rejected'); await route.abort('blockedbyclient');
            } else await route.fulfill({ response });
          } finally { await response.dispose(); }
        }
        else { this.#stop('page_rejected'); await route.abort('blockedbyclient'); }
      } catch { this.#stop('page_rejected'); }
    });
    this.#assert();
    await context.routeWebSocket('**/*', socket => { this.#stop('page_rejected'); void socket.close().catch(() => {}); });
    this.#assert(); page = await context.newPage(); this.#assert();
    page.on('close', () => this.#stop('browser_closed'));
    page.on('download', download => { this.#stop('page_rejected'); void download.cancel().catch(() => {}); });
    page.on('frameattached', () => this.#stop('page_rejected'));
    page.on('framenavigated', frame => {
      if (frame !== page!.mainFrame() || page!.url() !== `${SYNTHETIC_PORTAL_ORIGIN}/`) this.#stop('page_rejected');
    });
    await page.goto(`${SYNTHETIC_PORTAL_ORIGIN}/`, { waitUntil: 'domcontentloaded', timeout: Math.max(1, deadline - Date.now()) });
    this.#assert(); return page;
  }

  #stop(code: PlaywrightFailureCode): void { this.#failure ??= code; this.#abort.abort(); }
  #assert(): void { if (this.#failure) throw new PlaywrightDiagnosticError(this.#failure); }
}
