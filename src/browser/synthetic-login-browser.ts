import { randomUUID } from 'node:crypto';
import type { Browser, Page } from 'playwright';
import { PlaywrightProcessOwner, type PlaywrightOwnerDependencies } from './playwright-process-owner.js';
import { assertExecutionActive } from '../operations/execution-context.js';
import { parseBrowserCommand, resolveControl, sameScope, validateObservation } from './semantic-validation.js';
import type { BrowserCommand, BrowserExecution, BrowserObservation, BrowserScope, SemanticBrowserPort, BrowserLoginOutcome } from './semantic-types.js';
import { assertOwnedLoginFixture, type SyntheticLoginFixtureAuthority } from './synthetic-login-fixture.js';
import { vaultMessage } from '../vault/messages.js';

/** One terminal synthetic login; no general authenticated DOM or browser capability. */
export class SyntheticLoginBrowser implements SemanticBrowserPort {
  readonly #owner: PlaywrightProcessOwner;
  #page: Page | undefined;
  #scope: BrowserScope | undefined;
  #observation: BrowserObservation | undefined;
  #documentId = randomUUID();
  #current: BrowserExecution | undefined;
  #busy = false; #closed = false; #attempted = false; #dispatched = false;
  #initialGet = false;
  #permit: { body: string; check(): void; used: boolean } | undefined;
  #cleanup: Promise<{confirmed: boolean}> | undefined;
  constructor(private readonly authority: SyntheticLoginFixtureAuthority, signal: AbortSignal,
    dependencies: PlaywrightOwnerDependencies = {}) {
    assertOwnedLoginFixture(authority); this.#owner = new PlaywrightProcessOwner({ signal }, dependencies);
  }
  #check(): void {
    if (!this.#current) throw new Error('Synthetic login unavailable');
    assertExecutionActive(this.#current.execution); this.#current.assertCurrent(); assertOwnedLoginFixture(this.authority);
    if (this.#scope) sameScope(this.#scope, this.#current);
  }
  #live(): void { this.#check(); if (this.#closed) throw new Error('Synthetic browser closed'); }
  #timeout(): number { return Math.max(1, Math.min(10000, this.#current!.execution.deadline - Date.now())); }
  async #start(browser: Browser): Promise<Page> {
    const context = await browser.newContext({ javaScriptEnabled: false, serviceWorkers: 'block', acceptDownloads: false }); this.#live();
    let page: Page | undefined;
    context.on('page', candidate => { if (page && candidate !== page) { void candidate.close().catch(() => {}); void this.close(); } });
    await context.route('**/*', async route => {
      const request = route.request();
      try {
        this.#live();
        if (!page || request.frame() !== page.mainFrame() || request.resourceType() !== 'document') throw new Error();
        if (request.method() === 'GET' && request.url() === this.authority.origin + '/' && this.#initialGet) this.#initialGet = false;
        else {
          const permit = this.#permit;
          if (request.method() !== 'POST' || request.url() !== this.authority.origin + '/login' || !permit || permit.used ||
              request.headers()['content-type'] !== 'application/x-www-form-urlencoded' || request.postData() !== permit.body) throw new Error();
          this.#live(); permit.check(); permit.used = true; this.#dispatched = true;
        }
        const response = await route.fetch({ maxRedirects: 0, maxRetries: 0, timeout: this.#timeout() });
        try {
          this.#live();
          if (response.status() !== 200 || response.url() !== request.url() || response.headers()['content-disposition'] ||
              !response.headers()['content-type']?.startsWith('text/html')) throw new Error();
          const body = await response.body(); this.#live(); if (body.length > 16384) throw new Error();
          await route.fulfill({ status: 200, headers: { 'content-type': 'text/html; charset=utf-8',
            'content-security-policy': "default-src 'none'; form-action 'self'; frame-src 'none'" }, body });
        } finally { await response.dispose(); }
      } catch { await route.abort('blockedbyclient').catch(() => {}); }
    });
    await context.routeWebSocket('**/*', socket => { void socket.close().catch(() => {}); }); this.#live();
    page = await context.newPage(); this.#live(); this.#page = page;
    page.on('framenavigated', frame => { if (frame === page!.mainFrame()) this.#documentId = randomUUID(); });
    page.on('frameattached', () => { void this.close(); });
    page.on('download', download => { void download.cancel().catch(() => {}); void this.close(); });
    this.#initialGet = true;
    await page.goto(this.authority.origin + '/', { waitUntil: 'domcontentloaded', timeout: this.#timeout() }); this.#live();
    return page;
  }
  async #validForm(): Promise<void> {
    this.#live();
    const valid = await this.#page!.evaluate(origin => {
      const form = document.querySelector('#behalvo-login');
      if (location.href !== origin + '/' || !(form instanceof HTMLFormElement) || document.forms.length !== 1 ||
          form.method !== 'post' || form.action !== origin + '/login' || form.target ||
          form.enctype !== 'application/x-www-form-urlencoded' || form.elements.length !== 3 || document.querySelector('iframe')) return false;
      const [user, pass, button] = Array.from(form.elements);
      return user instanceof HTMLInputElement && user.name === 'username' && user.type === 'text' && !user.disabled && user.form === form &&
        pass instanceof HTMLInputElement && pass.name === 'password' && pass.type === 'password' && !pass.disabled && pass.form === form &&
        button instanceof HTMLButtonElement && button.type === 'submit' && !button.disabled && button.form === form &&
        !['formaction', 'formmethod', 'formtarget', 'formenctype'].some(name => button.hasAttribute(name));
    }, this.authority.origin); this.#live();
    if (!valid) throw new Error('Synthetic login form changed');
  }
  #snapshot(text: string, controls: BrowserObservation['controls'] = []): BrowserObservation {
    return validateObservation({ ...this.#scope, id: randomUUID(), documentId: this.#documentId,
      origin: this.authority.origin, location: this.#dispatched ? '/login' : '/', observedAt: new Date().toISOString(), text, controls }, this.#scope!);
  }
  async observe(context: BrowserExecution): Promise<BrowserObservation> {
    if (this.#busy || this.#closed || this.#attempted) throw new Error('Synthetic browser unavailable');
    this.#busy = true; this.#current = context;
    try {
      this.#live();
      if (!this.#page) {
        this.#scope = { workspaceId: context.workspaceId, workId: context.workId, workRevision: context.workRevision,
          sessionId: context.sessionId, generation: context.generation };
        await this.#owner.start(browser => this.#start(browser)); this.#live();
      }
      const documentId = this.#documentId; await this.#validForm();
      if (documentId !== this.#documentId) throw new Error('Stale synthetic page');
      this.#observation = this.#snapshot(vaultMessage('fixture'),
        [{ ref: randomUUID(), role: 'login', name: vaultMessage('loginControl'), actions: ['request_login'], options: [] }]);
      return this.#observation;
    } catch { throw new Error('Synthetic browser unavailable'); }
    finally { this.#current = undefined; this.#busy = false; }
  }
  async interact(context: BrowserExecution, raw: BrowserCommand): Promise<BrowserObservation> {
    if (this.#busy || this.#closed || this.#attempted || !this.#observation) throw new Error('Synthetic browser unavailable');
    const command = parseBrowserCommand(raw); resolveControl(this.#observation, context, command);
    if (command.kind !== 'request_login') throw new Error('Synthetic login command required');
    this.#attempted = true; this.#busy = true; this.#current = context;
    const documentId = this.#observation.documentId;
    const checkUse = () => {
      this.#check();
      // Before dispatch this binds the exact page. Afterwards it permits only
      // recognized settlement and closure, never another gesture.
      if (!this.#dispatched && (this.#closed || this.#documentId !== documentId ||
          this.#page?.url() !== this.authority.origin + '/')) throw new Error('Stale login authority');
    };
    let status: Parameters<typeof vaultMessage>[0] = 'stopped';
    try {
      checkUse(); await this.#validForm(); checkUse();
      if (!context.login) status = 'unavailableLogin';
      else {
        const result = await context.login({ ...this.#scope!, documentId, observationId: this.#observation.id,
          ref: command.ref, origin: this.authority.origin }, async (login, guard): Promise<BrowserLoginOutcome> => {
          try {
            checkUse(); guard(); await this.#validForm(); checkUse(); guard();
            const username = new TextDecoder().decode(login.username), password = new TextDecoder().decode(login.password);
            this.#permit = { body: new URLSearchParams({ username, password }).toString(), check: () => { checkUse(); guard(); }, used: false };
            const navigation = this.#page!.waitForURL(this.authority.origin + '/login', { waitUntil: 'domcontentloaded', timeout: this.#timeout() });
            void navigation.catch(() => {});
            // One application-owned evaluation checks the form again in the
            // page immediately before writing values and submitting it.
            const filled = await this.#page!.evaluate(({ origin, username, password }) => {
              const form = document.querySelector('#behalvo-login');
              if (location.href !== origin + '/' || !(form instanceof HTMLFormElement) || document.forms.length !== 1 ||
                  form.method !== 'post' || form.action !== origin + '/login' || form.target || form.enctype !== 'application/x-www-form-urlencoded' ||
                  form.elements.length !== 3 || document.querySelector('iframe')) return false;
              const [user, pass, button] = Array.from(form.elements);
              if (!(user instanceof HTMLInputElement) || user.name !== 'username' || user.type !== 'text' || user.disabled || user.form !== form ||
                  !(pass instanceof HTMLInputElement) || pass.name !== 'password' || pass.type !== 'password' || pass.disabled || pass.form !== form ||
                  !(button instanceof HTMLButtonElement) || button.type !== 'submit' || button.disabled || button.form !== form ||
                  ['formaction','formmethod','formtarget','formenctype'].some(name => button.hasAttribute(name))) return false;
              user.value = username; pass.value = password;
              if (user.value !== username || pass.value !== password) { user.value = ''; pass.value = ''; return false; }
              form.requestSubmit(button); return true;
            }, { origin: this.authority.origin, username, password });
            if (!filled) throw new Error('Form changed');
            await navigation; checkUse(); guard();
            if (!this.#dispatched || this.#page!.url() !== this.authority.origin + '/login') throw new Error();
            const recognized = await this.#page!.evaluate(() => {
              const main = document.body.firstElementChild;
              if (document.body.children.length !== 1 || !(main instanceof HTMLElement) || main.tagName !== 'MAIN' || main.childNodes.length) return null;
              return main.dataset.behalvoLogin === 'signed_in' ? 'signed_in' : main.dataset.behalvoLogin === 'rejected' ? 'rejected' : null;
            }); checkUse(); guard();
            if (!recognized) throw new Error(); return recognized;
          } catch { if (this.#dispatched) return 'unknown'; throw new Error('Login stopped'); }
          finally {
            this.#permit = undefined;
            if (!(await this.close()).confirmed) throw new Error('Cleanup unconfirmed');
          }
        }, checkUse);
        status = result.status === 'used' ? result.value === 'signed_in' ? 'signedIn' : result.value === 'rejected' ? 'rejected' : 'unknown'
          : this.#dispatched ? 'unknown' : result.status === 'skipped' ? 'skipped' : result.status === 'unavailable' ? 'unavailableLogin' : 'stopped';
      }
    } catch { status = this.#dispatched ? 'unknown' : 'stopped'; }
    finally {
      if (!(await this.close()).confirmed) status = 'cleanupPending';
      this.#permit = undefined; this.#current = undefined; this.#busy = false;
    }
    return this.#snapshot(vaultMessage(status));
  }
  close(): Promise<{confirmed: boolean}> {
    this.#closed = true; this.#permit = undefined;
    this.#cleanup ??= this.#owner.close().then(result => { this.#owner.finishReceipt(result.confirmed, null, result.confirmed); return result; });
    return this.#cleanup;
  }
}
