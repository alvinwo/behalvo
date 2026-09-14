import { createHash, timingSafeEqual } from 'node:crypto';
import { lstat, unlink, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { join } from 'node:path';
import type { Duplex } from 'node:stream';
import { TextDecoder } from 'node:util';
import { publishPrivateFile } from '../storage/private-files.js';
import type { OwnerControlApp } from './local-app.js';
import { OwnerControlError, type ControlErrorCode } from './types.js';

const MAXIMUM_HEADER_BYTES = 16 * 1024;
const MAXIMUM_TARGET_BYTES = 2048;
const MAXIMUM_BODY_BYTES = 4096;
const MAXIMUM_LIST_BYTES = 256 * 1024;
const MAXIMUM_REVIEW_BYTES = 512 * 1024;
const MAXIMUM_OTHER_JSON_BYTES = 512 * 1024;
const CRITICAL_HEADERS = ['host', 'origin', 'authorization', 'content-length', 'transfer-encoding'] as const;
const SECURITY_HEADERS = {
  'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer'
} as const;
const ERROR_STATUS: Record<ControlErrorCode, number> = {
  invalid_request: 400,
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  rate_limited: 429,
  unavailable: 503
};

export interface ControlAssets {
  html: string;
  javascript: string;
  css: string;
}

export interface OwnerControlServer {
  readonly origin: string;
  readonly bootstrapPath: string;
  close(): Promise<void>;
}

interface FileIdentity {
  readonly device: number;
  readonly inode: number;
}

type Route =
  | { readonly kind: 'asset'; readonly asset: keyof ControlAssets; readonly contentType: string }
  | { readonly kind: 'bootstrap' | 'logout' | 'list' }
  | { readonly kind: 'review' | 'approve' | 'cancel'; readonly actionId: string };

class TransportError extends Error {
  readonly status: number;
  constructor(status: number) {
    super('Invalid transport request.');
    this.status = status;
  }
}

function encodedJson(value: unknown, maximumBytes: number): Buffer {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  if (body.byteLength > maximumBytes) throw new Error('Control response exceeds its bound.');
  return body;
}

function sendBuffer(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': contentType,
    'Content-Length': String(body.byteLength) });
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, value: unknown,
  maximumBytes = MAXIMUM_OTHER_JSON_BYTES): void {
  sendBuffer(res, status, 'application/json; charset=utf-8', encodedJson(value, maximumBytes));
}

function sendEmpty(res: ServerResponse, status: number): void {
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Length': '0' });
  res.end();
}

function sendError(res: ServerResponse, error: unknown): void {
  if (res.headersSent || res.destroyed) return;
  if (error instanceof TransportError) {
    sendJson(res, error.status, { error: 'invalid_request' });
    return;
  }
  if (error instanceof OwnerControlError) {
    sendJson(res, ERROR_STATUS[error.code], { error: error.code });
    return;
  }
  sendJson(res, 500, { error: 'internal_error' });
}

function rawInvalidRequest(socket: Duplex): void {
  if (socket.destroyed || !socket.writable) return;
  const body = Buffer.from('{"error":"invalid_request"}', 'utf8');
  const headers = [
    'HTTP/1.1 400 Bad Request',
    ...Object.entries(SECURITY_HEADERS).map(([name, value]) => `${name}: ${value}`),
    'Content-Type: application/json; charset=utf-8',
    `Content-Length: ${body.byteLength}`,
    'Connection: close', '', ''
  ].join('\r\n');
  socket.end(Buffer.concat([Buffer.from(headers, 'ascii'), body]));
}

function bearer(req: IncomingMessage): string {
  const value = req.headers.authorization;
  const match = typeof value === 'string' ? /^Bearer ([A-Za-z0-9_-]{43})$/.exec(value) : null;
  if (!match) throw new OwnerControlError('unauthenticated');
  return match[1]!;
}

