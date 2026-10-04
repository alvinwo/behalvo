import { randomBytes } from 'node:crypto';
import type { Frame, Page, Route } from 'playwright';
import type { BrowserSessionTransport } from './session.js';
import type { PlaywrightBinding } from './playwright-transport.js';
import { parseBrowserRequest, parseBrowserGesture, parseBrowserResponse, SYNTHETIC_PORTAL_ORIGIN,
  type BrowserEpoch, type BrowserRequest, type BrowserResponse, type BrowserPageSnapshot } from './types.js';
import { bounded, PlaywrightDiagnosticError } from './playwright-errors.js';
import { capturePlaywrightSource, preparePlaywrightForm, activatePlaywrightForm } from './playwright-actions-dom.js';
const rootUrl = `${SYNTHETIC_PORTAL_ORIGIN}/`, formUrl = `${SYNTHETIC_PORTAL_ORIGIN}/gesture`;
const random = () => randomBytes(32).toString('hex');
function deferred() {
  let resolve!: () => void, reject!: (error: unknown) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  void promise.catch(() => {}); return { promise, resolve, reject };
}
interface Permit {
  request: Extract<BrowserRequest, { kind: 'gesture' }>; document: string; token: string;
  deadline: number; signal: AbortSignal; authorize: () => Promise<() => void>;
  phase: 'armed' | 'dispatched' | 'fulfilled'; done: ReturnType<typeof deferred>;
}

