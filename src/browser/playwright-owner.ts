import { randomUUID } from 'node:crypto';
import { accessSync, constants, lstatSync, mkdtempSync, readFileSync, realpathSync, renameSync,
  rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type { Browser, BrowserServer, BrowserType, Page } from 'playwright';
import { PlaywrightReadOnlyTransport, type PlaywrightBinding } from './playwright-transport.js';
import { bounded, failureCode, PlaywrightDiagnosticError, type PlaywrightFailureCode } from './playwright-errors.js';
import { SYNTHETIC_PORTAL_ORIGIN } from './types.js';

export interface PlaywrightOwnerDependencies {
  /** Trusted composition seams, never exposed through CLI arguments or model tools. */
  loadChromium?: () => Promise<BrowserType>;
  environment?: NodeJS.ProcessEnv;
  setupTimeoutMs?: number;
  shutdownTimeoutMs?: number;
}
export interface PlaywrightCleanup { confirmed: boolean }
export interface PlaywrightReady { transport: PlaywrightReadOnlyTransport; tabId: number; browserVersion: string }
interface Receipt {
  schemaVersion: 1; runId: string; phase: 'prepared' | 'launching' | 'owned' | 'reading' | 'closed';
  cleanup: 'pending' | 'confirmed'; code: PlaywrightFailureCode | null;
  browserPid: number | null; profilePath: string | null;
}
function budget(value: number | undefined, limit: number): number {
  if (value === undefined) return limit;
  if (!Number.isSafeInteger(value) || value < 1 || value > limit) throw new PlaywrightDiagnosticError('protocol_rejected');
  return value;
}
function absent(path: string): boolean {
  try { lstatSync(path); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT'; }
}

/** Owns exactly one launch attempt, including uncertain and late settlement. */
export class PlaywrightBrowserOwner {
  readonly receiptPath: string;
  readonly #receipt: Receipt;
  readonly #abort = new AbortController();
  readonly #setupMs: number;
  readonly #shutdownMs: number;
  #server: BrowserServer | undefined;
  #serverClosed = false;
  #launched = false;
  #started = false;
  #closing = false;
  #closePromise: Promise<PlaywrightCleanup> | undefined;
  #failure: PlaywrightFailureCode | undefined;
  #finalized = false;
  #launchDone: Promise<void> | undefined;
  #closeSettled = false;
  readonly #onAbort = () => this.#stop('cancelled');

  constructor(private readonly input: PlaywrightBinding & { signal: AbortSignal },
    private readonly dependencies: PlaywrightOwnerDependencies = {}) {
    this.#setupMs = budget(dependencies.setupTimeoutMs, 15_000);
    this.#shutdownMs = budget(dependencies.shutdownTimeoutMs, 5_000);
    const root = mkdtempSync(join(realpathSync(tmpdir()), 'behalvo-playwright-'));
    this.receiptPath = join(root, 'receipt.json');
    this.#receipt = { schemaVersion: 1, runId: randomUUID(), phase: 'prepared', cleanup: 'pending',
      code: null, browserPid: null, profilePath: null };
    this.#write();
    input.signal.addEventListener('abort', this.#onAbort, { once: true });
    if (input.signal.aborted) this.#onAbort();
  }

  async start(): Promise<PlaywrightReady> {
    if (this.#started) throw new PlaywrightDiagnosticError('protocol_rejected');
    this.#started = true;
    const deadline = Date.now() + this.#setupMs;
    const wait = <T>(promise: Promise<T>) => bounded(promise, deadline - Date.now(), 'setup_timeout', this.#abort.signal);
    try {
      this.#assert();
      const environment = this.dependencies.environment ?? process.env;
      for (const [key, value] of Object.entries(environment)) {
        const name = key.toUpperCase().replace(/^NPM_CONFIG_/, '').replace(/^NPM_PACKAGE_CONFIG_/, '');
        if (value && (/^(SELENIUM_|PLAYWRIGHT_|PW_|PWDEBUG$|DEBUG$)/.test(name)))
          throw new PlaywrightDiagnosticError('unsafe_environment');
      }
      const chromium = await wait((this.dependencies.loadChromium ?? (async () => (await import('playwright')).chromium))());
      this.#assert();
      try { accessSync(chromium.executablePath(), constants.X_OK); }
      catch { throw new PlaywrightDiagnosticError('browser_missing'); }
      const childEnvironment: Record<string, string> = {};
      for (const key of ['PATH', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'TZ', 'DISPLAY', 'XAUTHORITY', 'SYSTEMROOT', 'WINDIR']) {
        if (environment[key]) childEnvironment[key] = environment[key]!;
      }
      this.#receipt.phase = 'launching'; this.#write(); this.#launched = true;
      const launch = chromium.launchServer({ host: '127.0.0.1', port: 0, headless: false,
        chromiumSandbox: true, handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false,
        timeout: Math.max(1, deadline - Date.now()), env: childEnvironment });
      // Register ownership before racing cancellation; late handles never become usable.
      const ownedLaunch = launch.then(async server => {
        this.#server = server;
        server.on('close', () => { this.#serverClosed = true; this.#stop('browser_closed'); });
        try { this.#captureProfile(server); }
        catch {
          if (this.#closeSettled) await this.#retireServer(server, Date.now() + this.#shutdownMs);
          throw new PlaywrightDiagnosticError('launch_failed');
        }
        if (this.#closing || this.#abort.signal.aborted) {
          if (this.#closeSettled) await this.#retireServer(server, Date.now() + this.#shutdownMs);
          throw new PlaywrightDiagnosticError('cancelled');
        }
        return server;
      });
      this.#launchDone = ownedLaunch.then(() => {}, () => {});
      const server = await wait(ownedLaunch); this.#assert();
      const endpoint = server.wsEndpoint();
      const url = new URL(endpoint);
      if (url.protocol !== 'ws:' || url.hostname !== '127.0.0.1' || !url.port || url.pathname === '/' || url.username || url.password)
        throw new PlaywrightDiagnosticError('launch_failed');
      const connection = chromium.connect(endpoint, { timeout: Math.max(1, deadline - Date.now()) });
      void connection.then(browser => { if (this.#closing) void browser.close().catch(() => {}); }, () => {});
      const browser = await wait(connection); this.#assert();
      browser.on('disconnected', () => this.#stop('browser_closed'));
      const page = await wait(this.#createPage(browser)); this.#assert();
      const browserVersion = browser.version();
      if (!/^\d+(?:\.\d+){1,4}$/.test(browserVersion)) throw new PlaywrightDiagnosticError('launch_failed');
      this.#receipt.phase = 'reading'; this.#write();
      const transport = new PlaywrightReadOnlyTransport({ ...this.input, page, signal: this.#abort.signal,
        close: async () => { if (!(await this.close()).confirmed) throw new PlaywrightDiagnosticError('cleanup_pending'); } });
      return { transport, tabId: 1, browserVersion };
    } catch (error) {
      const code = this.#failure ?? failureCode(error, 'launch_failed'); this.#stop(code);
      this.#receipt.code = code; this.#write(); throw new PlaywrightDiagnosticError(code);
    }
  }

  close(): Promise<PlaywrightCleanup> {
    if (this.#closePromise) return this.#closePromise;
    this.#closing = true; this.#stop('browser_closed');
    this.input.signal.removeEventListener('abort', this.#onAbort);
    this.#closePromise = (async () => {
      const deadline = Date.now() + this.#shutdownMs;
      if (!this.#server && this.#launchDone) {
        try { await bounded(this.#launchDone, deadline - Date.now(), 'cleanup_pending'); } catch { /* Retain unknown ownership. */ }
      }
      const confirmed = this.#server && Date.now() < deadline ? await this.#retireServer(this.#server, deadline) : !this.#launched;
      this.#closeSettled = true;
      if (!this.#finalized) {
        this.#receipt.cleanup = confirmed ? 'confirmed' : 'pending';
        this.#receipt.phase = confirmed ? 'closed' : this.#receipt.phase;
        if (!confirmed) this.#receipt.code = 'cleanup_pending';
      }
      this.#write(); return { confirmed };
    })();
    return this.#closePromise;
  }

  /** Coordinator calls only after its portal and session also settled. */
  finishReceipt(confirmed: boolean, code: PlaywrightFailureCode | null, success: boolean): void {
    this.#finalized = true;
    this.#receipt.cleanup = confirmed ? 'confirmed' : 'pending'; this.#receipt.code = code; this.#write();
    if (success && confirmed) {
      // Compare the exact owned receipt, then remove only it and its now-empty directory.
      if (readFileSync(this.receiptPath, 'utf8') !== JSON.stringify(this.#receipt) + '\n')
        throw new PlaywrightDiagnosticError('cleanup_pending');
      unlinkSync(this.receiptPath); rmdirSync(dirname(this.receiptPath));
    }
  }

  async #createPage(browser: Browser): Promise<Page> {
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
    await page.goto(`${SYNTHETIC_PORTAL_ORIGIN}/`, { waitUntil: 'domcontentloaded', timeout: this.#setupMs });
    this.#assert(); return page;
  }

  #captureProfile(server: BrowserServer): void {
    const child = server.process();
    const args = child.spawnargs.filter(arg => arg.startsWith('--user-data-dir='));
    if (args.length !== 1 || !child.pid) throw new PlaywrightDiagnosticError('launch_failed');
    const path = args[0]!.slice('--user-data-dir='.length);
    const canonical = realpathSync(path); const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 ||
        dirname(canonical) !== realpathSync(tmpdir()) || !basename(canonical).startsWith('playwright_chromiumdev_profile-'))
      throw new PlaywrightDiagnosticError('launch_failed');
    this.#receipt.browserPid = child.pid; this.#receipt.profilePath = canonical;
    this.#receipt.phase = 'owned'; this.#write();
  }

  async #retireServer(server: BrowserServer, deadline: number): Promise<boolean> {
    const gone = () => {
      const child = server.process();
      return (child.exitCode !== null || child.signalCode !== null) && this.#serverClosed &&
        this.#receipt.profilePath !== null && absent(this.#receipt.profilePath);
    };
    try { await bounded(server.close(), Math.max(1, (deadline - Date.now()) * 0.6), 'cleanup_pending'); } catch { /* Escalate owned process only. */ }
    if (gone()) return true;
    const child = server.process();
    if (Date.now() < deadline && child.exitCode === null && child.signalCode === null) {
      try { await bounded(server.kill(), deadline - Date.now(), 'cleanup_pending'); } catch { /* Unconfirmed, not success. */ }
    }
    return gone();
  }
  #write(): void {
    const staged = `${this.receiptPath}.next`;
    writeFileSync(staged, JSON.stringify(this.#receipt) + '\n', { mode: 0o600, flag: 'wx' });
    renameSync(staged, this.receiptPath);
  }
  #stop(code: PlaywrightFailureCode): void { this.#failure ??= code; this.#abort.abort(); }
  #assert(): void { if (this.#failure || this.#closing || this.#abort.signal.aborted) throw new PlaywrightDiagnosticError(this.#failure ?? 'cancelled'); }
}