function rawHeaderCount(req: IncomingMessage, expected: string): number {
  let count = 0;
  for (let index = 0; index < req.rawHeaders.length; index += 2) {
    if (req.rawHeaders[index]?.toLowerCase() === expected) count++;
  }
  return count;
}

function admitTransport(req: IncomingMessage, origin: string): URL {
  if (req.socket.remoteAddress !== '127.0.0.1') throw new OwnerControlError('forbidden');
  if (rawHeaderCount(req, 'host') !== 1 || CRITICAL_HEADERS.slice(1).some(name => rawHeaderCount(req, name) > 1))
    throw new TransportError(400);
  for (let index = 0; index < req.rawHeaders.length; index += 2) {
    const name = req.rawHeaders[index]?.toLowerCase() ?? '';
    if (name === 'forwarded' || name.startsWith('x-forwarded-')) throw new TransportError(400);
  }
  const target = req.url ?? '';
  if (Buffer.byteLength(target, 'utf8') > MAXIMUM_TARGET_BYTES || !target.startsWith('/') ||
    target.startsWith('//') || target.includes('#')) throw new TransportError(400);
  if (req.headers.host !== new URL(origin).host) throw new TransportError(400);
  let url: URL;
  try {
    url = new URL(`${origin}${target}`);
    decodeURIComponent(url.pathname);
  } catch {
    throw new TransportError(400);
  }
  if (req.method === 'POST') {
    if (req.headers.origin === undefined) throw new TransportError(400);
    if (req.headers.origin !== origin) throw new OwnerControlError('forbidden');
  } else if (req.method === 'GET' && req.headers.origin !== undefined && req.headers.origin !== origin) {
    throw new OwnerControlError('forbidden');
  }
  return url;
}

function selectRoute(url: URL): Route {
  if (url.pathname === '/') return { kind: 'asset', asset: 'html', contentType: 'text/html; charset=utf-8' };
  if (url.pathname === '/app.js')
    return { kind: 'asset', asset: 'javascript', contentType: 'text/javascript; charset=utf-8' };
  if (url.pathname === '/styles.css')
    return { kind: 'asset', asset: 'css', contentType: 'text/css; charset=utf-8' };
  if (url.pathname === '/api/session/bootstrap') return { kind: 'bootstrap' };
  if (url.pathname === '/api/session/logout') return { kind: 'logout' };
  if (url.pathname === '/api/actions') return { kind: 'list' };
  const match = /^\/api\/actions\/([^/]+)\/(review|approve|cancel)$/.exec(url.pathname);
  if (match) {
    let actionId: string;
    try { actionId = decodeURIComponent(match[1]!); }
    catch { throw new TransportError(400); }
    return { kind: match[2] as 'review' | 'approve' | 'cancel', actionId };
  }
  throw new OwnerControlError('not_found');
}

function admitRoute(req: IncomingMessage, url: URL, route: Route): void {
  const expectedMethod = route.kind === 'asset' || route.kind === 'list' ? 'GET' : 'POST';
  if (req.method !== expectedMethod) throw new TransportError(405);
  if (route.kind === 'list') {
    const after = url.searchParams.getAll('after');
    if ([...url.searchParams.keys()].some(name => name !== 'after') || after.length > 1)
      throw new TransportError(400);
  } else if (url.search !== '') {
    throw new TransportError(400);
  }
  if (req.method === 'GET' && (req.headers['content-length'] !== undefined || req.headers['transfer-encoding'] !== undefined))
    throw new TransportError(400);
  const fetchSite = req.headers['sec-fetch-site'];
  if (fetchSite !== undefined) {
    const permitted = fetchSite === 'same-origin' ||
      (route.kind === 'asset' && route.asset === 'html' && fetchSite === 'none');
    if (!permitted) throw new OwnerControlError('forbidden');
  }
}

