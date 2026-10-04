import { randomBytes } from 'node:crypto';
import type { Page } from 'playwright';
import type { BrowserSessionTransport } from './session.js';
import { parseBrowserRequest, SYNTHETIC_PORTAL_ORIGIN, type BrowserEpoch,
  type BrowserRequest, type BrowserResponse } from './types.js';
import { bounded, PlaywrightDiagnosticError, failureCode, type PlaywrightFailureCode } from './playwright-errors.js';

export interface PlaywrightBinding {
  profileId: string;
  connectionGeneration: number;
  serviceGeneration: string;
}

/** Internal adapter boundary; never provided to model tools or untrusted callers. */
export class PlaywrightReadOnlyTransport implements BrowserSessionTransport {
  #epoch: string | undefined;
  #sequence = 0;
  #document = randomBytes(32).toString('hex');
  #busy = false;
  #terminal: PlaywrightFailureCode | undefined;
  #stopped = new AbortController();
  #closePromise: Promise<void> | undefined;
  readonly #timeout: number;
  readonly #onAbort = () => this.#stop('cancelled');
  readonly #onClose = () => this.#stop('browser_closed');
  readonly #onNavigation = (frame: unknown) => {
    if (frame === this.options.page.mainFrame()) {
      this.#document = randomBytes(32).toString('hex');
      if (this.#busy || this.options.page.url() !== `${SYNTHETIC_PORTAL_ORIGIN}/`) this.#stop('page_rejected');
    }
  };

  constructor(private readonly options: PlaywrightBinding & { page: Page; signal: AbortSignal;
    close: () => Promise<void>; observationTimeoutMs?: number }) {
    this.#timeout = options.observationTimeoutMs ?? 10_000;
    if (!Number.isSafeInteger(this.#timeout) || this.#timeout < 1 || this.#timeout > 10_000)
      throw new PlaywrightDiagnosticError('protocol_rejected');
    options.signal.addEventListener('abort', this.#onAbort, { once: true });
    if (options.signal.aborted) this.#onAbort();
    options.page.on('close', this.#onClose);
    options.page.on('framenavigated', this.#onNavigation);
    options.page.context().on('close', this.#onClose);
    options.page.context().browser()?.on('disconnected', this.#onClose);
  }

  async inspect(input: BrowserRequest): Promise<BrowserResponse> {
    try {
      this.#assertCurrent();
      const request = parseBrowserRequest(input);
      if ((request.kind !== 'recognize' && request.kind !== 'inspect') ||
          (request.kind === 'inspect' && request.expectedPageState !== 'login') ||
          !this.#matches(request) || request.origin !== SYNTHETIC_PORTAL_ORIGIN || request.tabId !== 1 ||
          request.sequence !== this.#sequence + 1 || this.#busy ||
          (this.#epoch !== undefined && request.epoch !== this.#epoch))
        throw new PlaywrightDiagnosticError('protocol_rejected');
      this.#epoch ??= request.epoch;
      this.#sequence = request.sequence;
      this.#busy = true;
      const document = this.#document;
      const observe = async (): Promise<BrowserResponse> => {
        const marker = this.options.page.locator('main[data-behalvo-page-state]');
        const count = await marker.count(); this.#assertCurrent(document);
        if (count !== 1) throw new PlaywrightDiagnosticError('page_rejected');
        const state = await marker.getAttribute('data-behalvo-page-state', { timeout: this.#timeout });
        this.#assertCurrent(document);
        if (state !== 'login') throw new PlaywrightDiagnosticError('page_rejected');
        const { protocolVersion, requestId, profileId, connectionGeneration, epoch,
          serviceGeneration, origin, tabId, sequence } = request;
        return { protocolVersion, requestId, profileId, connectionGeneration, epoch,
          serviceGeneration, origin, tabId, sequence, kind: 'result', documentId: document,
          pageState: 'login', snapshot: { state: 'login' } };
      };
      return await bounded(observe(), this.#timeout, 'observation_timeout', this.#stopped.signal);
    } catch (error) {
      this.#stop(failureCode(error, 'protocol_rejected'));
      throw new PlaywrightDiagnosticError(this.#terminal!);
    } finally { this.#busy = false; }
  }

  async gesture(): Promise<never> { throw new PlaywrightDiagnosticError('read_only'); }

  async revoke(epoch: BrowserEpoch, tabId: number): Promise<void> {
    const valid = this.#matches(epoch) && epoch.allowedOrigin === SYNTHETIC_PORTAL_ORIGIN && tabId === 1 &&
      /^[a-f0-9]{64}$/.test(epoch.epoch) && (this.#epoch === undefined || this.#epoch === epoch.epoch);
    this.#stop('browser_closed');
    if (!valid) throw new PlaywrightDiagnosticError('protocol_rejected');
  }

  async reconcileRevocation(): Promise<never> { throw new PlaywrightDiagnosticError('read_only'); }

  close(): Promise<void> {
    this.#stop('browser_closed');
    this.#closePromise ??= Promise.resolve().then(async () => {
      const page = this.options.page;
      this.options.signal.removeEventListener('abort', this.#onAbort);
      page.off('close', this.#onClose); page.off('framenavigated', this.#onNavigation);
      page.context().off('close', this.#onClose);
      page.context().browser()?.off('disconnected', this.#onClose);
      await this.options.close();
    });
    return this.#closePromise;
  }

  #matches(value: PlaywrightBinding): boolean {
    return value.profileId === this.options.profileId && value.connectionGeneration === this.options.connectionGeneration &&
      value.serviceGeneration === this.options.serviceGeneration;
  }
  #stop(code: PlaywrightFailureCode): void { this.#terminal ??= code; this.#stopped.abort(); }
  #assertCurrent(document = this.#document): void {
    if (this.#terminal) throw new PlaywrightDiagnosticError(this.#terminal);
    if (this.options.signal.aborted) throw new PlaywrightDiagnosticError('cancelled');
    if (this.options.page.isClosed() || !this.options.page.context().browser()?.isConnected())
      throw new PlaywrightDiagnosticError('browser_closed');
    if (document !== this.#document || this.options.page.url() !== `${SYNTHETIC_PORTAL_ORIGIN}/`)
      throw new PlaywrightDiagnosticError('page_rejected');
  }
}
