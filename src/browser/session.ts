import { randomBytes, randomUUID } from 'node:crypto';
import { OperationStoppedError, type TrustedExecutionFence } from '../operations/execution-context.js';
import {
  BROWSER_PROTOCOL_VERSION, parseBrowserGesture, parseBrowserResponse,
  type BrowserEpoch, type BrowserGestureCommand, type BrowserPageSnapshot, type BrowserPageState,
  type BrowserRequest, type BrowserResponse, type BrowserSessionLifecycle, type BrowserSessionPort
} from './types.js';

export interface BrowserSessionTransport {
  inspect(request: BrowserRequest): Promise<unknown>;
  gesture(request: BrowserRequest, authorize: () => Promise<() => void>,
    authority: { deadline: number; signal: AbortSignal }): Promise<unknown>;
  revoke(epoch: BrowserEpoch, tabId: number): Promise<void>;
  close(): Promise<void>;
}

export interface BrowserResumePreflight {
  profileId: string;
  connectionGeneration: number;
  identityDigest: string;
  subjectDigest: string;
  termsVersion: string;
  appointmentAbsent: boolean;
}

export interface BrowserSessionPersistence {
  /** Must commit the related monitor pause before this promise resolves. */
  pauseForHuman(input: { profileId: string; epoch: string; reason: string }): Promise<void>;
  /** Releases any active service worker ownership after the epoch has been invalidated. */
  releaseWorker(): Promise<void>;
  /** Explicitly reconciles a failed/ambiguous pause before resume is permitted. */
  recoverHandoff(input: { profileId: string; epoch: string }): Promise<void>;
  /** Performs a fresh browser read of identity, subject, terms and appointment state. */
  resumePreflight(epoch: BrowserEpoch): Promise<BrowserResumePreflight>;
}

export class BrowserEpochRegistry {
  readonly #owners = new Map<string, symbol>();

  acquire(profileId: string, owner: symbol): void {
    const current = this.#owners.get(profileId);
    if (current !== undefined && current !== owner) throw new Error('Browser profile is already owned by another session.');
    this.#owners.set(profileId, owner);
  }

