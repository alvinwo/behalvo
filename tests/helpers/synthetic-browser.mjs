import {
  BrowserEpochRegistry, BrowserSession
} from '../../dist/index.js';
import { createCompiledSyntheticBrowserHarness } from '../../dist/synthetic-portal/compiled-browser.js';

export async function createSyntheticBrowserTransportHarness(server, options = {}) {
  const harness = await createCompiledSyntheticBrowserHarness(server, {
    ...options, transportTimeoutMs: options.transportTimeoutMs ?? 500
  });
  return { transport: harness.transport, tabId: harness.tabId, commands: harness.commands,
    contentRequests: harness.contentRequests, navigationErrors: harness.navigationErrors,
    finish: () => harness.finish(),
    async close() { await harness.transport.close(); await harness.finish(); } };
}

export async function createSyntheticBrowserHarness(server, options = {}) {
  const harness = await createSyntheticBrowserTransportHarness(server, options);
  const browser = new BrowserSession({ profileId: 'profile-visa', connectionGeneration: 1,
    serviceGeneration: 'service-visa', allowedOrigin: server.origin, tabId: 7,
    identityDigest: options.identityDigest, subjectDigest: options.subjectDigest, termsVersion: 'terms-1',
    registry: new BrowserEpochRegistry(), transport: harness.transport,
    persistence: { async pauseForHuman() {}, async releaseWorker() {}, async recoverHandoff() {},
      async resumePreflight() { throw new Error('resume is outside the observation harness'); } }
  });
  return { browser, commands: harness.commands, contentRequests: harness.contentRequests,
    navigationErrors: harness.navigationErrors,
    async close() {
      let shutdownError;
      try { await browser.shutdown(); } catch (error) { shutdownError = error; }
      finally { await harness.finish(); }
      if (shutdownError && !/unavailable|closed/i.test(String(shutdownError))) throw shutdownError;
    } };
}
