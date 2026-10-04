import { PlaywrightProcessOwner, type PlaywrightOwnerDependencies } from './playwright-process-owner.js';
import { PlaywrightActionsTransport } from './playwright-actions-transport.js';
import type { PlaywrightBinding } from './playwright-transport.js';
import { PlaywrightDiagnosticError, type PlaywrightFailureCode } from './playwright-errors.js';

export class PlaywrightActionsOwner {
  readonly #process: PlaywrightProcessOwner;
  constructor(private readonly input: PlaywrightBinding & { signal: AbortSignal; runDeadline: number },
    dependencies: PlaywrightOwnerDependencies = {}) {
    this.#process = new PlaywrightProcessOwner(input, dependencies);
  }
  get receiptPath(): string { return this.#process.receiptPath; }
  async start(): Promise<{ transport: PlaywrightActionsTransport; tabId: 1; browserVersion: string }> {
    const ready = await this.#process.start(async (browser, signal, deadline) => {
      const context = await browser.newContext({ javaScriptEnabled: false, serviceWorkers: 'block', acceptDownloads: false });
      const page = await context.newPage();
      const transport = new PlaywrightActionsTransport({ ...this.input, page, signal,
        close: async () => { if (!(await this.close()).confirmed) throw new PlaywrightDiagnosticError('cleanup_pending'); } });
      await transport.initialize(deadline); return transport;
    });
    return { transport: ready.value, tabId: 1, browserVersion: ready.browserVersion };
  }
  close() { return this.#process.close(); }
  finishReceipt(confirmed: boolean, code: PlaywrightFailureCode | null, success: boolean): void {
    this.#process.finishReceipt(confirmed, code, success);
  }
}
