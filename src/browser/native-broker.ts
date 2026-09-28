import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { createConnection, type Socket } from 'node:net';
import { join, resolve } from 'node:path';
import { stderr, stdin, stdout } from 'node:process';
import { pathToFileURL } from 'node:url';
import type { Readable, Writable } from 'node:stream';
import { BridgeIpcReader, parseBridgeFrameEnvelope, writeBridgeIpcMessage } from './bridge-ipc.js';
import { doctorChromeBridgeInstallation } from './installation.js';
import { NativeMessageReader, writeNativeMessage } from './native-host.js';
import { MAX_BROWSER_MESSAGE_BYTES, SYNTHETIC_PORTAL_ORIGIN } from './types.js';

const DESCRIPTOR_NAME = 'bridge-run.json';
const SOCKET_NAME = 'bridge.sock';
const DESCRIPTOR_MAXIMUM_BYTES = 4096;
const SOCKET_PATH_MAXIMUM_BYTES = 100;
const HANDSHAKE_TIMEOUT_MS = 5000;

const serviceToChromeKinds = new Set([
  'recognize', 'inspect', 'gesture', 'session.activate', 'session.revoke', 'gesture.commit', 'gesture.cancel'
]);
const chromeToServiceKinds = new Set([
  'result', 'session.activated', 'session.revoked', 'gesture.prepared', 'gesture.cancelled', 'gesture.settled'
]);

type BrokerFailureCode =
  | 'BRIDGE_BROKER_CONFIG_ERROR'
  | 'BRIDGE_BROKER_IPC_ERROR'
  | 'BRIDGE_BROKER_ENROLLMENT_ERROR'
  | 'BRIDGE_BROKER_CHANNEL_ERROR';

class BrokerFailure extends Error {
  constructor(readonly code: BrokerFailureCode) {
    super(code);
    this.name = 'BrokerFailure';
  }
}

interface BridgeRunDescriptor {
  version: 1;
  installationId: string;
  runId: string;
  serviceGeneration: string;
  socketPath: string;
  capability: string;
  expiresAt: number;
}

interface ChromeEnrollment {
  bridgeVersion: 1;
  kind: 'bridge.enroll';
  enrollment: string;
  tabId: number;
  origin: typeof SYNTHETIC_PORTAL_ORIGIN;
}

interface BrokerIo {
  input: Readable;
  output: Writable;
}

export async function runChromeNativeBroker(argv: readonly string[], io: BrokerIo = {
  input: stdin,
  output: stdout
}): Promise<void> {
  const invocation = parseInvocation(argv);
  const report = doctorChromeBridgeInstallation({ root: invocation.root });
  const installation = report.installation;
  if (!report.configured || !report.registered || report.issues.length !== 0 ||
      installation.extensionId === null ||
      invocation.extensionOrigin !== `chrome-extension://${installation.extensionId}/`)
    fail('BRIDGE_BROKER_CONFIG_ERROR');

  const descriptor = readDescriptor(installation.root, installation.installationId);
  if (descriptor.expiresAt <= Date.now()) fail('BRIDGE_BROKER_CONFIG_ERROR');

  let socket: Socket | undefined;
  try {
    socket = await connectPrivateSocket(descriptor.socketPath);
    const nativeReader = new NativeMessageReader(io.input);
    const ipcReader = new BridgeIpcReader(socket);

    const enrollmentRaw = await deadline(nativeReader.read(), 'BRIDGE_BROKER_ENROLLMENT_ERROR');
    if (enrollmentRaw === undefined) fail('BRIDGE_BROKER_ENROLLMENT_ERROR');
    const enrollment = parseChromeEnrollment(enrollmentRaw);
    await writeBridgeIpcMessage(socket, {
      bridgeVersion: 1,
      kind: 'bridge.enroll',
      installationId: descriptor.installationId,
      runId: descriptor.runId,
      serviceGeneration: descriptor.serviceGeneration,
      extensionOrigin: invocation.extensionOrigin,
      capability: descriptor.capability,
      enrollment: enrollment.enrollment,
      tabId: enrollment.tabId,
      origin: enrollment.origin
    });

    const response = parseEnrollmentResponse(
      await deadline(ipcReader.read(), 'BRIDGE_BROKER_ENROLLMENT_ERROR'),
      enrollment
    );
    if (response.kind === 'bridge.enrollment.rejected') {
      await writeNativeMessage(io.output, response);
      return;
    }
    await writeNativeMessage(io.output, {
      bridgeVersion: 1,
      kind: 'bridge.enrollment.accepted',
      tabId: response.tabId,
      origin: response.origin
    });

    await relay(nativeReader, ipcReader, socket, io.output, response.channelId);
  } catch (error) {
    if (error instanceof BrokerFailure) throw error;
    fail('BRIDGE_BROKER_CHANNEL_ERROR');
  } finally {
    socket?.destroy();
  }
}

