import type { Readable, Writable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { MAX_BROWSER_MESSAGE_BYTES, parseBrowserRequest, parseBrowserResponse,
  type BrowserEpoch, type BrowserRequest, type BrowserResponse } from './types.js';
import type { SecretMetadata, SecretProvider, SecretReference } from '../secrets/types.js';
import { exactSecretAccess } from '../connections/private-connection.js';

export const MAX_NATIVE_MESSAGE_BYTES = MAX_BROWSER_MESSAGE_BYTES;

export class NativeHostSecretAccess {
  readonly #provider: SecretProvider;
  readonly #allowed: readonly SecretMetadata[];
  readonly #connectionId: string;
  readonly #connectionGeneration: number;
  readonly #controller = new AbortController();
  readonly #borrows = new Set<Uint8Array>();
  #active = true;

  constructor(provider: SecretProvider, allowed: readonly SecretMetadata[], options: { connectionGeneration: number }) {
    if (!provider || typeof provider.withSecret !== 'function' || !Array.isArray(allowed) || allowed.length < 1 ||
        !options || !Number.isSafeInteger(options.connectionGeneration) || options.connectionGeneration < 1)
      throw new Error('Secret storage operation failed.');
    this.#provider = provider;
    this.#allowed = Object.freeze(allowed.map(item => Object.freeze({ ...item })));
    this.#connectionId = this.#allowed[0]!.connectionId;
    if (this.#allowed.some(item => item.connectionId !== this.#connectionId))
      throw new Error('Secret storage operation failed.');
    this.#connectionGeneration = options.connectionGeneration;
  }

  get connectionId(): string { return this.#connectionId; }
  get connectionGeneration(): number { return this.#connectionGeneration; }

  revoke(connectionId: string, connectionGeneration: number): void {
    if (connectionId !== this.#connectionId || connectionGeneration !== this.#connectionGeneration)
      throw new Error('Secret storage operation failed.');
    if (!this.#active) return;
    this.#active = false;
    this.#controller.abort();
    for (const secret of this.#borrows) secret.fill(0);
  }

  async withSecret<T>(request: SecretReference, use: (secret: Uint8Array) => Promise<T> | T,
    options?: { signal?: AbortSignal }): Promise<T> {
    try {
      if (!this.#active || this.#controller.signal.aborted) throw new Error();
      const checked = exactSecretAccess(request, this.#allowed);
      return await this.#provider.withSecret(checked, async secret => {
        if (!this.#active || this.#controller.signal.aborted) throw new Error();
        this.#borrows.add(secret);
        const operation = Promise.resolve().then(() => use(secret));
        void operation.catch(() => {});
        let onAbort: (() => void) | undefined;
        const stopped = new Promise<never>((_resolve, reject) => {
          onAbort = () => reject(new Error());
          this.#controller.signal.addEventListener('abort', onAbort, { once: true });
        });
        try {
          const result = await Promise.race([operation, stopped]);
          if (!this.#active || this.#controller.signal.aborted) throw new Error();
          return result;
        } finally {
          if (onAbort) this.#controller.signal.removeEventListener('abort', onAbort);
          secret.fill(0); this.#borrows.delete(secret);
        }
      }, options);
    } catch { throw new Error('Secret storage operation failed.'); }
  }
}

export interface NativeHostBoundaryOptions {
  epoch: BrowserEpoch;
  tabId: number;
  dispatch(request: BrowserRequest): Promise<unknown>;
}

export class NativeHostBoundary {
  #lastSequence = 0;

  constructor(private readonly options: NativeHostBoundaryOptions) {
    if (!options || !Number.isSafeInteger(options.tabId) || options.tabId < 1 ||
        typeof options.dispatch !== 'function') throw new Error('Invalid native host boundary configuration.');
  }

  async handle(value: unknown): Promise<BrowserResponse> {
    const request = parseBrowserRequest(value);
    const epoch = this.options.epoch;
    if (request.profileId !== epoch.profileId || request.connectionGeneration !== epoch.connectionGeneration ||
        request.epoch !== epoch.epoch || request.serviceGeneration !== epoch.serviceGeneration ||
        request.origin !== epoch.allowedOrigin || request.tabId !== this.options.tabId ||
        request.sequence !== this.#lastSequence + 1)
      throw new Error('Native message binding or replay is invalid.');
    this.#lastSequence = request.sequence;
    const response = parseBrowserResponse(await this.options.dispatch(request));
    assertResponseBinding(request, response);
    return response;
  }
}

export class NativeMessagingTransport {
  readonly #reader: NativeMessageReader;
  readonly #pending = new Map<string, NativePendingExchange>();
  #reading: Promise<void> | undefined;
  #operationPending = false;
  #closed = false;
  #failed = false;
  #binding: { value: NativeControlBinding; state: 'activating' | 'active' | 'revoking' } | undefined;
  #activation: Promise<void> | undefined;

  constructor(input: Readable, private readonly output: Writable,
    private readonly maximum = MAX_NATIVE_MESSAGE_BYTES, private readonly timeoutMs = 10_000) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000)
      throw new Error('Invalid native messaging timeout.');
    this.#reader = new NativeMessageReader(input, maximum);
  }

  async inspect(request: BrowserRequest): Promise<unknown> {
    return this.#operation(async () => {
      const checked = parseBrowserRequest(request);
      await this.#ensureActive(checked);
      this.#assertActive(checked);
      return parseBrowserResponse(await this.#exchange(checked, checked.requestId));
    });
  }

  async gesture(request: BrowserRequest, authorize: () => Promise<() => void>,
    authority?: { deadline: number; signal: AbortSignal }): Promise<unknown> {
    return this.#operation(async () => {
      const checked = parseBrowserRequest(request);
      if (checked.kind !== 'gesture') throw framingError();
      const operationId = randomUUID();
      const expiresAt = operationExpiry(authority);
      let operationSent = false; let cancelRequested = false; let cancellation: Promise<boolean> | undefined;
      const cancel = () => {
        cancelRequested = true;
        if (operationSent && !cancellation) {
          cancellation = this.#cancelGesture(checked, operationId);
          void cancellation.catch(() => {});
        }
      };
      const timer = setTimeout(cancel, remainingOperationTime(expiresAt));
      authority?.signal.addEventListener('abort', cancel, { once: true });
      try {
        await this.#ensureActive(checked);
        this.#assertActive(checked);
        if (cancelRequested) throw operationCancelled();
        const operation: NativeGestureRequest = { ...checked, operationId,
          operationExpiresAt: expiresAt };
        operationSent = true;
        const prepared = parsePreparedResponse(await this.#exchange(operation, checked.requestId));
        assertResponseBinding(checked, { ...prepared, kind: 'result' });
        if (cancelRequested && (!cancellation || await cancellation)) throw operationCancelled();
        const finalCheck = await authorize();
        if (typeof finalCheck !== 'function') throw framingError();
        const commit: NativeGestureCommit = { ...bindingFromRequest(checked), protocolVersion: 1,
          kind: 'gesture.commit', controlId: randomUUID(), requestId: checked.requestId,
          sequence: checked.sequence, operationId };
        finalCheck();
        remainingOperationTime(expiresAt);
        if (cancelRequested && (!cancellation || await cancellation)) throw operationCancelled();
        const response = parseBrowserResponse(await this.#exchange(commit, commit.requestId));
        if (cancelRequested && (!cancellation || await cancellation)) throw operationCancelled();
        assertResponseBinding(checked, response);
        return response;
      } finally {
        clearTimeout(timer);
        authority?.signal.removeEventListener('abort', cancel);
      }
    });
  }

  async #cancelGesture(request: Extract<BrowserRequest, { kind: 'gesture' }>, operationId: string): Promise<boolean> {
    const cancellation: NativeGestureCancel = { ...bindingFromRequest(request), protocolVersion: 1,
      kind: 'gesture.cancel', controlId: randomUUID(), requestId: request.requestId,
      sequence: request.sequence, operationId };
    const response = parseCancellationResponse(await this.#exchange(cancellation, cancellation.controlId));
    assertControlBinding(cancellation, response);
    if (response.requestId !== request.requestId || response.sequence !== request.sequence ||
        response.operationId !== operationId) throw bindingError();
    if (response.kind === 'gesture.cancelled') {
      this.#rejectPending(request.requestId, operationCancelled());
      return true;
    }
    return false;
  }

  async revoke(epoch: BrowserEpoch, tabId: number): Promise<void> {
    if (this.#closed) throw new Error('Native messaging transport is closed.');
    const binding = bindingFromEpoch(epoch, tabId);
    if (!this.#binding) return;
    if (this.#binding && !sameNativeBinding(this.#binding.value, binding)) throw bindingError();
    if (this.#binding.state === 'activating') {
      if (!this.#activation) throw bindingError();
      await this.#activation;
      if (this.#closed) throw new Error('Native messaging transport is closed.');
    }
    if (!this.#activeBindingMatches(binding)) throw bindingError();
    this.#binding = { value: binding, state: 'revoking' };
    const request: NativeSessionControl = { ...binding, protocolVersion: 1, kind: 'session.revoke',
      controlId: randomUUID() };
    const response = parseControlResponse(await this.#exchange(request, request.controlId), 'session.revoked');
    assertControlBinding(request, response);
    this.#cancelOutstandingExchanges();
    if (this.#binding && sameNativeBinding(this.#binding.value, binding)) this.#binding = undefined;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true; this.#binding = undefined;
    const error = new Error('Native messaging transport is closed.');
    for (const pending of this.#pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.#pending.clear();
  }

  async #operation<T>(run: () => Promise<T>): Promise<T> {
    if (this.#closed) throw new Error('Native messaging transport is closed.');
    if (this.#operationPending) throw new Error('Native messaging transport already has an active request.');
    this.#operationPending = true;
    try { return await run(); } finally { this.#operationPending = false; }
  }

  async #ensureActive(request: BrowserRequest): Promise<void> {
    const binding = bindingFromRequest(request);
    if (this.#binding) {
      if (!sameNativeBinding(this.#binding.value, binding) || this.#binding.state !== 'active') throw bindingError();
      return;
    }
    this.#binding = { value: binding, state: 'activating' };
    const control: NativeSessionControl = { ...binding, protocolVersion: 1, kind: 'session.activate',
      controlId: randomUUID() };
    const activation = (async () => {
      const response = parseControlResponse(await this.#exchange(control, control.controlId), 'session.activated');
      assertControlBinding(control, response);
      if (!this.#binding || this.#binding.state !== 'activating' ||
          !sameNativeBinding(this.#binding.value, binding)) throw bindingError();
      this.#binding.state = 'active';
    })();
    this.#activation = activation;
    try {
      await activation;
    } catch (error) {
      if (this.#binding?.state === 'activating') this.#binding = undefined;
      throw error;
    } finally {
      if (this.#activation === activation) this.#activation = undefined;
    }
  }

  #assertActive(request: BrowserRequest): void {
    if (!this.#activeBindingMatches(bindingFromRequest(request))) throw bindingError();
  }

  #activeBindingMatches(binding: NativeControlBinding): boolean {
    return this.#binding?.state === 'active' && sameNativeBinding(this.#binding.value, binding);
  }

  async #exchange(value: NativeWireRequest, key: string): Promise<unknown> {
    if (this.#closed) throw new Error('Native messaging transport is closed.');
    if (this.#failed) throw new Error('Native messaging transport is unavailable.');
    if (this.#pending.has(key)) throw bindingError();
    const response = new Promise<unknown>((resolve, reject) => {
      const pending: NativePendingExchange = { resolve, reject,
        timer: setTimeout(() => this.#fail(new Error('Native messaging response timed out.')), this.timeoutMs) };
      this.#pending.set(key, pending);
    });
    const responseOutcome = response.then(result => ({ kind: 'response' as const, result }));
    this.#startReader();
    const writeOutcome = writeNativeMessage(this.output, value, this.maximum).then(
      () => ({ kind: 'written' as const }),
      () => { throw framingError(); });
    try {
      const first = await Promise.race([responseOutcome, writeOutcome]);
      return first.kind === 'response' ? first.result : await response;
    } catch (error) {
      const failure = error instanceof Error ? error : framingError();
      if (!(failure instanceof NativeOperationCancelledError)) this.#fail(failure);
      throw failure;
    }
  }

  #startReader(): void {
    if (this.#reading) return;
    this.#reading = (async () => {
      try {
        while (!this.#closed) {
          const raw = await this.#reader.read();
          if (raw === undefined) throw framingError();
          const key = responseKey(raw);
          const pending = this.#pending.get(key);
          if (!pending) throw bindingError();
          clearTimeout(pending.timer); this.#pending.delete(key); pending.resolve(raw);
        }
      } catch {
        this.#fail(framingError());
      }
    })();
    void this.#reading.catch(() => {});
  }

  #fail(error: Error): void {
    if (this.#failed) return;
    this.#failed = true;
    for (const pending of this.#pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.#pending.clear();
  }

  #rejectPending(key: string, error: Error): void {
    const pending = this.#pending.get(key);
    if (!pending) return;
    clearTimeout(pending.timer); this.#pending.delete(key); pending.reject(error);
  }

  #cancelOutstandingExchanges(): void {
    for (const key of [...this.#pending.keys()]) this.#rejectPending(key, operationCancelled());
  }
}

interface NativePendingExchange {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

interface NativeControlBinding {
  profileId: string;
  connectionGeneration: number;
  epoch: string;
  serviceGeneration: string;
  origin: string;
  tabId: number;
}

interface NativeSessionControl extends NativeControlBinding {
  protocolVersion: 1;
  kind: 'session.activate' | 'session.revoke';
  controlId: string;
}

interface NativeControlResponse extends NativeControlBinding {
  protocolVersion: 1;
  kind: 'session.activated' | 'session.revoked';
  controlId: string;
}

interface NativeGestureCommit extends NativeControlBinding {
  protocolVersion: 1;
  kind: 'gesture.commit';
  controlId: string;
  requestId: string;
  sequence: number;
  operationId: string;
}

interface NativeGestureCancel extends Omit<NativeGestureCommit, 'kind'> {
  kind: 'gesture.cancel';
}

interface NativeGestureCancellationResponse extends Omit<NativeGestureCancel, 'kind'> {
  kind: 'gesture.cancelled' | 'gesture.settled';
}

type NativeGestureRequest = Extract<BrowserRequest, { kind: 'gesture' }> & {
  operationId: string;
  operationExpiresAt: number;
};

type NativeWireRequest = BrowserRequest | NativeGestureRequest | NativeSessionControl | NativeGestureCommit |
  NativeGestureCancel;

function operationExpiry(authority?: { deadline: number; signal: AbortSignal }): number {
  if (!authority) return monotonicNativeNow() + 10_000;
  if (!Number.isFinite(authority.deadline) || authority.signal.aborted) throw operationExpired();
  const remaining = authority.deadline - Date.now();
  if (remaining <= 0) throw operationExpired();
  return monotonicNativeNow() + Math.min(60_000, remaining);
}

function remainingOperationTime(expiresAt: number): number {
  const remaining = Math.ceil(expiresAt - monotonicNativeNow());
  if (remaining < 1) throw operationExpired();
  return Math.min(60_000, remaining);
}

function monotonicNativeNow(): number { return performance.timeOrigin + performance.now(); }

function operationExpired(): Error { return new Error('Browser gesture deadline expired.'); }
class NativeOperationCancelledError extends Error {
  constructor() { super('Browser gesture was cancelled.'); this.name = 'NativeOperationCancelledError'; }
}

function operationCancelled(): Error { return new NativeOperationCancelledError(); }

function bindingFromRequest(request: BrowserRequest): NativeControlBinding {
  return { profileId: request.profileId, connectionGeneration: request.connectionGeneration,
    epoch: request.epoch, serviceGeneration: request.serviceGeneration, origin: request.origin, tabId: request.tabId };
}

function bindingFromEpoch(epoch: BrowserEpoch, tabId: number): NativeControlBinding {
  if (!Number.isSafeInteger(tabId) || tabId < 1 || tabId > 1_000_000) throw bindingError();
  const checked = parseBrowserRequest({ protocolVersion: 1, kind: 'inspect', requestId: 'binding-check',
    profileId: epoch.profileId, connectionGeneration: epoch.connectionGeneration, epoch: epoch.epoch,
    serviceGeneration: epoch.serviceGeneration, origin: epoch.allowedOrigin, tabId, sequence: 1,
    expectedPageState: 'unknown' });
  return bindingFromRequest(checked);
}

function sameNativeBinding(left: NativeControlBinding, right: NativeControlBinding): boolean {
  return left.profileId === right.profileId && left.connectionGeneration === right.connectionGeneration &&
    left.epoch === right.epoch && left.serviceGeneration === right.serviceGeneration &&
    left.origin === right.origin && left.tabId === right.tabId;
}

function parseControlResponse(value: unknown, expectedKind: 'session.activated' | 'session.revoked'):
  NativeControlResponse {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw framingError();
  const item = value as Record<string, unknown>;
  const keys = ['protocolVersion', 'kind', 'controlId', 'profileId', 'connectionGeneration', 'epoch',
    'serviceGeneration', 'origin', 'tabId'].sort();
  if (Object.keys(item).sort().join('\0') !== keys.join('\0') || item.kind !== expectedKind ||
      item.protocolVersion !== 1 || typeof item.controlId !== 'string' ||
      !/^[A-Za-z0-9._:-]{1,128}$/.test(item.controlId) || typeof item.profileId !== 'string' ||
      typeof item.connectionGeneration !== 'number' || typeof item.epoch !== 'string' ||
      typeof item.serviceGeneration !== 'string' || typeof item.origin !== 'string' ||
      typeof item.tabId !== 'number') throw framingError();
  const binding = bindingFromEpoch({ profileId: item.profileId,
    connectionGeneration: item.connectionGeneration, epoch: item.epoch,
    serviceGeneration: item.serviceGeneration, allowedOrigin: item.origin }, item.tabId);
  return { ...binding, protocolVersion: 1, kind: expectedKind, controlId: item.controlId };
}

function parsePreparedResponse(value: unknown): Omit<BrowserResponse, 'kind'> & { kind: 'gesture.prepared' } {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      (value as Record<string, unknown>).kind !== 'gesture.prepared') throw framingError();
  const response = parseBrowserResponse({ ...(value as Record<string, unknown>), kind: 'result' });
  return { ...response, kind: 'gesture.prepared' };
}

function parseCancellationResponse(value: unknown): NativeGestureCancellationResponse {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw framingError();
  const item = value as Record<string, unknown>;
  const keys = ['protocolVersion', 'kind', 'controlId', 'profileId', 'connectionGeneration', 'epoch',
    'serviceGeneration', 'origin', 'tabId', 'requestId', 'sequence', 'operationId'].sort();
  if (Object.keys(item).sort().join('\0') !== keys.join('\0') ||
      (item.kind !== 'gesture.cancelled' && item.kind !== 'gesture.settled') ||
      typeof item.requestId !== 'string' || typeof item.operationId !== 'string' ||
      typeof item.sequence !== 'number') throw framingError();
  const control = parseControlResponse({ ...Object.fromEntries(Object.entries(item).filter(([key]) =>
    !['requestId', 'sequence', 'operationId'].includes(key))), kind: 'session.revoked' }, 'session.revoked');
  return { ...control, kind: item.kind, requestId: identifierValue(item.requestId),
    sequence: positiveValue(item.sequence), operationId: identifierValue(item.operationId) } as
    NativeGestureCancellationResponse;
}

function identifierValue(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(value)) throw framingError();
  return value;
}

function positiveValue(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 1_000_000)
    throw framingError();
  return value as number;
}

function assertControlBinding(request: NativeControlBinding & { controlId: string },
  response: NativeControlBinding & { controlId: string }): void {
  if (response.controlId !== request.controlId || !sameNativeBinding(request, response)) throw bindingError();
}

function responseKey(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw framingError();
  const item = value as Record<string, unknown>;
  const key = typeof item.controlId === 'string' ? item.controlId : item.requestId;
  if (typeof key !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(key)) throw framingError();
  return key;
}

function bindingError(): Error { return new Error('Native message binding or replay is invalid.'); }

function sizeError(): Error { return new Error('Native message size is invalid.'); }
function framingError(): Error { return new Error('Native message framing is invalid.'); }

export function encodeNativeMessage(value: unknown, maximum = MAX_NATIVE_MESSAGE_BYTES): Buffer {
  let body: Buffer;
  try { body = Buffer.from(JSON.stringify(value), 'utf8'); } catch { throw framingError(); }
  if (body.length < 1 || body.length > maximum) throw sizeError();
  const framed = Buffer.allocUnsafe(body.length + 4);
  framed.writeUInt32LE(body.length, 0);
  body.copy(framed, 4);
  return framed;
}

export class NativeMessageReader {
  readonly #iterator: AsyncIterator<unknown>;
  #buffer = Buffer.alloc(0);
  #ended = false;

  constructor(input: Readable, private readonly maximum = MAX_NATIVE_MESSAGE_BYTES) {
    this.#iterator = input[Symbol.asyncIterator]();
  }

  async read(): Promise<unknown | undefined> {
    const header = await this.#take(4, true);
    if (header === undefined) return undefined;
    const length = header.readUInt32LE(0);
    if (length < 1 || length > this.maximum) throw sizeError();
    const body = await this.#take(length, false);
    if (!body) throw framingError();
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)); }
    catch { throw framingError(); }
  }

  async #take(length: number, cleanEof: boolean): Promise<Buffer | undefined> {
    while (this.#buffer.length < length && !this.#ended) {
      let next: IteratorResult<unknown>;
      try { next = await this.#iterator.next(); } catch { throw framingError(); }
      if (next.done) { this.#ended = true; break; }
      if (!(typeof next.value === 'string' || ArrayBuffer.isView(next.value))) throw framingError();
      const chunk = Buffer.isBuffer(next.value) ? next.value : Buffer.from(next.value as Uint8Array);
      if (chunk.length > 0) this.#buffer = this.#buffer.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.#buffer, chunk]);
      if (this.#buffer.length > this.maximum + 4) {
        const declared = this.#buffer.length >= 4 ? this.#buffer.readUInt32LE(0) : 0;
        if (declared > this.maximum) throw sizeError();
      }
    }
    if (this.#buffer.length === 0 && cleanEof) return undefined;
    if (this.#buffer.length < length) throw framingError();
    const result = this.#buffer.subarray(0, length);
    this.#buffer = Buffer.from(this.#buffer.subarray(length));
    return result;
  }
}

export async function readNativeMessage(input: Readable,
  maximum = MAX_NATIVE_MESSAGE_BYTES): Promise<unknown | undefined> {
  return new NativeMessageReader(input, maximum).read();
}

export function writeNativeMessage(output: Writable, value: unknown,
  maximum = MAX_NATIVE_MESSAGE_BYTES): Promise<void> {
  const framed = encodeNativeMessage(value, maximum);
  const state = writerState(output);
  if (state.failed || state.closed) return Promise.reject(framingError());
  return new Promise((resolve, reject) => {
    const pending = { reject: () => reject(framingError()) };
    state.pending.add(pending);
    try {
      output.write(framed, error => {
        state.pending.delete(pending);
        if (error || state.failed || state.closed) reject(framingError()); else resolve();
      });
    } catch {
      state.pending.delete(pending); state.failed = true; reject(framingError());
    }
  });
}

interface NativeWriterState {
  failed: boolean;
  closed: boolean;
  pending: Set<{ reject(): void }>;
}

const nativeWriters = new WeakMap<Writable, NativeWriterState>();

function writerState(output: Writable): NativeWriterState {
  const existing = nativeWriters.get(output);
  if (existing) return existing;
  const state: NativeWriterState = { failed: false, closed: false, pending: new Set() };
  nativeWriters.set(output, state);
  output.on('error', () => {
    state.failed = true;
    for (const pending of state.pending) pending.reject();
    state.pending.clear();
  });
  output.on('close', () => {
    state.closed = true;
    for (const pending of state.pending) pending.reject();
    state.pending.clear();
  });
  return state;
}

export async function runNativeMessagingHost(input: Readable, output: Writable,
  handler: (request: BrowserRequest) => Promise<unknown>, maximum = MAX_NATIVE_MESSAGE_BYTES): Promise<void> {
  const reader = new NativeMessageReader(input, maximum);
  for (;;) {
    const raw = await reader.read();
    if (raw === undefined) return;
    const request = parseBrowserRequest(raw);
    const response = parseBrowserResponse(await handler(request));
    assertResponseBinding(request, response);
    await writeNativeMessage(output, response, maximum);
  }
}

function assertResponseBinding(request: BrowserRequest, response: BrowserResponse): void {
  if (response.requestId !== request.requestId || response.profileId !== request.profileId ||
      response.connectionGeneration !== request.connectionGeneration || response.epoch !== request.epoch ||
      response.serviceGeneration !== request.serviceGeneration || response.origin !== request.origin ||
      response.tabId !== request.tabId || response.sequence !== request.sequence)
    throw new Error('Native message response binding is invalid.');
}