/** Synthetic-only protocol. No page, script, selector or endpoint is exposed to callers. */
export class PlaywrightActionsTransport implements BrowserSessionTransport {
  #epoch: string | undefined;
  #sequence = 0;
  #document = random();
  #phase: 'unbound' | 'active' | 'human' | 'terminal' = 'unbound';
  #retired = new Set<string>();
  #busy = false;
  #initialized = false;
  #stopped = new AbortController();
  #epochStop = new AbortController();
  #load: { deadline: number; used: boolean } | undefined;
  #navigationExpected = false;
  #permit: Permit | undefined;
  #routes = new Set<Promise<void>>();
  #closePromise: Promise<void> | undefined;
  readonly #onStop = () => this.#fail();
  readonly #onNavigation = (frame: Frame) => {
    if (frame !== this.options.page.mainFrame() || !this.#navigationExpected || !this.#validUrl()) { this.#fail(); return; }
    this.#navigationExpected = false; this.#document = random();
  };
  constructor(private readonly options: PlaywrightBinding & { page: Page; signal: AbortSignal;
    runDeadline: number; close: () => Promise<void> }) {
    options.signal.addEventListener('abort', this.#onStop, { once: true });
    if (options.signal.aborted) this.#fail();
  }
  async initialize(deadline: number): Promise<void> {
    if (this.#initialized) throw new PlaywrightDiagnosticError('protocol_rejected');
    this.#initialized = true;
    const page = this.options.page, context = page.context();
    page.on('close', this.#onStop); context.on('close', this.#onStop);
    context.browser()?.on('disconnected', this.#onStop);
    page.on('framenavigated', this.#onNavigation);
    page.on('frameattached', this.#onStop);
    page.on('download', download => { this.#fail(); void download.cancel().catch(() => {}); });
    context.on('page', other => { if (other !== page) { this.#fail(); void other.close().catch(() => {}); } });
    await context.route('**/*', route => {
      const running = this.#route(route).catch(async () => { this.#fail(); await route.abort().catch(() => {}); });
      this.#routes.add(running); void running.finally(() => this.#routes.delete(running)); return running;
    });
    await context.routeWebSocket('**/*', socket => { this.#fail(); void socket.close().catch(() => {}); });
    await this.#loadRoot(Math.min(deadline, this.options.runDeadline));
  }
  async inspect(input: BrowserRequest): Promise<BrowserResponse> {
    let source: Awaited<ReturnType<typeof capturePlaywrightSource>> | undefined;
    try {
      const request = this.#admit(input, false); this.#busy = true;
      const deadline = Math.min(Date.now() + 10_000, this.options.runDeadline);
      if (this.#phase === 'human') {
        this.#epoch = request.epoch; this.#sequence = request.sequence; this.#phase = 'active';
        this.#epochStop = new AbortController(); await this.#loadRoot(deadline);
      }
      const document = this.#document;
      source = await this.#wait(capturePlaywrightSource(this.options.page), deadline);
      this.#assert(document);
      if (request.kind === 'inspect' && source.snapshot.state !== request.expectedPageState)
        throw new PlaywrightDiagnosticError('page_rejected');
      return this.#response(request, source.snapshot, document);
    } catch { this.#fail(); throw new PlaywrightDiagnosticError('page_rejected'); }
    finally { this.#busy = false; if (source) void source.root.dispose().catch(() => {}); }
  }
  async gesture(input: BrowserRequest, authorize: () => Promise<() => void>,
    authority: { deadline: number; signal: AbortSignal }): Promise<BrowserResponse> {
    let source: Awaited<ReturnType<typeof capturePlaywrightSource>> | undefined;
    let prepared: Awaited<ReturnType<typeof preparePlaywrightForm>> | undefined;
    try {
      const request = this.#admit(input, true);
      if (request.kind !== 'gesture') throw new PlaywrightDiagnosticError('protocol_rejected');
      this.#busy = true;
      const deadline = Math.min(Date.now() + 10_000, authority.deadline, this.options.runDeadline);
      const signal = AbortSignal.any([authority.signal, this.#epochStop.signal, this.#stopped.signal]);
      this.#assert(); if (signal.aborted || Date.now() >= deadline) throw new PlaywrightDiagnosticError('cancelled');
      const document = this.#document;
      source = await this.#wait(capturePlaywrightSource(this.options.page), deadline, signal); this.#assert(document);
      if (source.snapshot.state !== request.expectedPageState) throw new PlaywrightDiagnosticError('page_rejected');
      prepared = await this.#wait(preparePlaywrightForm(source.root, request.command), deadline, signal); this.#assert(document);
      const permit: Permit = { request, document, token: random(), deadline, signal, authorize,
        phase: 'armed', done: deferred() };
      this.#permit = permit;
      const navigation = this.options.page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: Math.max(1, deadline - Date.now()) });
      void navigation.catch(() => {});
      await this.#wait(activatePlaywrightForm(prepared, request.command, permit.token), deadline, signal);
      await this.#wait(Promise.all([permit.done.promise, navigation]), deadline, signal);
      this.#assert();
      if (permit.phase !== 'fulfilled' || this.#document === document) throw new PlaywrightDiagnosticError('page_rejected');
      this.#permit = undefined;
      return this.#response(request, source.snapshot, document);
    } catch { this.#fail(); throw new PlaywrightDiagnosticError('page_rejected'); }
    finally {
      this.#busy = false;
      if (prepared) { void prepared.form.dispose().catch(() => {}); void prepared.button.dispose().catch(() => {}); }
      if (source) void source.root.dispose().catch(() => {});
    }
  }
  async revoke(epoch: BrowserEpoch, tabId: number): Promise<void> {
    if (!this.#matches(epoch) || epoch.allowedOrigin !== SYNTHETIC_PORTAL_ORIGIN || tabId !== 1 ||
        !/^[a-f0-9]{64}$/.test(epoch.epoch) || (this.#epoch !== undefined && epoch.epoch !== this.#epoch)) {
      this.#fail(); throw new PlaywrightDiagnosticError('protocol_rejected');
    }
    if (this.#retired.has(epoch.epoch)) return;
    const active = this.#busy || this.#routes.size > 0;
    this.#epochStop.abort();
    if (this.#permit) this.#permit.done.reject(new PlaywrightDiagnosticError('cancelled'));
    this.#permit = undefined;
    if (active) {
      this.#fail(); await bounded(this.options.close(), 5_000, 'cleanup_pending');
      throw new PlaywrightDiagnosticError('page_rejected');
    }
    this.#assert();
    if (this.#retired.size >= 1_024) { this.#fail(); throw new PlaywrightDiagnosticError('protocol_rejected'); }
    this.#retired.add(epoch.epoch); this.#phase = 'human'; this.#sequence = 0;
  }
  async reconcileRevocation(epoch: BrowserEpoch, tabId: number): Promise<void> {
    this.#assert();
    if (!this.#matches(epoch) || epoch.allowedOrigin !== SYNTHETIC_PORTAL_ORIGIN || tabId !== 1 || !this.#retired.has(epoch.epoch))
      throw new PlaywrightDiagnosticError('protocol_rejected');
  }
  close(): Promise<void> {
    this.#fail();
    this.#closePromise ??= Promise.resolve().then(async () => {
      this.options.signal.removeEventListener('abort', this.#onStop);
      await this.options.close();
    }); return this.#closePromise;
  }
  async #loadRoot(deadline: number): Promise<void> {
    this.#load = { deadline, used: false };
    try {
      await this.#wait(this.options.page.goto(rootUrl, { waitUntil: 'domcontentloaded', timeout: Math.max(1, deadline - Date.now()) }), deadline);
      this.#assert();
    } finally { this.#load = undefined; }
  }
  async #route(route: Route): Promise<void> {
    const request = route.request(); this.#assert();
    if (request.frame() !== this.options.page.mainFrame() || !request.isNavigationRequest()) throw new PlaywrightDiagnosticError('page_rejected');
    const permit = this.#permit;
    let deadline: number, signal: AbortSignal, expected: string;
    if (request.method() === 'GET' && request.url() === rootUrl && this.#load && !this.#load.used) {
      this.#load.used = true; deadline = this.#load.deadline; signal = this.#stopped.signal; expected = rootUrl;
      this.#navigationExpected = true;
    } else {
      if (!permit || permit.phase !== 'armed' || request.method() !== 'POST' || request.url() !== formUrl ||
          request.headers().origin !== SYNTHETIC_PORTAL_ORIGIN ||
          request.headers()['content-type'] !== 'application/x-www-form-urlencoded') throw new PlaywrightDiagnosticError('page_rejected');
      const body = request.postData();
      if (!body || Buffer.byteLength(body) > 8192) throw new PlaywrightDiagnosticError('page_rejected');
      const fields = new URLSearchParams(body), entries = [...fields];
      if (new Set(entries.map(([key]) => key)).size !== entries.length || fields.get('_behalvo_dispatch') !== permit.token)
        throw new PlaywrightDiagnosticError('page_rejected');
      fields.delete('_behalvo_dispatch');
      if (JSON.stringify(parseBrowserGesture(Object.fromEntries(fields))) !== JSON.stringify(permit.request.command))
        throw new PlaywrightDiagnosticError('page_rejected');
      const finalGuard = await this.#wait(permit.authorize(), permit.deadline, permit.signal);
      this.#assert(permit.document);
      if (this.#permit !== permit || permit.phase !== 'armed' || permit.signal.aborted || Date.now() >= permit.deadline)
        throw new PlaywrightDiagnosticError('cancelled');
      finalGuard();
      permit.phase = 'dispatched'; this.#navigationExpected = true;
      deadline = permit.deadline; signal = permit.signal; expected = formUrl;
    }
    // Synchronous guard/permit consumption above and this invocation share one JS turn.
    const dispatched = route.fetch({ maxRedirects: 0, maxRetries: 0, timeout: Math.max(1, deadline - Date.now()) });
    void dispatched.then(response => { if (this.#stopped.signal.aborted) void response.dispose().catch(() => {}); }, () => {});
    const response = await this.#wait(dispatched, deadline, signal);
    try {
      const headers = response.headers(), status = response.status();
      if (response.url() !== expected || headers.location !== undefined || ![200, 403, 429].includes(status) ||
          !/^text\/html(?:;\s*charset=utf-8)?$/i.test(headers['content-type'] ?? '')) throw new PlaywrightDiagnosticError('page_rejected');
      const body = await this.#wait(response.body(), deadline, signal);
      if (body.byteLength > 262_144 || (status !== 200 && !body.includes(`data-behalvo-page-state="${status === 403 ? 'forbidden' : 'rate_limited'}"`)))
        throw new PlaywrightDiagnosticError('page_rejected');
      this.#assert(); if (signal.aborted || Date.now() >= deadline) throw new PlaywrightDiagnosticError('cancelled');
      await this.#wait(route.fulfill({ response, body }), deadline, signal);
      if (expected === formUrl && permit) { permit.phase = 'fulfilled'; permit.done.resolve(); }
    } finally { await response.dispose().catch(() => {}); }
  }
  #admit(input: BrowserRequest, gesture: boolean): BrowserRequest {
    this.#assert(); if (!this.#initialized || this.#busy) throw new PlaywrightDiagnosticError('protocol_rejected');
    const request = parseBrowserRequest(input);
    if (!this.#matches(request) || request.origin !== SYNTHETIC_PORTAL_ORIGIN || request.tabId !== 1 ||
        (request.kind === 'gesture') !== gesture || this.#retired.has(request.epoch)) throw new PlaywrightDiagnosticError('protocol_rejected');
    if (this.#phase === 'human') {
      if (gesture || request.kind !== 'recognize' || request.sequence !== 1) throw new PlaywrightDiagnosticError('protocol_rejected');
    } else {
      if (request.sequence !== this.#sequence + 1 || (this.#epoch !== undefined && request.epoch !== this.#epoch) ||
          (this.#epoch === undefined && request.kind !== 'recognize')) throw new PlaywrightDiagnosticError('protocol_rejected');
      this.#epoch ??= request.epoch; this.#sequence = request.sequence; this.#phase = 'active';
    }
    return request;
  }
  #matches(value: PlaywrightBinding): boolean { return value.profileId === this.options.profileId &&
    value.connectionGeneration === this.options.connectionGeneration && value.serviceGeneration === this.options.serviceGeneration; }
  #validUrl(): boolean { return [rootUrl, formUrl].includes(this.options.page.url()); }
  #assert(document = this.#document): void {
    if (this.#phase === 'terminal' || this.options.signal.aborted || Date.now() >= this.options.runDeadline ||
        this.options.page.isClosed() || !this.options.page.context().browser()?.isConnected() || document !== this.#document)
      throw new PlaywrightDiagnosticError('page_rejected');
  }
  #wait<T>(operation: Promise<T>, deadline: number, signal = this.#stopped.signal): Promise<T> {
    return bounded(operation, deadline - Date.now(), 'observation_timeout', signal);
  }
  #fail(): void {
    this.#phase = 'terminal'; this.#stopped.abort(); this.#epochStop.abort(); this.#navigationExpected = false;
    this.#permit?.done.reject(new PlaywrightDiagnosticError('page_rejected')); this.#permit = undefined;
  }
  #response(request: BrowserRequest, snapshot: BrowserPageSnapshot, documentId: string): BrowserResponse {
    const { protocolVersion, requestId, profileId, connectionGeneration, epoch, serviceGeneration, origin, tabId, sequence } = request;
    return parseBrowserResponse({ protocolVersion, requestId, profileId, connectionGeneration, epoch, serviceGeneration,
      origin, tabId, sequence, kind: 'result', documentId, pageState: snapshot.state, snapshot });
  }
}
