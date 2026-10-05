import { createRequire } from 'node:module';
import { channel } from 'node:diagnostics_channel';
import { US_VISA_CHINA_ADAPTER_ID, US_VISA_CHINA_ADAPTER_VERSION } from '../../dist/adapters/us-visa-china/types.js';
import { DISCOVERY_CASES, mapDiscoverySnapshot, missingDiscoveryCase, buildDiscoveryReport } from './browser-discovery-report.mjs';
const fail = () => { throw new Error('Synthetic discovery collection failed.'); };
export function installedDiscoveryVersions() {
  const require = createRequire(import.meta.url);
  const playwright = require('playwright/package.json').version;
  if (playwright !== '1.63.0' || US_VISA_CHINA_ADAPTER_ID !== 'us-visa-china' || US_VISA_CHINA_ADAPTER_VERSION !== 1) fail();
  return { adapterId: US_VISA_CHINA_ADAPTER_ID, adapterVersion: US_VISA_CHINA_ADAPTER_VERSION,
    playwright, node: process.versions.node, browser: null };
}
/** Server ingress, including rejected POSTs. Null until a request proves the channel works. */
export function observePortalRequests(port = 43117) {
  let requests = 0, posts = 0;
  const ingress = channel('http.server.request.start');
  const listener = ({ server, request }) => {
    if (server?.address()?.port === port) { requests++; if (request.method === 'POST') posts++; }
  };
  ingress.subscribe(listener);
  return { postCount: () => requests ? posts : null, close: () => ingress.unsubscribe(listener) };
}
export function createDiscoveryCollector(metadata) {
  const rows = new Map(); let browser = null;
  const get = id => { if (!rows.has(id)) fail(); return rows.get(id); };
  const reject = (id, code = 'observation_failed') => {
    const row = get(id);
    row.outcome = 'rejected'; row.code = code;
    row.checks = missingDiscoveryCase(id, 'rejected', code).checks;
  };
  return {
    begin(id) {
      if (rows.has(id)) fail();
      const row = missingDiscoveryCase(id, 'rejected', 'observation_failed');
      row.cleanup = 'pending'; row.gestureCount = null; row.postCount = null; rows.set(id, row);
    },
    observe(id, snapshot, browserVersion) {
      try {
        const row = get(id);
        const checks = mapDiscoverySnapshot(id, snapshot);
        if (typeof browserVersion !== 'string' || !/^\d{1,4}(?:\.\d{1,6}){1,3}$/.test(browserVersion) ||
            (browser !== null && browser !== browserVersion)) fail();
        browser = browserVersion; row.outcome = 'observed'; row.code = 'none'; row.checks = checks;
      } catch { reject(id); return fail(); }
    },
    reject,
    finish(id, { cleanup, gestureCount, postCount }) {
      const row = get(id); Object.assign(row, { cleanup, gestureCount, postCount });
      if (cleanup !== 'confirmed') reject(id, 'cleanup_pending');
      else if (gestureCount > 0 || postCount > 0) reject(id, 'unexpected_request');
      else if (gestureCount === null || postCount === null) reject(id, 'observation_failed');
    },
    skipAll() {
      if (rows.size) fail();
      for (const item of DISCOVERY_CASES) rows.set(item.caseId, missingDiscoveryCase(item.caseId, 'skipped', 'not_enabled'));
    },
    report(provenance = metadata.provenance) {
      const cases = [...rows.values()].map(row => row.cleanup === 'pending' ? {
        ...row, outcome: 'rejected', code: 'cleanup_pending', checks: missingDiscoveryCase(row.caseId, 'rejected').checks
      } : row);
      return buildDiscoveryReport({ ...metadata, provenance, versions: { ...metadata.versions, browser }, cases });
    }
  };
}