async function requestObject(req: IncomingMessage): Promise<Record<string, unknown>> {
  const contentType = req.headers['content-type'];
  if (typeof contentType !== 'string' || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(contentType) ||
    req.headers['content-encoding'] !== undefined) throw new TransportError(400);
  const declared = req.headers['content-length'];
  if (declared !== undefined && (!/^[0-9]+$/.test(declared) || Number(declared) > MAXIMUM_BODY_BYTES))
    throw new TransportError(413);
  if (req.headers['transfer-encoding'] !== undefined && req.headers['transfer-encoding'] !== 'chunked')
    throw new TransportError(400);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const value of req) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    size += chunk.byteLength;
    if (size > MAXIMUM_BODY_BYTES) throw new TransportError(413);
    chunks.push(chunk);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  } catch {
    throw new TransportError(400);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed) ||
    Object.getPrototypeOf(parsed) !== Object.prototype) throw new TransportError(400);
  return parsed as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index]))
    throw new TransportError(400);
}

function tokenDigest(value: string): Buffer {
  return createHash('sha256').update(value, 'ascii').digest();
}

function sameDigest(value: string, expected: Buffer): boolean {
  const actual = tokenDigest(value);
  return actual.byteLength === expected.byteLength && timingSafeEqual(actual, expected);
}

async function closeListener(server: ReturnType<typeof createServer>, sockets: Set<Socket>): Promise<void> {
  await new Promise<void>(resolve => {
    server.close(() => resolve());
    server.closeAllConnections();
    for (const socket of sockets) socket.destroy();
  });
}

