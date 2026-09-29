import { randomBytes, randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  rmdirSync,
  unlinkSync
} from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { join } from 'node:path';
import { BridgeEnrollmentGate, BridgeIpcReader, writeBridgeIpcMessage } from './bridge-ipc.js';
import {
  createBridgeBrowserTransport,
  type BridgeBrowserTransport
} from './bridge-transport.js';
import { doctorChromeBridgeInstallation } from './installation.js';
import { SYNTHETIC_PORTAL_ORIGIN } from './types.js';
import { publishPrivateFile } from '../storage/private-files.js';

const RENDEZVOUS_ERROR = 'Chrome bridge rendezvous failed.';
const DESCRIPTOR_NAME = 'bridge-run.json';
const ENROLLMENT_NAME = 'bridge-enrollment.json';
const SOCKET_NAME = 'bridge.sock';
const ENROLLMENT_WINDOW_MS = 120_000;
const HANDSHAKE_TIMEOUT_MS = 5_000;
const SOCKET_PATH_MAXIMUM_BYTES = 100;

export interface ChromeBridgeRendezvousOptions {
  root: string;
  serviceGeneration: string;
}

export interface ChromeBridgeEnrollment {
  transport: BridgeBrowserTransport;
  tabId: number;
}

export interface ChromeBridgeRendezvous {
  readonly runtimeDirectory: string;
  readonly descriptorPath: string;
  readonly enrollmentPath: string;
  waitForEnrollment(): Promise<ChromeBridgeEnrollment>;
  close(): Promise<void>;
}

