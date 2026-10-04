import { randomBytes, randomUUID } from 'node:crypto';
import { BrowserSession, BrowserEpochRegistry } from './session.js';
import { startSyntheticPortal } from '../synthetic-portal/server.js';
import { SYNTHETIC_PORTAL_ORIGIN } from './types.js';
import { PlaywrightBrowserOwner, type PlaywrightOwnerDependencies } from './playwright-owner.js';
import { bounded, failureCode, PlaywrightDiagnosticError, type PlaywrightFailureCode } from './playwright-errors.js';

export type PlaywrightDiagnosticResult =
  | { ok: true; snapshot: { state: 'login' }; cleanup: 'confirmed'; playwrightVersion: '1.63.0'; browserVersion: string }
  | { ok: false; code: PlaywrightFailureCode; cleanup: 'confirmed' | 'pending'; receiptPath?: string };
export interface PlaywrightDiagnosticDependencies extends PlaywrightOwnerDependencies {
  startPortal?: () => Promise<{ origin: string; close(): Promise<void> }>;
}

export async function runPlaywrightDiagnostic(input: { signal: AbortSignal },
  dependencies: PlaywrightDiagnosticDependencies = {}): Promise<PlaywrightDiagnosticResult> {
  const stop = new AbortController();
  const onAbort = () => stop.abort();
  input.signal.addEventListener('abort', onAbort, { once: true });
  if (input.signal.aborted) stop.abort();
  const binding = { profileId: `p1-${randomUUID()}`, connectionGeneration: 1, serviceGeneration: randomUUID() };
  let owner: PlaywrightBrowserOwner | undefined;
  let session: BrowserSession | undefined;
  let portal: { origin: string; close(): Promise<void> } | undefined;
  let portalPending = false;
  let closing = false;
  let code: PlaywrightFailureCode | undefined;
  let browserVersion = '';
  let observed = false;
  let confirmed = false;
  const setupDeadline = Date.now() + (dependencies.setupTimeoutMs ?? 15_000);
  try {
    owner = new PlaywrightBrowserOwner({ ...binding, signal: stop.signal }, dependencies);
    if (stop.signal.aborted) throw new PlaywrightDiagnosticError('cancelled');
    portalPending = true;
    const startup = (dependencies.startPortal ?? startSyntheticPortal)().then(async value => {
      portalPending = false; portal = value;
      if (closing || stop.signal.aborted) { await value.close(); throw new PlaywrightDiagnosticError('cancelled'); }
      return value;
    }, () => { portalPending = false; throw new PlaywrightDiagnosticError('portal_failed'); });
    portal = await bounded(startup, setupDeadline - Date.now(), 'setup_timeout', stop.signal);
    if (portal.origin !== SYNTHETIC_PORTAL_ORIGIN) throw new PlaywrightDiagnosticError('portal_failed');
    const ready = await bounded(owner.start(), setupDeadline - Date.now(), 'setup_timeout', stop.signal);
    browserVersion = ready.browserVersion;
    session = new BrowserSession({ ...binding, allowedOrigin: SYNTHETIC_PORTAL_ORIGIN, tabId: ready.tabId,
      identityDigest: randomBytes(32).toString('hex'), subjectDigest: randomBytes(32).toString('hex'),
      termsVersion: 'synthetic-p1', transport: ready.transport, registry: new BrowserEpochRegistry(), persistence: {
        // This diagnostic owns no service worker. There is no durable ownership to release.
        releaseWorker: async () => {},
        pauseForHuman: async () => { throw new PlaywrightDiagnosticError('read_only'); },
        recoverHandoff: async () => { throw new PlaywrightDiagnosticError('read_only'); },
        resumePreflight: async () => { throw new PlaywrightDiagnosticError('read_only'); }
      } });
    for (const kind of ['recognize', 'inspect'] as const) {
      const fence = { serviceGeneration: binding.serviceGeneration, signal: stop.signal,
        deadline: Date.now() + 10_000, assertCurrent: async () => {
          if (stop.signal.aborted) throw new PlaywrightDiagnosticError('cancelled');
        } };
      const snapshot = await bounded(kind === 'recognize' ? session.recognize(fence) : session.inspect('login', fence),
        10_000, 'observation_timeout', stop.signal);
      if (snapshot.state !== 'login') throw new PlaywrightDiagnosticError('page_rejected');
    }
    observed = true;
  } catch (error) { code = input.signal.aborted ? 'cancelled' : failureCode(error, 'launch_failed'); }
  finally {
    closing = true; stop.abort();
    try {
      const cleanup = await bounded(Promise.allSettled([
        session?.shutdown() ?? Promise.resolve(), owner?.close() ?? Promise.resolve({ confirmed: true }),
        portal?.close() ?? Promise.resolve()
      ]), dependencies.shutdownTimeoutMs ?? 5_000, 'cleanup_pending');
      confirmed = !portalPending && cleanup.every(item => item.status === 'fulfilled') &&
        cleanup[1]!.status === 'fulfilled' && (cleanup[1]!.value as { confirmed: boolean }).confirmed;
    } catch { confirmed = false; }
    input.signal.removeEventListener('abort', onAbort);
  }
  if (input.signal.aborted) code = 'cancelled';
  if (!confirmed) code = 'cleanup_pending';
  const ok = observed && confirmed && !code;
  try { owner?.finishReceipt(confirmed, code ?? null, ok); }
  catch { confirmed = false; code = 'cleanup_pending'; }
  if (ok && confirmed) return { ok: true, snapshot: { state: 'login' }, cleanup: 'confirmed', playwrightVersion: '1.63.0', browserVersion };
  return { ok: false, code: code ?? 'launch_failed', cleanup: confirmed ? 'confirmed' : 'pending',
    ...(owner ? { receiptPath: owner.receiptPath } : {}) };
}
