import { writeSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { runPlaywrightDiagnostic, type PlaywrightDiagnosticResult } from '../browser/playwright-diagnostic.js';
import { playwrightMessage as message } from './playwright-messages.js';

export interface PlaywrightCliDependencies {
  signal?: AbortSignal;
  writeStdout?: (text: string) => void;
  writeStderr?: (text: string) => void;
  diagnostic?: typeof runPlaywrightDiagnostic;
}
export async function runPlaywrightCli(argv: readonly string[], dependencies: PlaywrightCliDependencies = {}): Promise<number> {
  const out = dependencies.writeStdout ?? (text => writeSync(1, text));
  const err = dependencies.writeStderr ?? (text => writeSync(2, text));
  if (argv.length !== 1 || argv[0] !== 'diagnostic') { err(message('usage')); return 2; }
  let result: PlaywrightDiagnosticResult;
  try { result = await (dependencies.diagnostic ?? runPlaywrightDiagnostic)({ signal: dependencies.signal ?? new AbortController().signal }); }
  catch { err(message('failure')); return 1; }
  if (result?.ok && result.cleanup === 'confirmed' && result.snapshot?.state === 'login' &&
      result.playwrightVersion === '1.63.0' && /^\d+(?:\.\d+){1,4}$/.test(result.browserVersion)) {
    out(message('success')); out(message('versions', { playwright: result.playwrightVersion, browser: result.browserVersion })); return 0;
  }
  if (!result || result.ok) { err(message('failure')); return 1; }
  const key = result.code === 'browser_missing' || result.code === 'unsafe_environment' ||
    result.code === 'cancelled' || result.code === 'cleanup_pending' ? result.code : 'failure';
  err(message(key));
  // Only our generated receipt location is allowed in public output.
  if (result.receiptPath && /^\/(?:[^\r\n\x00]+\/)?behalvo-playwright-[A-Za-z0-9]+\/receipt\.json$/.test(result.receiptPath))
    err(message('receipt', { path: result.receiptPath }));
  return result.cleanup === 'pending' ? 3 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.on('SIGINT', stop); process.on('SIGTERM', stop); process.on('SIGHUP', stop);
  void runPlaywrightCli(process.argv.slice(2), { signal: controller.signal }).then(code => {
    process.off('SIGINT', stop); process.off('SIGTERM', stop); process.off('SIGHUP', stop);
    // A timed-out upstream handle may keep the event loop alive. A pending receipt
    // explicitly records that this bounded exit does not prove browser cleanup.
    process.exit(code);
  }, () => { writeSync(2, message('failure')); process.exit(1); });
}