export async function startOwnerControlServer(options: {
  app: OwnerControlApp;
  bootstrapDirectory: string;
  assets: ControlAssets;
  port?: number;
}): Promise<OwnerControlServer> {
  let origin = '';
  let closing = false;
  let bootstrapPath = '';
  let bootstrapDigest = Buffer.alloc(32);
  let bootstrapIdentity: FileIdentity | undefined;
  let cleanupBootstrap = async (): Promise<void> => {};
  const sockets = new Set<Socket>();
  const server = createServer({ maxHeaderSize: MAXIMUM_HEADER_BYTES, headersTimeout: 5_000, requireHostHeader: false,
    requestTimeout: 10_000, connectionsCheckingInterval: 500 }, (req, res) => {
    void (async () => {
      if (closing) throw new OwnerControlError('unavailable');
      const url = admitTransport(req, origin);
      const route = selectRoute(url);
      admitRoute(req, url, route);

      if (route.kind === 'asset') {
        sendBuffer(res, 200, route.contentType, Buffer.from(options.assets[route.asset], 'utf8'));
        return;
      }
      if (route.kind === 'list') {
        const principal = options.app.sessions.authenticate(bearer(req));
        const after = url.searchParams.getAll('after')[0];
        sendJson(res, 200, options.app.service.list(principal, after), MAXIMUM_LIST_BYTES);
        return;
      }

      const body = await requestObject(req);
      if (route.kind === 'bootstrap') {
        exactKeys(body, []);
        const credential = bearer(req);
        try {
          const result = options.app.sessions.exchangeBootstrap(credential, origin);
          await cleanupBootstrap();
          sendJson(res, 200, result);
        } catch (error) {
          if (sameDigest(credential, bootstrapDigest)) await cleanupBootstrap();
          throw error;
        }
        return;
      }

      const principal = options.app.sessions.authenticate(bearer(req));
      if (route.kind === 'logout') {
        exactKeys(body, []);
        options.app.service.logout(principal);
        sendEmpty(res, 204);
        return;
      }
      if (route.kind === 'review') {
        exactKeys(body, []);
        sendJson(res, 200, options.app.service.review(principal, route.actionId), MAXIMUM_REVIEW_BYTES);
        return;
      }
      exactKeys(body, ['reviewToken', 'digest']);
      const input = { reviewToken: body.reviewToken, digest: body.digest } as { reviewToken: string; digest: string };
      if (route.kind !== 'approve' && route.kind !== 'cancel') throw new TransportError(400);
      const result = route.kind === 'approve' ? options.app.service.approve(principal, route.actionId, input)
        : options.app.service.cancel(principal, route.actionId, input);
      sendJson(res, 200, result);
    })().catch(error => {
      req.resume();
      sendError(res, error);
    });
  });
  server.maxConnections = 16;
  server.on('connection', socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  server.on('clientError', (_error, socket) => rawInvalidRequest(socket));
  server.on('checkContinue', (_req, res) => sendError(res, new TransportError(400)));
  server.on('checkExpectation', (_req, res) => sendError(res, new TransportError(400)));
  server.on('upgrade', (_req, socket) => rawInvalidRequest(socket));
  server.on('connect', (_req, socket) => rawInvalidRequest(socket));

  let expiryTimer: NodeJS.Timeout | undefined;
  try {
    if (!options || typeof options !== 'object' || typeof options.bootstrapDirectory !== 'string' ||
      !options.assets || typeof options.assets.html !== 'string' || typeof options.assets.javascript !== 'string' ||
      typeof options.assets.css !== 'string' || (options.port !== undefined &&
        (!Number.isInteger(options.port) || options.port < 0 || options.port > 65_535))) throw new Error();
    await new Promise<void>((resolve, reject) => {
      const failed = (error: Error): void => { server.off('listening', ready); reject(error); };
      const ready = (): void => { server.off('error', failed); resolve(); };
      server.once('error', failed);
      server.once('listening', ready);
      server.listen(options.port ?? 0, '127.0.0.1');
    });
    const address = server.address() as AddressInfo;
    origin = new URL(`http://127.0.0.1:${address.port}`).origin;
    const bootstrap = options.app.sessions.issueBootstrap(origin);
    bootstrapDigest = tokenDigest(bootstrap.token);
    bootstrapPath = join(options.bootstrapDirectory, `${options.app.sessions.instanceId}.behalvo-bootstrap`);
    cleanupBootstrap = async (): Promise<void> => {
      const identity = bootstrapIdentity;
      if (!identity) return;
      try {
        const current = await lstat(bootstrapPath);
        if (current.dev === identity.device && current.ino === identity.inode && current.isFile())
          await unlink(bootstrapPath);
      } catch {
        // The one-use authority remains consumed even when cleanup cannot remove the owned inode.
      }
    };
    await publishPrivateFile(bootstrapPath, async stagedPath => {
      await writeFile(stagedPath, `${JSON.stringify(bootstrap)}\n`, 'utf8');
      const staged = await lstat(stagedPath);
      bootstrapIdentity = { device: staged.dev, inode: staged.ino };
    });
    bootstrap.token = '';
    const delay = Math.max(0, Date.parse(bootstrap.expiresAt) - Date.now());
    expiryTimer = setTimeout(() => { void cleanupBootstrap(); }, Math.min(delay, 2_147_483_647));
    expiryTimer.unref();
  } catch {
    if (expiryTimer) clearTimeout(expiryTimer);
    closing = true;
    const listenerClosed = closeListener(server, sockets);
    try { options?.app?.service.close(); } catch { /* preserve the fixed startup failure */ }
    await cleanupBootstrap();
    await listenerClosed;
    bootstrapDigest.fill(0);
    throw new Error('Owner control server startup failed.');
  }

  let closePromise: Promise<void> | undefined;
  return {
    origin,
    bootstrapPath,
    close(): Promise<void> {
      closePromise ??= (async () => {
        closing = true;
        const listenerClosed = closeListener(server, sockets);
        try { options.app.service.close(); } catch { /* shutdown remains bounded and non-logging */ }
        if (expiryTimer) clearTimeout(expiryTimer);
        await cleanupBootstrap();
        await listenerClosed;
        bootstrapDigest.fill(0);
      })();
      return closePromise;
    }
  };
}
