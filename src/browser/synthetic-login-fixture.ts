import { createServer } from 'node:http';
import { SYNTHETIC_LOGIN_ORIGIN, syntheticLoginAuthority } from '../vault/types.js';
import { vaultMessage } from '../vault/messages.js';

export interface SyntheticLoginFixtureAuthority {
  readonly origin: typeof SYNTHETIC_LOGIN_ORIGIN;
  readonly secretAuthority: typeof syntheticLoginAuthority;
  assertCurrent(): void;
}
const owned = new WeakSet<object>();
export function assertOwnedLoginFixture(authority: SyntheticLoginFixtureAuthority): void {
  if (!owned.has(authority)) throw new Error('Synthetic login unavailable');
  authority.assertCurrent();
}
const FORM = `<!doctype html><html><body><form id="behalvo-login" method="post" action="/login" autocomplete="off"><label>${vaultMessage('fixtureUsername')}<input name="username" type="text" autocomplete="off"></label><label>${vaultMessage('fixturePassword')}<input name="password" type="password" autocomplete="off"></label><button type="submit">${vaultMessage('fixtureSubmit')}</button></form></body></html>`;

/** Owned fixture only. Parameters are synthetic test data, never an actual account. */
export async function startSyntheticLoginFixture(credentials = { username: 'behalvo-demo', password: 'synthetic-only-password' }) {
  const username = credentials.username, password = credentials.password;
  if (typeof username !== 'string' || typeof password !== 'string' || !username || !password ||
      Buffer.byteLength(username) > 1024 || Buffer.byteLength(password) > 16384) throw new Error('Invalid synthetic login fixture');
  const counters = { requests: 0, attempts: 0, forbidden: 0 };
  let active = false;
  const server = createServer(async (req, res) => {
    counters.requests++;
    res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', "default-src 'none'; form-action 'self'; frame-src 'none'");
    if (req.method === 'GET' && req.url === '/') { res.end(FORM); return; }
    if (req.method !== 'POST' || req.url !== '/login' || req.headers['content-type'] !== 'application/x-www-form-urlencoded') {
      counters.forbidden++; res.writeHead(400); res.end(); return;
    }
    let bytes = 0; const chunks: Buffer[] = [];
    try {
      for await (const chunk of req) {
        bytes += chunk.length; if (bytes > 65536) throw new Error(); chunks.push(Buffer.from(chunk));
      }
      const body = Buffer.concat(chunks);
      try {
        const form = new URLSearchParams(body.toString('utf8'));
        if ([...form.keys()].join(',') !== 'username,password') throw new Error();
        counters.attempts++;
        const status = form.get('username') === username && form.get('password') === password ? 'signed_in' : 'rejected';
        res.end(`<!doctype html><html><body><main data-behalvo-login="${status}"></main></body></html>`);
      } finally { body.fill(0); }
    } catch { counters.forbidden++; if (!res.headersSent) res.writeHead(400); res.end(); }
    finally { for (const chunk of chunks) chunk.fill(0); }
  });
  server.on('close', () => { active = false; });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(43118, '127.0.0.1', resolve); });
  active = true;
  const authority: SyntheticLoginFixtureAuthority = Object.freeze({ origin: SYNTHETIC_LOGIN_ORIGIN,
    secretAuthority: syntheticLoginAuthority, assertCurrent() { if (!active || !server.listening) throw new Error('Synthetic login unavailable'); } });
  owned.add(authority);
  return { authority, counters, close: () => {
    active = false;
    return new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  } };
}
