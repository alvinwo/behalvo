import { createServer } from 'node:https';
import { connect } from 'node:net';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PublicNetworkGate } from '../../dist/browser/public-network.js';

// Trusted construction seam. Production never accepts certificate/DNS/dial overrides.
export async function managedSite(handler, assertActive = () => {}) {
  const directory = mkdtempSync(join(tmpdir(), 'managed-site-'));
  execFileSync('/usr/bin/openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(directory, 'key'),
    '-out', join(directory, 'cert'), '-subj', '/CN=example.test', '-days', '1'], { stdio: 'ignore' });
  const requests = [];
  const server = createServer({ key: readFileSync(join(directory, 'key')), cert: readFileSync(join(directory, 'cert')) }, (req, res) => {
    requests.push({ method: req.method, url: req.url, host: req.headers.host }); handler(req, res);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const gate = new PublicNetworkGate(['https://example.test'], assertActive, {
    resolve: async () => ['8.8.8.8'], dial: () => connect({ host: '127.0.0.1', port }),
  });
  await gate.start();
  return { gate, requests, async close() { await gate.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); rmSync(directory, { recursive: true, force: true }); } };
}
