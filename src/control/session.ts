import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { identifier } from '../kernel/types.js';
import type {
  ControlBinding, ControlBootstrap, ControlPrincipal, ControlSession
} from './types.js';
import { OwnerControlError } from './types.js';

const BOOTSTRAP_TTL = 5 * 60_000;
const SESSION_TTL = 60 * 60_000;
const IDLE_TTL = 15 * 60_000;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

interface BootstrapAuthority {
  readonly origin: string;
  readonly digest: Buffer;
  readonly deadline: number;
}

interface SessionAuthority {
  readonly digest: Buffer;
  readonly absoluteDeadline: number;
  idleDeadline: number;
  readonly principal: ControlPrincipal;
}

function token(): string {
  return randomBytes(32).toString('base64url');
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'ascii').digest();
}

function credentialDigest(value: unknown): Buffer | undefined {
  if (typeof value !== 'string' || !TOKEN_PATTERN.test(value)) return undefined;
  return digest(value);
}

function matches(left: Buffer, right: Buffer): boolean {
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}

function canonicalOrigin(origin: unknown): asserts origin is string {
  if (typeof origin !== 'string') throw new OwnerControlError('invalid_request');
  try {
    const parsed = new URL(origin);
    if (parsed.origin !== origin || !['http:', 'https:'].includes(parsed.protocol))
      throw new OwnerControlError('invalid_request');
  } catch (error) {
    if (error instanceof OwnerControlError) throw error;
    throw new OwnerControlError('invalid_request');
  }
}

export class OwnerControlSessions {
  readonly instanceId = randomUUID();
  readonly #binding: ControlBinding;
  readonly #clock: () => number;
  #bootstrap: BootstrapAuthority | undefined;
  #session: SessionAuthority | undefined;
  #issued = false;
  #failedAttempts = 0;
  #closed = false;

  constructor(binding: ControlBinding, clock: () => number = Date.now) {
    if (!binding || typeof binding !== 'object' || Array.isArray(binding) ||
      Object.getPrototypeOf(binding) !== Object.prototype ||
      Object.keys(binding).length !== 2 || !Object.hasOwn(binding, 'workspaceId') || !Object.hasOwn(binding, 'ownerId') ||
      typeof clock !== 'function') throw new OwnerControlError('invalid_request');
    try {
      identifier(binding.workspaceId, 'workspaceId');
      identifier(binding.ownerId, 'ownerId');
    } catch {
      throw new OwnerControlError('invalid_request');
    }
    this.#binding = Object.freeze({ workspaceId: binding.workspaceId, ownerId: binding.ownerId });
    this.#clock = clock;
  }

  issueBootstrap(origin: string): ControlBootstrap {
    this.#available();
    canonicalOrigin(origin);
    if (this.#issued) throw new OwnerControlError('conflict');
    const now = this.#now();
    const bearer = token();
    const deadline = now + BOOTSTRAP_TTL;
    this.#bootstrap = { origin, digest: digest(bearer), deadline };
    this.#issued = true;
    return { version: 1, origin, token: bearer, expiresAt: new Date(deadline).toISOString() };
  }

  exchangeBootstrap(value: string, origin: string): ControlSession {
    this.#available();
    canonicalOrigin(origin);
    const bootstrap = this.#bootstrap;
    if (!bootstrap) throw new OwnerControlError('unauthenticated');
    if (origin !== bootstrap.origin) throw new OwnerControlError('forbidden');
    if (this.#failedAttempts >= 10) throw new OwnerControlError('rate_limited');
    const supplied = credentialDigest(value);
    if (!supplied || !matches(supplied, bootstrap.digest)) {
      if (supplied) this.#failedAttempts++;
      throw new OwnerControlError('unauthenticated');
    }
    const now = this.#now();
    if (now >= bootstrap.deadline) {
      this.#clearBootstrap();
      throw new OwnerControlError('unauthenticated');
    }
    this.#clearBootstrap();
    const bearer = token();
    const absoluteDeadline = now + SESSION_TTL;
    const idleDeadline = Math.min(now + IDLE_TTL, absoluteDeadline);
    const principal: ControlPrincipal = Object.freeze({ ...this.#binding,
      instanceId: this.instanceId, sessionId: randomUUID() });
    this.#session = { digest: digest(bearer), absoluteDeadline, idleDeadline, principal };
    return { token: bearer, expiresAt: new Date(absoluteDeadline).toISOString(),
      idleExpiresAt: new Date(idleDeadline).toISOString() };
  }

  authenticate(value: string): ControlPrincipal {
    this.#available();
    const now = this.#now();
    const session = this.#liveSession(now);
    const supplied = credentialDigest(value);
    if (!supplied || !matches(supplied, session.digest)) throw new OwnerControlError('unauthenticated');
    session.idleDeadline = Math.min(now + IDLE_TTL, session.absoluteDeadline);
    return session.principal;
  }

  assertActive(principal: ControlPrincipal): void {
    this.#available();
    const session = this.#liveSession(this.#now());
    if (principal !== session.principal) throw new OwnerControlError('unauthenticated');
  }

  logout(principal: ControlPrincipal): void {
    this.assertActive(principal);
    this.#clearSession();
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#clearBootstrap();
    this.#clearSession();
  }

  #available(): void {
    if (this.#closed) throw new OwnerControlError('unavailable');
  }

  #now(): number {
    const value = this.#clock();
    if (!Number.isFinite(value)) throw new OwnerControlError('unavailable');
    return value;
  }

  #liveSession(now: number): SessionAuthority {
    const session = this.#session;
    if (!session) throw new OwnerControlError('unauthenticated');
    if (now >= session.absoluteDeadline || now >= session.idleDeadline) {
      this.#clearSession();
      throw new OwnerControlError('unauthenticated');
    }
    return session;
  }

  #clearBootstrap(): void {
    this.#bootstrap?.digest.fill(0);
    this.#bootstrap = undefined;
  }

  #clearSession(): void {
    this.#session?.digest.fill(0);
    this.#session = undefined;
  }
}