  release(profileId: string, owner: symbol): void {
    if (this.#owners.get(profileId) === owner) this.#owners.delete(profileId);
  }

  current(profileId: string, owner: symbol): boolean { return this.#owners.get(profileId) === owner; }
}

const sharedEpochRegistry = new BrowserEpochRegistry();

export interface BrowserSessionOptions {
  profileId: string;
  connectionGeneration: number;
  serviceGeneration: string;
  allowedOrigin: string;
  tabId: number;
  identityDigest: string;
  subjectDigest: string;
  termsVersion: string;
  transport: BrowserSessionTransport;
  persistence: BrowserSessionPersistence;
  registry?: BrowserEpochRegistry;
}

export class BrowserSession implements BrowserSessionPort, BrowserSessionLifecycle {
  readonly #owner = Symbol('browser-session');
  readonly #registry: BrowserEpochRegistry;
  #epoch: BrowserEpoch;
  #active = true;
  #sequence = 0;
  #closed = false;
  #handoffPending = false;
  #resuming = false;
  #faulted = false;
  #transitionRevision = 0;
  #faultEpoch: BrowserEpoch | undefined;
  #epochController = new AbortController();

  constructor(private readonly options: BrowserSessionOptions) {
    this.#validateOptions();
    this.#registry = options.registry ?? sharedEpochRegistry;
    this.#epoch = this.#newEpoch();
    this.#registry.acquire(options.profileId, this.#owner);
  }

  get epoch(): BrowserEpoch { return { ...this.#epoch }; }
  get profileId(): string { return this.options.profileId; }
  get connectionGeneration(): number { return this.options.connectionGeneration; }

  async recognize(fence: TrustedExecutionFence): Promise<BrowserPageSnapshot> {
    const token = this.#captureOperation();
    await this.#assertCurrent(fence, token);
    const request = this.#request(token, 'recognize');
    const response = parseBrowserResponse(await this.#withinEpoch(token, this.options.transport.inspect(request)));
    await this.#assertCurrent(fence, token);
    this.#assertResponse(request, response);
    return structuredClone(response.snapshot);
  }

  async inspect(expectedState: BrowserPageState, fence: TrustedExecutionFence): Promise<BrowserPageSnapshot> {
    const token = this.#captureOperation();
    await this.#assertCurrent(fence, token);
    const request = this.#request(token, 'inspect', expectedState);
    const response = parseBrowserResponse(await this.#withinEpoch(token, this.options.transport.inspect(request)));
    await this.#assertCurrent(fence, token);
    this.#assertResponse(request, response);
    if (response.pageState !== expectedState) throw new Error('Browser page state changed before inspection.');
    return structuredClone(response.snapshot);
  }

  async gesture(command: BrowserGestureCommand, expectedState: BrowserPageState,
    fence: TrustedExecutionFence): Promise<BrowserPageSnapshot> {
    const token = this.#captureOperation();
    await this.#assertCurrent(fence, token);
    const checked = parseBrowserGesture(command);
    const request = this.#request(token, 'gesture', expectedState, checked);
    const response = parseBrowserResponse(await this.#withinEpoch(token, this.options.transport.gesture(request, async () => {
      await this.#assertCurrent(fence, token);
      return () => {
        this.#assertOperationToken(token);
        if (fence.serviceGeneration !== this.options.serviceGeneration || fence.signal.aborted ||
            Date.now() >= fence.deadline) throw new OperationStoppedError();
      };
    }, { deadline: fence.deadline, signal: fence.signal })));
    await this.#assertCurrent(fence, token);
    this.#assertResponse(request, response);
    return structuredClone(response.snapshot);
  }

  async transferToHuman(reason: string): Promise<void> {
    if (!this.#active || this.#closed) return;
    if (this.#handoffPending || this.#resuming) throw new Error('Browser lifecycle transition is already in progress.');
    if (typeof reason !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(reason))
      throw new Error('Invalid browser handoff reason.');
    const previous = this.#epoch;
    this.#handoffPending = true;
    const revision = ++this.#transitionRevision;
    let pauseCompleted = false;
    try {
      await this.options.persistence.pauseForHuman({ profileId: previous.profileId, epoch: previous.epoch, reason });
      pauseCompleted = true;
      this.#assertTransition(revision, 'handoff');
      this.#invalidate();
      await this.options.transport.revoke(previous, this.options.tabId);
      this.#assertTransition(revision, 'handoff');
      await this.options.persistence.releaseWorker();
      this.#assertTransition(revision, 'handoff');
    } catch (error) {
      if (!pauseCompleted && !this.#closed && revision === this.#transitionRevision) {
        this.#faulted = true; this.#faultEpoch = { ...previous }; this.#invalidate();
        try { await this.options.transport.revoke(previous, this.options.tabId); } catch { /* remain faulted */ }
      } else if (!this.#closed && revision === this.#transitionRevision && this.#faulted === false) {
        this.#faulted = true; this.#faultEpoch = { ...previous };
      }
      throw error;
    } finally {
      if (revision === this.#transitionRevision) this.#handoffPending = false;
    }
  }

  async recoverHandoff(): Promise<void> {
    if (this.#closed) throw new Error('Browser session is closed.');
    if (!this.#faulted || !this.#faultEpoch) throw new Error('Browser handoff recovery is not required.');
    if (this.#handoffPending || this.#resuming) throw new Error('Browser lifecycle transition is already in progress.');
    this.#handoffPending = true;
    const revision = ++this.#transitionRevision;
    const faultEpoch = { ...this.#faultEpoch };
    try {
      await this.options.persistence.recoverHandoff({ profileId: faultEpoch.profileId, epoch: faultEpoch.epoch });
      this.#assertTransition(revision, 'handoff');
      this.#faulted = false; this.#faultEpoch = undefined;
    } finally {
      if (revision === this.#transitionRevision) this.#handoffPending = false;
    }
  }

  async resume(): Promise<BrowserEpoch> {
    if (this.#closed) throw new Error('Browser session is closed.');
    if (this.#faulted) throw new Error('Browser handoff must be explicitly recovered before resume.');
    if (this.#handoffPending || this.#resuming) throw new Error('Browser lifecycle transition is already in progress.');
    if (this.#active) throw new Error('Browser session is already active.');
    this.#resuming = true;
    const revision = ++this.#transitionRevision;
    const candidate = this.#newEpoch();
    try {
      const preflight = await this.options.persistence.resumePreflight({ ...candidate });
      this.#assertTransition(revision, 'resume');
      if (preflight.profileId !== this.options.profileId ||
          preflight.connectionGeneration !== this.options.connectionGeneration ||
          preflight.identityDigest !== this.options.identityDigest ||
          preflight.subjectDigest !== this.options.subjectDigest ||
          preflight.termsVersion !== this.options.termsVersion || preflight.appointmentAbsent !== true)
        throw new Error('Browser resume preflight did not match the trusted binding.');
      this.#registry.acquire(this.options.profileId, this.#owner);
      this.#epoch = candidate;
      this.#epochController = new AbortController();
      this.#sequence = 0;
      this.#active = true;
      return { ...candidate };
    } finally {
      if (revision === this.#transitionRevision) this.#resuming = false;
    }
  }

  async shutdown(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    ++this.#transitionRevision;
    const wasActive = this.#active;
    const previous = { ...this.#epoch };
    this.#invalidate();
    try {
      if (wasActive) {
        try { await this.options.transport.revoke(previous, this.options.tabId); } finally {
          await this.options.persistence.releaseWorker();
        }
      }
    } finally { await this.options.transport.close(); }
  }

  #request(token: BrowserOperationToken, kind: 'recognize'): BrowserRequest;
  #request(token: BrowserOperationToken, kind: 'inspect', expectedState: BrowserPageState): BrowserRequest;
  #request(token: BrowserOperationToken, kind: 'gesture', expectedState: BrowserPageState,
    command: BrowserGestureCommand): BrowserRequest;
  #request(token: BrowserOperationToken, kind: 'recognize' | 'inspect' | 'gesture', expectedPageState?: BrowserPageState,
    command?: BrowserGestureCommand): BrowserRequest {
    this.#assertOperationToken(token);
    const envelope = { protocolVersion: BROWSER_PROTOCOL_VERSION, requestId: randomUUID(),
      profileId: token.epoch.profileId, connectionGeneration: token.epoch.connectionGeneration,
      epoch: token.epoch.epoch, serviceGeneration: token.epoch.serviceGeneration,
      origin: token.epoch.allowedOrigin, tabId: this.options.tabId, sequence: ++this.#sequence };
    return kind === 'recognize' ? { ...envelope, kind } : kind === 'inspect'
      ? { ...envelope, kind, expectedPageState: expectedPageState! }
      : { ...envelope, kind, expectedPageState: expectedPageState!, command: command! };
  }

  async #assertCurrent(fence: TrustedExecutionFence, token: BrowserOperationToken): Promise<void> {
    this.#assertOperationToken(token);
    if (fence.serviceGeneration !== this.options.serviceGeneration) throw new OperationStoppedError();
    await fence.assertCurrent();
    this.#assertOperationToken(token);
    if (fence.signal.aborted || Date.now() >= fence.deadline) throw new OperationStoppedError();
  }

  #captureOperation(): BrowserOperationToken {
    this.#assertOwned();
    return { epoch: { ...this.#epoch }, controller: this.#epochController };
  }

  #assertOperationToken(token: BrowserOperationToken): void {
    if (token.controller.signal.aborted || token.controller !== this.#epochController ||
        token.epoch.epoch !== this.#epoch.epoch) throw new Error('Browser session is not current.');
    this.#assertOwned();
  }

  #assertOwned(): void {
    if (!this.#active || this.#closed || this.#handoffPending || this.#resuming || this.#faulted ||
        !this.#registry.current(this.options.profileId, this.#owner))
      throw new Error('Browser session is not current.');
  }

  #assertTransition(revision: number, kind: 'handoff' | 'resume'): void {
    if (this.#closed || revision !== this.#transitionRevision ||
        (kind === 'handoff' ? !this.#handoffPending : !this.#resuming))
      throw new Error('Browser session is not current.');
  }

  #assertResponse(request: BrowserRequest, response: BrowserResponse): void {
    if (response.requestId !== request.requestId || response.profileId !== request.profileId ||
        response.connectionGeneration !== request.connectionGeneration || response.epoch !== request.epoch ||
        response.serviceGeneration !== request.serviceGeneration || response.origin !== request.origin ||
        response.tabId !== request.tabId || response.sequence !== request.sequence)
      throw new Error('Browser response binding or replay is invalid.');
  }

  #invalidate(): void {
    this.#active = false;
    this.#epochController.abort(new Error('Browser session is not current.'));
    this.#registry.release(this.options.profileId, this.#owner);
    this.#epoch = { ...this.#epoch, epoch: randomBytes(32).toString('hex') };
  }

  #newEpoch(): BrowserEpoch {
    return { profileId: this.options.profileId, connectionGeneration: this.options.connectionGeneration,
      epoch: randomBytes(32).toString('hex'), serviceGeneration: this.options.serviceGeneration,
      allowedOrigin: this.options.allowedOrigin };
  }

  async #withinEpoch<T>(token: BrowserOperationToken, operation: Promise<T>): Promise<T> {
    const signal = token.controller.signal;
    void operation.catch(() => {});
    if (signal.aborted) throw signal.reason;
    let onAbort: (() => void) | undefined;
    const invalidated = new Promise<never>((_, reject) => {
      onAbort = () => reject(signal.reason ?? new Error('Browser session is not current.'));
      signal.addEventListener('abort', onAbort, { once: true });
    });
    try { return await Promise.race([operation, invalidated]); }
    finally { if (onAbort) signal.removeEventListener('abort', onAbort); }
  }

  #validateOptions(): void {
    if (!this.options || typeof this.options.profileId !== 'string' || !this.options.profileId ||
        !Number.isSafeInteger(this.options.connectionGeneration) || this.options.connectionGeneration < 1 ||
        typeof this.options.serviceGeneration !== 'string' || !this.options.serviceGeneration ||
        !/^http:\/\/127\.0\.0\.1:\d+$/.test(this.options.allowedOrigin) ||
        !Number.isSafeInteger(this.options.tabId) || this.options.tabId < 1 ||
        !/^[a-f0-9]{64}$/.test(this.options.identityDigest) ||
        !/^[a-f0-9]{64}$/.test(this.options.subjectDigest) ||
        typeof this.options.termsVersion !== 'string' || !this.options.termsVersion)
      throw new Error('Invalid browser session configuration.');
  }
}

interface BrowserOperationToken {
  epoch: BrowserEpoch;
  controller: AbortController;
}