function parseInvocation(argv: readonly string[]): { root: string; extensionOrigin: string } {
  if (argv.length !== 3 || argv[0] !== '--root' || typeof argv[1] !== 'string' ||
      typeof argv[2] !== 'string' || resolve(argv[1]) !== argv[1] ||
      !/^chrome-extension:\/\/[a-p]{32}\/$/.test(argv[2]))
    fail('BRIDGE_BROKER_CONFIG_ERROR');
  return { root: argv[1], extensionOrigin: argv[2] };
}

function readDescriptor(root: string, installationId: string): BridgeRunDescriptor {
  try {
    const runtimeDirectory = join(root, 'runtime');
    if (realpathSync(runtimeDirectory) !== runtimeDirectory) fail('BRIDGE_BROKER_CONFIG_ERROR');
    const directory = lstatSync(runtimeDirectory, { bigint: true });
    if (!directory.isDirectory() || directory.isSymbolicLink() || typeof process.geteuid !== 'function' ||
        directory.uid !== BigInt(process.geteuid()) || (directory.mode & 0o077n) !== 0n)
      fail('BRIDGE_BROKER_CONFIG_ERROR');

    const path = join(runtimeDirectory, DESCRIPTOR_NAME);
    const stat = lstatSync(path, { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n ||
        stat.uid !== BigInt(process.geteuid()) || (stat.mode & 0o077n) !== 0n ||
        stat.size < 2n || stat.size > BigInt(DESCRIPTOR_MAXIMUM_BYTES))
      fail('BRIDGE_BROKER_CONFIG_ERROR');
    const source = readFileSync(path, 'utf8');
    if (!source.endsWith('\n')) fail('BRIDGE_BROKER_CONFIG_ERROR');
    const item = JSON.parse(source) as Record<string, unknown>;
    if (Object.keys(item).sort().join(',') !==
        'capability,expiresAt,installationId,runId,serviceGeneration,socketPath,version' ||
        item.version !== 1 || item.installationId !== installationId ||
        !identifier(item.runId) || !identifier(item.serviceGeneration) ||
        !token(item.capability) || !Number.isSafeInteger(item.expiresAt) ||
        (item.expiresAt as number) < 1 || typeof item.socketPath !== 'string')
      fail('BRIDGE_BROKER_CONFIG_ERROR');
    const socketPath = join(runtimeDirectory, SOCKET_NAME);
    if (item.socketPath !== socketPath || Buffer.byteLength(socketPath, 'utf8') > SOCKET_PATH_MAXIMUM_BYTES)
      fail('BRIDGE_BROKER_CONFIG_ERROR');
    validateSocket(socketPath);
    return {
      version: 1,
      installationId,
      runId: item.runId,
      serviceGeneration: item.serviceGeneration,
      socketPath,
      capability: item.capability,
      expiresAt: item.expiresAt as number
    };
  } catch (error) {
    if (error instanceof BrokerFailure) throw error;
    fail('BRIDGE_BROKER_CONFIG_ERROR');
  }
}

function validateSocket(path: string): void {
  const stat = lstatSync(path, { bigint: true });
  if (!stat.isSocket() || stat.isSymbolicLink() || typeof process.geteuid !== 'function' ||
      stat.uid !== BigInt(process.geteuid()) || (stat.mode & 0o077n) !== 0n)
    fail('BRIDGE_BROKER_CONFIG_ERROR');
}

async function connectPrivateSocket(path: string): Promise<Socket> {
  const socket = createConnection({ path });
  try {
    await deadline(new Promise<void>((resolveConnect, reject) => {
      const connected = (): void => { cleanup(); resolveConnect(); };
      const failed = (): void => { cleanup(); reject(new BrokerFailure('BRIDGE_BROKER_IPC_ERROR')); };
      const cleanup = (): void => {
        socket.off('connect', connected);
        socket.off('error', failed);
      };
      socket.once('connect', connected);
      socket.once('error', failed);
    }), 'BRIDGE_BROKER_IPC_ERROR');
    return socket;
  } catch {
    socket.destroy();
    fail('BRIDGE_BROKER_IPC_ERROR');
  }
}

function parseChromeEnrollment(value: unknown): ChromeEnrollment {
  if (!plainObject(value)) fail('BRIDGE_BROKER_ENROLLMENT_ERROR');
  const item = value as Record<string, unknown>;
  if (Object.keys(item).sort().join(',') !== 'bridgeVersion,enrollment,kind,origin,tabId' ||
      item.bridgeVersion !== 1 || item.kind !== 'bridge.enroll' ||
      !token(item.enrollment) || !positiveTabId(item.tabId) ||
      item.origin !== SYNTHETIC_PORTAL_ORIGIN)
    fail('BRIDGE_BROKER_ENROLLMENT_ERROR');
  return {
    bridgeVersion: 1,
    kind: 'bridge.enroll',
    enrollment: item.enrollment,
    tabId: item.tabId,
    origin: SYNTHETIC_PORTAL_ORIGIN
  };
}

type EnrollmentResponse =
  | { bridgeVersion: 1; kind: 'bridge.enrollment.accepted'; channelId: string; tabId: number;
      origin: typeof SYNTHETIC_PORTAL_ORIGIN }
  | { bridgeVersion: 1; kind: 'bridge.enrollment.rejected'; code: 'enrollment_rejected' };

function parseEnrollmentResponse(value: unknown, request: ChromeEnrollment): EnrollmentResponse {
  if (!plainObject(value)) fail('BRIDGE_BROKER_ENROLLMENT_ERROR');
  const item = value as Record<string, unknown>;
  if (item.kind === 'bridge.enrollment.accepted') {
    if (Object.keys(item).sort().join(',') !== 'bridgeVersion,channelId,kind,origin,tabId' ||
        item.bridgeVersion !== 1 || !token(item.channelId) || item.tabId !== request.tabId ||
        item.origin !== request.origin)
      fail('BRIDGE_BROKER_ENROLLMENT_ERROR');
    return {
      bridgeVersion: 1,
      kind: 'bridge.enrollment.accepted',
      channelId: item.channelId,
      tabId: request.tabId,
      origin: SYNTHETIC_PORTAL_ORIGIN
    };
  }
  if (item.kind === 'bridge.enrollment.rejected') {
    if (Object.keys(item).sort().join(',') !== 'bridgeVersion,code,kind' ||
        item.bridgeVersion !== 1 || item.code !== 'enrollment_rejected')
      fail('BRIDGE_BROKER_ENROLLMENT_ERROR');
    return { bridgeVersion: 1, kind: 'bridge.enrollment.rejected', code: 'enrollment_rejected' };
  }
  fail('BRIDGE_BROKER_ENROLLMENT_ERROR');
}

async function relay(nativeReader: NativeMessageReader, ipcReader: BridgeIpcReader, socket: Socket,
  output: Writable, channelId: string): Promise<void> {
  const chromeToService = (async () => {
    for (;;) {
      const message = await nativeReader.read();
      if (message === undefined) return;
      validateRelayMessage(message, chromeToServiceKinds);
      await writeBridgeIpcMessage(socket, { bridgeVersion: 1, kind: 'browser.frame', channelId, message });
    }
  })();
  const serviceToChrome = (async () => {
    for (;;) {
      const raw = await ipcReader.read();
      if (raw === undefined) fail('BRIDGE_BROKER_CHANNEL_ERROR');
      const envelope = parseBridgeFrameEnvelope(raw, channelId);
      validateRelayMessage(envelope.message, serviceToChromeKinds);
      await writeNativeMessage(output, envelope.message);
    }
  })();

  try {
    await Promise.race([chromeToService, serviceToChrome]);
  } catch {
    fail('BRIDGE_BROKER_CHANNEL_ERROR');
  } finally {
    socket.destroy();
    await Promise.allSettled([chromeToService, serviceToChrome]);
  }
}

function validateRelayMessage(value: unknown, allowedKinds: ReadonlySet<string>): asserts value is Record<string, unknown> {
  if (!plainObject(value)) fail('BRIDGE_BROKER_CHANNEL_ERROR');
  const item = value as Record<string, unknown>;
  let encoded: string;
  try { encoded = JSON.stringify(item); } catch { fail('BRIDGE_BROKER_CHANNEL_ERROR'); }
  if (encoded === undefined || Buffer.byteLength(encoded, 'utf8') < 1 ||
      Buffer.byteLength(encoded, 'utf8') > MAX_BROWSER_MESSAGE_BYTES ||
      item.protocolVersion !== 1 || typeof item.kind !== 'string' || !allowedKinds.has(item.kind))
    fail('BRIDGE_BROKER_CHANNEL_ERROR');
}

async function deadline<T>(promise: Promise<T>, code: BrokerFailureCode): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new BrokerFailure(code)), HANDSHAKE_TIMEOUT_MS);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype;
}

function identifier(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(value);
}

function token(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
}

function positiveTabId(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= 1_000_000;
}

function fail(code: BrokerFailureCode): never {
  throw new BrokerFailure(code);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runChromeNativeBroker(process.argv.slice(2)).then(
    () => { process.exitCode = 0; },
    error => {
      const code = error instanceof BrokerFailure ? error.code : 'BRIDGE_BROKER_CHANNEL_ERROR';
      stderr.write(`${code}\n`);
      process.exitCode = 1;
    }
  );
}
