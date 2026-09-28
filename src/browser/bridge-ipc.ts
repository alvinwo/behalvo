import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { Readable, Writable } from 'node:stream';
import {
  NativeMessageReader,
  encodeNativeMessage,
  writeNativeMessage
} from './native-host.js';
import { MAX_BROWSER_MESSAGE_BYTES, SYNTHETIC_PORTAL_ORIGIN } from './types.js';

export const MAX_BRIDGE_IPC_BYTES = 64 * 1024;
export const MAX_BRIDGE_PENDING_BYTES = 256 * 1024;

const ENROLLMENT_ERROR = 'Bridge IPC enrollment rejected.';
const FRAMING_ERROR = 'Bridge IPC framing failed.';

export interface BridgeEnrollmentExpected {
  installationId: string;
  runId: string;
  serviceGeneration: string;
  extensionOrigin: string;
  capability: string;
  enrollment: string;
  expiresAt: number;
}

export interface BridgeEnrollmentAccepted {
  channelId: string;
  tabId: number;
  origin: typeof SYNTHETIC_PORTAL_ORIGIN;
}

interface BridgeEnrollmentHello {
  bridgeVersion: 1;
  kind: 'bridge.enroll';
  installationId: string;
  runId: string;
  serviceGeneration: string;
  extensionOrigin: string;
  capability: string;
  enrollment: string;
  tabId: number;
  origin: typeof SYNTHETIC_PORTAL_ORIGIN;
}

export interface BridgeFrameEnvelope {
  bridgeVersion: 1;
  kind: 'browser.frame';
  channelId: string;
  message: Record<string, unknown>;
}

export class BridgeEnrollmentGate {
  readonly #installationId: string;
  readonly #runId: string;
  readonly #serviceGeneration: string;
  readonly #extensionOrigin: string;
  readonly #expiresAt: number;
  readonly #capability: Buffer;
  readonly #enrollment: Buffer;
  #consumed = false;
  #closed = false;

  constructor(expected: BridgeEnrollmentExpected) {
    try {
      if (!expected || typeof expected !== 'object' || Array.isArray(expected) ||
          Object.keys(expected).sort().join(',') !==
            'capability,enrollment,expiresAt,extensionOrigin,installationId,runId,serviceGeneration' ||
          !identifier(expected.installationId) || !identifier(expected.runId) ||
          !identifier(expected.serviceGeneration) || !extensionOrigin(expected.extensionOrigin) ||
          !token(expected.capability) || !token(expected.enrollment) ||
          !Number.isSafeInteger(expected.expiresAt) || expected.expiresAt < 1)
        rejectEnrollment();
      this.#installationId = expected.installationId;
      this.#runId = expected.runId;
      this.#serviceGeneration = expected.serviceGeneration;
      this.#extensionOrigin = expected.extensionOrigin;
      this.#expiresAt = expected.expiresAt;
      this.#capability = Buffer.from(expected.capability, 'ascii');
      this.#enrollment = Buffer.from(expected.enrollment, 'ascii');
    } catch {
      rejectEnrollment();
    }
  }

  get consumed(): boolean {
    return this.#consumed;
  }

