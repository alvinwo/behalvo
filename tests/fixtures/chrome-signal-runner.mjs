import { writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { runBrowserCli } from '../../dist/cli/browser-main.js';
import { runChromeBridgeDiagnostic, launchDedicatedChrome, acquireSyntheticProfileLease,
  SYNTHETIC_PORTAL_ORIGIN } from '../../dist/index.js';

const [root, phase, chromePath] = process.argv.slice(2);
const profilePath = join(root, 'profile');
const key = new Uint8Array(32).fill(42);
const events = [];
const ready = () => writeFileSync(join(root, 'coordinator-ready'), 'ready');
const dependencies = {
  doctor: () => ({ configured: true, registered: true, issues: [], installation: {
    root, installationId: 'signal-review', extensionId: 'a'.repeat(32), profilePath, chromePath
  } }),
  acquireProfileLease: acquireSyntheticProfileLease,
  assets: { html: '', javascript: '', css: '' },
  startPortal: async () => ({ origin: SYNTHETIC_PORTAL_ORIGIN,
    close: async () => { events.push('portal.close'); } }),
  startService: async () => ({ origin: 'http://127.0.0.1:12345', serviceGeneration: 'signal-service',
    bootstrapPath: join(root, 'bootstrap.json'), shutdown: async () => { events.push('service.shutdown'); return true; } }),
  launchChrome: input => {
    const chrome = launchDedicatedChrome(input);
    writeFileSync(join(root, 'chrome-pid'), String(chrome.child.pid));
    return chrome;
  },
  startRendezvous: async () => ({ enrollmentPath: join(root, 'enrollment.json'),
    waitForEnrollment: async () => {
      if (phase === 'failure') {
        while (!existsSync(join(root, 'chrome-ready'))) await delay(10);
        ready();
        throw new Error('synthetic enrollment failure');
      }
      if (phase === 'enrollment') { ready(); return await new Promise(() => {}); }
      return { tabId: 7, transport: {
        completion: new Promise(() => {}),
        inspect: async request => {
          const { expectedPageState, ...binding } = request;
          ready();
          return { ...binding, kind: 'result', documentId: 'synthetic-document',
            pageState: 'login', snapshot: { state: 'login' } };
        },
        close: async () => { events.push('transport.close'); }
      } };
    }, close: async () => { events.push('rendezvous.close'); }
  })
};
const code = await runBrowserCli(['run', '--root', root, '--storage-key-file', join(root, 'key')], {
  loadStorageKey: () => key,
  diagnostic: (input, options) => runChromeBridgeDiagnostic(input, { ...dependencies, ...options })
});
writeFileSync(join(root, 'result.json'), JSON.stringify({ code, events,
  keyCleared: key.every(byte => byte === 0) }));
// Match the executable boundary: a bounded cancellation must not be held by an
// owned Chrome process that refused termination. The parent test kills that fixture.
if (phase === 'failure') process.exitCode = code;
else process.exit(code);
