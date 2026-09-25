import { createHash } from 'node:crypto';
import { constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync, closeSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { spawn } from 'node:child_process';
import type { Readable } from 'node:stream';
import {
  MAXIMUM_SECRET_BYTES,
  exactSecretObject,
  parseSecretCallOptions,
  parseSecretListQuery,
  parseSecretPut,
  parseSecretReference,
  safeSecretCallbackError,
  safeSecretError,
  secretMetadata,
  type SecretCallOptions,
  type SecretListQuery,
  type SecretMetadata,
  type SecretProvider,
  type SecretPut,
  type SecretReference
} from './types.js';

const MAXIMUM_HELPER_OUTPUT = 64 * 1024;
const HELPER_ARGUMENTS = ['--behalvo-keychain-helper-v1'] as const;

export type KeychainHelperRequest =
  | ({ version: 1; operation: 'put' | 'with_secret' | 'delete' } & SecretReference & { createdAt?: string })
  | ({ version: 1; operation: 'list' } & SecretListQuery);

export interface KeychainHelperResponse {
  version: 1;
  status: 'ok';
  secret?: Uint8Array;
  items?: SecretMetadata[];
}

export interface KeychainHelperTransport {
  identity(): Promise<string>;
  invoke(request: KeychainHelperRequest, secret: Uint8Array | undefined, signal: AbortSignal):
    Promise<KeychainHelperResponse>;
}

export interface NativeHelperLaunch {
  executablePath: string;
  args: readonly string[];
  env: Readonly<Record<string, string>>;
  stdin: Buffer;
  signal: AbortSignal;
}

export interface NativeHelperLaunchResult { exitCode: number; stdout: Buffer; secretOutput: Buffer }

export interface NativeKeychainHelperTransportOptions {
  executablePath: string;
  platform?: NodeJS.Platform;
  identityReader?: (path: string) => Promise<string>;
  launcher?: (input: NativeHelperLaunch) => Promise<NativeHelperLaunchResult>;
}

export class NativeKeychainHelperTransport implements KeychainHelperTransport {
  readonly #path: string;
  readonly #platform: NodeJS.Platform;
  readonly #identityReader: (path: string) => Promise<string>;
  readonly #launcher: (input: NativeHelperLaunch) => Promise<NativeHelperLaunchResult>;

  constructor(options: NativeKeychainHelperTransportOptions) {
    if (!options || typeof options.executablePath !== 'string' || !isAbsolute(options.executablePath))
      throw safeSecretError();
    this.#path = options.executablePath;
    this.#platform = options.platform ?? process.platform;
    this.#identityReader = options.identityReader ?? helperIdentity;
    this.#launcher = options.launcher ?? launchNativeHelper;
  }

  async identity(): Promise<string> {
    if (this.#platform !== 'darwin') throw safeSecretError();
    try { return await this.#identityReader(this.#path); } catch { throw safeSecretError(); }
  }

  async invoke(request: KeychainHelperRequest, secret: Uint8Array | undefined,
    signal: AbortSignal): Promise<KeychainHelperResponse> {
    if (this.#platform !== 'darwin' || signal.aborted) throw safeSecretError();
    let stdin: Buffer | undefined;
    let result: NativeHelperLaunchResult | undefined;
    try {
      stdin = encodeHelperInput(request, secret);
      result = await this.#launcher({ executablePath: this.#path, args: HELPER_ARGUMENTS,
        env: Object.freeze({ PATH: '/usr/bin:/bin', LANG: 'C' }), stdin, signal });
      if (result.exitCode !== 0 || result.stdout.byteLength > MAXIMUM_HELPER_OUTPUT ||
          result.secretOutput.byteLength > MAXIMUM_SECRET_BYTES ||
          (request.operation !== 'with_secret' && result.secretOutput.byteLength !== 0)) throw safeSecretError();
      const parsed: unknown = JSON.parse(result.stdout.toString('utf8'));
      const item = request.operation === 'list'
        ? exactSecretObject(parsed, ['version', 'status', 'items'])
        : exactSecretObject(parsed, ['version', 'status']);
      if (item.version !== 1 || item.status !== 'ok') throw safeSecretError();
      return { version: 1, status: 'ok',
        ...(request.operation === 'with_secret' ? { secret: Buffer.from(result.secretOutput) } : {}),
        ...(request.operation === 'list' ? { items: item.items as SecretMetadata[] } : {}) };
    } catch { throw safeSecretError(); }
    finally { stdin?.fill(0); result?.stdout.fill(0); result?.secretOutput.fill(0); }
  }
}

export class KeychainSecretProvider implements SecretProvider {
  readonly #transport: KeychainHelperTransport;
  readonly #expectedIdentity: string;
  readonly #timeoutMs: number;
  readonly #clock: () => number;

  constructor(options: { transport: KeychainHelperTransport; expectedHelperIdentity: string;
    timeoutMs?: number; clock?: () => number }) {
    if (!options || !options.transport || typeof options.transport.identity !== 'function' ||
        typeof options.transport.invoke !== 'function' || typeof options.expectedHelperIdentity !== 'string' ||
        options.expectedHelperIdentity.length < 1 || options.expectedHelperIdentity.length > 512 ||
        (options.timeoutMs !== undefined && (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 ||
          options.timeoutMs > 60_000))) throw safeSecretError();
    this.#transport = options.transport; this.#expectedIdentity = options.expectedHelperIdentity;
    this.#timeoutMs = options.timeoutMs ?? 10_000; this.#clock = options.clock ?? Date.now;
  }

  async put(input: SecretPut, options?: SecretCallOptions): Promise<SecretMetadata> {
    try {
      const checked = parseSecretPut(input);
      const metadata = secretMetadata(checked, 'keychain', new Date(this.#clock()).toISOString());
      await this.#invoke({ version: 1, operation: 'put', service: metadata.service,
        connectionId: metadata.connectionId, purpose: metadata.purpose, accountId: metadata.accountId,
        reference: metadata.reference, createdAt: metadata.createdAt }, checked.value, options);
      return metadata;
    } catch { throw safeSecretError(); }
  }

  async withSecret<T>(input: SecretReference, use: (secret: Uint8Array) => Promise<T> | T,
    options?: SecretCallOptions): Promise<T> {
    let borrowed: Buffer | undefined;
    let received: Uint8Array | undefined;
    try {
      const checked = parseSecretReference(input);
      if (typeof use !== 'function') throw safeSecretError();
      const response = await this.#invoke({ version: 1, operation: 'with_secret', ...checked }, undefined, options);
      received = response.secret;
      if (!(received instanceof Uint8Array) || received.byteLength < 1 || received.byteLength > MAXIMUM_SECRET_BYTES)
        throw safeSecretError();
      if (options?.signal?.aborted) throw safeSecretError();
      borrowed = Buffer.from(received); received.fill(0);
      try { return await use(borrowed); } catch { throw safeSecretCallbackError(); }
    } catch (error) {
      if (error instanceof Error && error.message === 'Secret callback failed.') throw error;
      throw safeSecretError();
    } finally { received?.fill(0); borrowed?.fill(0); }
  }

  async delete(input: SecretReference, options?: SecretCallOptions): Promise<void> {
    try {
      const checked = parseSecretReference(input);
      await this.#invoke({ version: 1, operation: 'delete', ...checked }, undefined, options);
    } catch { throw safeSecretError(); }
  }

  async list(input: SecretListQuery, options?: SecretCallOptions): Promise<SecretMetadata[]> {
    try {
      const checked = parseSecretListQuery(input);
      const response = await this.#invoke({ version: 1, operation: 'list', ...checked }, undefined, options);
      if (!Array.isArray(response.items) || response.items.length > 256) throw safeSecretError();
      const items = response.items.map(value => parseMetadata(value));
      const references = new Set<string>();
      for (const item of items) {
        if (item.service !== checked.service || item.connectionId !== checked.connectionId ||
            item.accountId !== checked.accountId ||
            (checked.purpose !== undefined && item.purpose !== checked.purpose) || references.has(item.reference))
          throw safeSecretError();
        references.add(item.reference);
      }
      return items;
    } catch { throw safeSecretError(); }
  }

  async #invoke(request: KeychainHelperRequest, secret: Uint8Array | undefined,
    options: SecretCallOptions | undefined): Promise<KeychainHelperResponse> {
    const checkedOptions = parseSecretCallOptions(options);
    if (checkedOptions.signal?.aborted) throw safeSecretError();
    const controller = new AbortController();
    const abort = () => controller.abort();
    checkedOptions.signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    const stopped = new Promise<never>((_resolve, reject) => {
      controller.signal.addEventListener('abort', () => reject(safeSecretError()), { once: true });
    });
    const bounded = async <T>(operation: Promise<T>): Promise<T> => {
      void operation.catch(() => {});
      return Promise.race([operation, stopped]);
    };
    let response: KeychainHelperResponse | undefined;
    try {
      const initialIdentity = await bounded(this.#transport.identity());
      if (controller.signal.aborted || initialIdentity !== this.#expectedIdentity) throw safeSecretError();
      const invoked = this.#transport.invoke(request, secret, controller.signal).then(response => {
        if (controller.signal.aborted) { zeroResponseSecret(response); throw safeSecretError(); }
        return response;
      });
      const rawResponse = await bounded(invoked);
      response = rawResponse;
      try { response = validateHelperResponse(request, rawResponse); }
      catch { zeroResponseSecret(rawResponse); throw safeSecretError(); }
      const finalIdentity = await bounded(this.#transport.identity());
      if (controller.signal.aborted || finalIdentity !== this.#expectedIdentity) {
        zeroResponseSecret(response);
        throw safeSecretError();
      }
      if (controller.signal.aborted) { zeroResponseSecret(response); throw safeSecretError(); }
      return response;
    } catch { zeroResponseSecret(response); throw safeSecretError(); }
    finally {
      clearTimeout(timer);
      checkedOptions.signal?.removeEventListener('abort', abort);
    }
  }
}

function parseMetadata(value: unknown): SecretMetadata {
  const item = exactSecretObject(value,
    ['service', 'connectionId', 'purpose', 'accountId', 'reference', 'provider', 'createdAt']);
  const reference = parseSecretReference({ service: item.service, connectionId: item.connectionId,
    purpose: item.purpose, accountId: item.accountId, reference: item.reference });
  if (item.provider !== 'keychain' || typeof item.createdAt !== 'string' ||
      new Date(item.createdAt).toISOString() !== item.createdAt) throw safeSecretError();
  return { ...reference, provider: 'keychain', createdAt: item.createdAt };
}

function validateHelperResponse(request: KeychainHelperRequest, response: unknown): KeychainHelperResponse {
  const item = request.operation === 'with_secret'
    ? exactSecretObject(response, ['version', 'status', 'secret'])
    : request.operation === 'list'
      ? exactSecretObject(response, ['version', 'status', 'items'])
      : exactSecretObject(response, ['version', 'status']);
  if (item.version !== 1 || item.status !== 'ok') throw safeSecretError();
  if (request.operation === 'with_secret' && !(item.secret instanceof Uint8Array)) throw safeSecretError();
  if (request.operation === 'list' && !Array.isArray(item.items)) throw safeSecretError();
  return response as KeychainHelperResponse;
}

function zeroResponseSecret(response: unknown): void {
  if (response && typeof response === 'object' && !Array.isArray(response)) {
    const secret = (response as { secret?: unknown }).secret;
    if (secret instanceof Uint8Array) secret.fill(0);
  }
}

function encodeHelperInput(request: KeychainHelperRequest, secret: Uint8Array | undefined): Buffer {
  const metadata = Buffer.from(JSON.stringify(request), 'utf8');
  const value = secret ? Buffer.from(secret) : Buffer.alloc(0);
  const frame = Buffer.allocUnsafe(8 + metadata.byteLength + value.byteLength);
  frame.writeUInt32LE(metadata.byteLength, 0); metadata.copy(frame, 4);
  frame.writeUInt32LE(value.byteLength, 4 + metadata.byteLength); value.copy(frame, 8 + metadata.byteLength);
  metadata.fill(0); value.fill(0); return frame;
}

async function helperIdentity(path: string): Promise<string> {
  let descriptor: number | undefined;
  try {
    const real = realpathSync(path);
    if (real !== path || lstatSync(path).isSymbolicLink()) throw safeSecretError();
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(descriptor, { bigint: true });
    if (!stat.isFile() || stat.nlink !== 1n || (stat.mode & 0o022n) !== 0n ||
        (typeof process.geteuid === 'function' && stat.uid !== 0n && stat.uid !== BigInt(process.geteuid())))
      throw safeSecretError();
    const digest = createHash('sha256').update(readFileSync(descriptor)).digest('hex');
    return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${digest}`;
  } finally { if (descriptor !== undefined) closeSync(descriptor); }
}

async function readBounded(stream: Readable, maximum: number): Promise<Buffer> {
  const chunks: Buffer[] = []; let total = 0;
  try {
    for await (const value of stream) {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array);
      total += chunk.byteLength; if (total > maximum) { chunk.fill(0); throw safeSecretError(); } chunks.push(chunk);
    }
    return Buffer.concat(chunks, total);
  } finally { for (const chunk of chunks) chunk.fill(0); }
}

async function launchNativeHelper(input: NativeHelperLaunch): Promise<NativeHelperLaunchResult> {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(input.executablePath, [...input.args], {
        env: { ...input.env }, stdio: ['pipe', 'pipe', 'ignore', 'pipe'], signal: input.signal
      });
    } catch { reject(safeSecretError()); return; }
    const secretStream = child.stdio[3] as Readable | null;
    if (!child.stdin || !child.stdout || !secretStream) { child.kill(); reject(safeSecretError()); return; }
    let settled = false;
    let stdoutAggregate: Buffer | undefined;
    let secretAggregate: Buffer | undefined;
    const stdout = readBounded(child.stdout, MAXIMUM_HELPER_OUTPUT).then(output => {
      stdoutAggregate = output; if (settled) output.fill(0); return output;
    });
    const secretOutput = readBounded(secretStream, MAXIMUM_SECRET_BYTES).then(secret => {
      secretAggregate = secret; if (settled) secret.fill(0); return secret;
    });
    void stdout.catch(() => {}); void secretOutput.catch(() => {});
    const fail = () => {
      if (settled) return;
      settled = true;
      stdoutAggregate?.fill(0); secretAggregate?.fill(0);
      try { child.kill(); } catch { /* fixed error */ }
      reject(safeSecretError());
    };
    child.stdin.on('error', fail);
    child.once('error', fail);
    child.once('close', async code => {
      const [outputResult, secretResult] = await Promise.allSettled([stdout, secretOutput]);
      if (outputResult.status === 'rejected' || secretResult.status === 'rejected') {
        if (outputResult.status === 'fulfilled') outputResult.value.fill(0);
        if (secretResult.status === 'fulfilled') secretResult.value.fill(0);
        fail(); return;
      }
      if (settled) { outputResult.value.fill(0); secretResult.value.fill(0); return; }
      settled = true; resolve({ exitCode: code ?? -1, stdout: outputResult.value, secretOutput: secretResult.value });
    });
    child.stdin.end(input.stdin);
  });
}