  accept(value: unknown, now = Date.now()): BridgeEnrollmentAccepted {
    try {
      if (this.#closed || this.#consumed || !Number.isSafeInteger(now) || now < 0) rejectEnrollment();
      if (now >= this.#expiresAt) {
        this.close();
        rejectEnrollment();
      }
      const hello = parseEnrollmentHello(value);
      if (hello.installationId !== this.#installationId || hello.runId !== this.#runId ||
          hello.serviceGeneration !== this.#serviceGeneration || hello.extensionOrigin !== this.#extensionOrigin ||
          hello.origin !== SYNTHETIC_PORTAL_ORIGIN ||
          !constantTimeTokenEquals(this.#capability, hello.capability) ||
          !constantTimeTokenEquals(this.#enrollment, hello.enrollment))
        rejectEnrollment();

      this.#consumed = true;
      this.#capability.fill(0);
      this.#enrollment.fill(0);
      return {
        channelId: randomBytes(32).toString('base64url'),
        tabId: hello.tabId,
        origin: SYNTHETIC_PORTAL_ORIGIN
      };
    } catch {
      rejectEnrollment();
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#capability.fill(0);
    this.#enrollment.fill(0);
  }
}

export class BridgeIpcReader {
  readonly #reader: NativeMessageReader;

  constructor(input: Readable) {
    this.#reader = new NativeMessageReader(input, MAX_BRIDGE_IPC_BYTES);
  }

  async read(): Promise<unknown | undefined> {
    try {
      return await this.#reader.read();
    } catch {
      throw new Error(FRAMING_ERROR);
    }
  }
}

export function encodeBridgeIpcMessage(value: unknown): Buffer {
  try {
    return encodeNativeMessage(value, MAX_BRIDGE_IPC_BYTES);
  } catch {
    throw new Error(FRAMING_ERROR);
  }
}

export async function writeBridgeIpcMessage(output: Writable, value: unknown): Promise<void> {
  try {
    await writeNativeMessage(output, value, MAX_BRIDGE_IPC_BYTES);
  } catch {
    throw new Error(FRAMING_ERROR);
  }
}

export function parseBridgeFrameEnvelope(value: unknown, expectedChannelId: string): BridgeFrameEnvelope {
  try {
    if (!token(expectedChannelId) || !plainObject(value)) failFraming();
    const item = value as Record<string, unknown>;
    if (Object.keys(item).sort().join(',') !== 'bridgeVersion,channelId,kind,message' ||
        item.bridgeVersion !== 1 || item.kind !== 'browser.frame' ||
        item.channelId !== expectedChannelId || !plainObject(item.message))
      failFraming();
    const message = item.message as Record<string, unknown>;
    const encoded = JSON.stringify(message);
    if (encoded === undefined || Buffer.byteLength(encoded, 'utf8') < 1 ||
        Buffer.byteLength(encoded, 'utf8') > MAX_BROWSER_MESSAGE_BYTES)
      failFraming();
    return {
      bridgeVersion: 1,
      kind: 'browser.frame',
      channelId: expectedChannelId,
      message
    };
  } catch {
    throw new Error(FRAMING_ERROR);
  }
}

function parseEnrollmentHello(value: unknown): BridgeEnrollmentHello {
  if (!plainObject(value)) rejectEnrollment();
  const item = value as Record<string, unknown>;
  const keys = [
    'bridgeVersion', 'kind', 'installationId', 'runId', 'serviceGeneration',
    'extensionOrigin', 'capability', 'enrollment', 'tabId', 'origin'
  ].sort().join(',');
  if (Object.keys(item).sort().join(',') !== keys || item.bridgeVersion !== 1 ||
      item.kind !== 'bridge.enroll' || !identifier(item.installationId) ||
      !identifier(item.runId) || !identifier(item.serviceGeneration) ||
      !extensionOrigin(item.extensionOrigin) || !token(item.capability) ||
      !token(item.enrollment) || !positiveTabId(item.tabId) ||
      item.origin !== SYNTHETIC_PORTAL_ORIGIN)
    rejectEnrollment();
  return {
    bridgeVersion: 1,
    kind: 'bridge.enroll',
    installationId: item.installationId as string,
    runId: item.runId as string,
    serviceGeneration: item.serviceGeneration as string,
    extensionOrigin: item.extensionOrigin as string,
    capability: item.capability as string,
    enrollment: item.enrollment as string,
    tabId: item.tabId as number,
    origin: SYNTHETIC_PORTAL_ORIGIN
  };
}

function constantTimeTokenEquals(expected: Buffer, candidate: string): boolean {
  if (!token(candidate)) return false;
  const observed = Buffer.from(candidate, 'ascii');
  return observed.length === expected.length && timingSafeEqual(expected, observed);
}

function identifier(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(value);
}

function token(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
}

function extensionOrigin(value: unknown): value is string {
  return typeof value === 'string' && /^chrome-extension:\/\/[a-p]{32}\/$/.test(value);
}

function positiveTabId(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= 1_000_000;
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype;
}

function rejectEnrollment(): never {
  throw new Error(ENROLLMENT_ERROR);
}

function failFraming(): never {
  throw new Error(FRAMING_ERROR);
}