export async function startChromeBridgeRendezvous(
  input: ChromeBridgeRendezvousOptions
): Promise<ChromeBridgeRendezvous> {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).sort().join(',') !== 'root,serviceGeneration' ||
      typeof input.serviceGeneration !== 'string' ||
      !/^[A-Za-z0-9._:-]{1,128}$/.test(input.serviceGeneration)) fail();

  const report = doctorChromeBridgeInstallation({ root: input.root });
  const installation = report.installation;
  if (!report.configured || !report.registered || report.issues.length !== 0 ||
      installation.extensionId === null) fail();

  const runtimeDirectory = join(installation.root, 'runtime');
  const descriptorPath = join(runtimeDirectory, DESCRIPTOR_NAME);
  const enrollmentPath = join(runtimeDirectory, ENROLLMENT_NAME);
  const socketPath = join(runtimeDirectory, SOCKET_NAME);
  if (Buffer.byteLength(socketPath, 'utf8') > SOCKET_PATH_MAXIMUM_BYTES ||
      existsSync(runtimeDirectory)) fail();

  mkdirSync(runtimeDirectory, { mode: 0o700 });
  chmodSync(runtimeDirectory, 0o700);
  validateOwnedDirectory(runtimeDirectory);

  const runId = randomUUID();
  const capability = randomBytes(32).toString('base64url');
  const enrollment = randomBytes(32).toString('base64url');
  const expiresAt = Date.now() + ENROLLMENT_WINDOW_MS;
  const extensionOrigin = `chrome-extension://${installation.extensionId}/`;
  const gate = new BridgeEnrollmentGate({
    installationId: installation.installationId,
    runId,
    serviceGeneration: input.serviceGeneration,
    extensionOrigin,
    capability,
    enrollment,
    expiresAt
  });

  let resolveEnrollment!: (value: ChromeBridgeEnrollment) => void;
  let rejectEnrollment!: (error: Error) => void;
  const enrollmentPromise = new Promise<ChromeBridgeEnrollment>((resolve, reject) => {
    resolveEnrollment = resolve;
    rejectEnrollment = reject;
  });
  void enrollmentPromise.catch(() => {});

  let server: Server | undefined;
  let enrolled: ChromeBridgeEnrollment | undefined;
  let closing: Promise<void> | undefined;
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const rejectOnce = (): void => {
    if (settled) return;
    settled = true;
    rejectEnrollment(new Error(RENDEZVOUS_ERROR));
  };

  const removePrivateFile = (path: string): void => {
    if (!existsSync(path)) return;
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 ||
        typeof process.geteuid !== 'function' || stat.uid !== process.geteuid() ||
        (stat.mode & 0o077) !== 0) fail();
    unlinkSync(path);
  };

  const closeClient = (socket: Socket): void => {
    try { socket.destroy(); } catch { /* fixed local failure surface */ }
  };

  const stopListening = (): void => {
    if (!server?.listening) return;
    try { server.close(); } catch { /* close() performs the observed cleanup */ }
  };

  const failRun = (): void => {
    gate.close();
    rejectOnce();
    stopListening();
  };

  const handleClient = async (socket: Socket): Promise<void> => {
    const reader = new BridgeIpcReader(socket);
    try {
      const raw = await deadline(reader.read(), HANDSHAKE_TIMEOUT_MS);
      if (raw === undefined) throw new Error(RENDEZVOUS_ERROR);
      const accepted = gate.accept(raw);
      if (settled || enrolled) throw new Error(RENDEZVOUS_ERROR);

      removePrivateFile(descriptorPath);
      removePrivateFile(enrollmentPath);
      await writeBridgeIpcMessage(socket, {
        bridgeVersion: 1,
        kind: 'bridge.enrollment.accepted',
        channelId: accepted.channelId,
        tabId: accepted.tabId,
        origin: accepted.origin
      });

      const transport = createBridgeBrowserTransport({
        reader,
        output: socket,
        channelId: accepted.channelId,
        closeChannel: () => socket.destroy()
      });
      enrolled = { transport, tabId: accepted.tabId };
      settled = true;
      if (timer) clearTimeout(timer);
      stopListening();
      resolveEnrollment(enrolled);
    } catch {
      if (gate.consumed) {
        closeClient(socket);
        failRun();
        return;
      }
      try {
        await writeBridgeIpcMessage(socket, {
          bridgeVersion: 1,
          kind: 'bridge.enrollment.rejected',
          code: 'enrollment_rejected'
        });
        socket.end();
      } catch {
        closeClient(socket);
      }
    }
  };

  try {
    server = createServer(socket => {
      void handleClient(socket).catch(() => {
        closeClient(socket);
        if (gate.consumed) failRun();
      });
    });
    server.on('error', () => failRun());
    await new Promise<void>((resolve, reject) => {
      const failed = (error: Error): void => { server!.off('listening', ready); reject(error); };
      const ready = (): void => { server!.off('error', failed); resolve(); };
      server!.once('error', failed);
      server!.once('listening', ready);
      server!.listen(socketPath);
    });
    chmodSync(socketPath, 0o600);
    validateOwnedSocket(socketPath);

    await publishPrivateFile(descriptorPath, path => writeFile(path, JSON.stringify({
      version: 1,
      installationId: installation.installationId,
      runId,
      serviceGeneration: input.serviceGeneration,
      socketPath,
      capability,
      expiresAt
    }) + '\n', 'utf8'));

    await publishPrivateFile(enrollmentPath, path => writeFile(path, JSON.stringify({
      version: 1,
      enrollment,
      expiresAt
    }) + '\n', 'utf8'));

    timer = setTimeout(() => {
      if (settled) return;
      failRun();
      void closeRuntime().catch(() => {});
    }, ENROLLMENT_WINDOW_MS);
  } catch {
    gate.close();
    rejectOnce();
    if (timer) clearTimeout(timer);
    await closeRuntime().catch(() => {});
    fail();
  }

  async function closeServer(): Promise<void> {
    if (!server?.listening) return;
    await new Promise<void>(resolve => {
      try { server!.close(() => resolve()); } catch { resolve(); }
    });
  }

  function removeSocketIfOwned(): void {
    if (!existsSync(socketPath)) return;
    validateOwnedSocket(socketPath);
    unlinkSync(socketPath);
  }

  function removeRuntimeDirectoryIfEmpty(): void {
    if (!existsSync(runtimeDirectory)) return;
    validateOwnedDirectory(runtimeDirectory);
    if (readdirSync(runtimeDirectory).length === 0) rmdirSync(runtimeDirectory);
  }

  async function closeRuntime(): Promise<void> {
    if (closing) return closing;
    closing = (async () => {
      if (timer) clearTimeout(timer);
      gate.close();
      if (!settled) rejectOnce();
      try { await enrolled?.transport.close(); } catch { /* fixed local cleanup surface */ }
      await closeServer();
      try { removePrivateFile(descriptorPath); } catch { /* preserve unknown/mismatched artifact */ }
      try { removePrivateFile(enrollmentPath); } catch { /* preserve unknown/mismatched artifact */ }
      try { removeSocketIfOwned(); } catch { /* preserve unknown/mismatched artifact */ }
      try { removeRuntimeDirectoryIfEmpty(); } catch { /* preserve unknown artifacts */ }
    })();
    return closing;
  }

  return {
    runtimeDirectory,
    descriptorPath,
    enrollmentPath,
    waitForEnrollment(): Promise<ChromeBridgeEnrollment> { return enrollmentPromise; },
    close: closeRuntime
  };
}

function validateOwnedDirectory(path: string): void {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || typeof process.geteuid !== 'function' ||
      stat.uid !== process.geteuid() || (stat.mode & 0o077) !== 0) fail();
}

function validateOwnedSocket(path: string): void {
  const stat = lstatSync(path);
  if (!stat.isSocket() || stat.isSymbolicLink() || typeof process.geteuid !== 'function' ||
      stat.uid !== process.geteuid() || (stat.mode & 0o077) !== 0) fail();
}

async function deadline<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(RENDEZVOUS_ERROR)), milliseconds);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function fail(): never {
  throw new Error(RENDEZVOUS_ERROR);
}
