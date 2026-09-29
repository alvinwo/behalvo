import { randomBytes, randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { acquireSyntheticProfileLease, type SyntheticProfileLease } from '../connections/private-connection.js';
import { loadOwnerControlAssets } from '../control/assets.js';
import type { ControlAssets } from '../control/http-server.js';
import { startLocalService, type LocalService } from '../service/local-service.js';
import { startSyntheticPortal, type SyntheticPortalServer } from '../synthetic-portal/server.js';
import { doctorChromeBridgeInstallation, type ChromeBridgeDoctorReport } from './installation.js';
import { startChromeBridgeRendezvous, type ChromeBridgeRendezvous } from './rendezvous.js';
import { parseBrowserResponse, SYNTHETIC_PORTAL_ORIGIN } from './types.js';

const LAUNCH_ERROR = 'Chrome bridge launch failed.';
const MAXIMUM_STDERR_BYTES = 16 * 1024;
const CHROME_CLEANUP_TIMEOUT_MS = 5_000;

export interface DedicatedChromeLaunchOptions {
  chromePath: string;
  profilePath: string;
}

export interface DedicatedChromeProcess {
  readonly child: ChildProcess;
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  stderr(): string;
}

export function launchDedicatedChrome(input: DedicatedChromeLaunchOptions): DedicatedChromeProcess {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).sort().join(',') !== 'chromePath,profilePath' ||
      typeof input.chromePath !== 'string' || !isAbsolute(input.chromePath) ||
      typeof input.profilePath !== 'string' || !isAbsolute(input.profilePath))
    throw new Error(LAUNCH_ERROR);

  let child: ChildProcess;
  try {
    child = spawn(input.chromePath, [
      `--user-data-dir=${input.profilePath}`,
      'http://127.0.0.1:43117/'
    ], {
      shell: false,
      stdio: ['ignore', 'ignore', 'pipe']
    });
  } catch {
    throw new Error(LAUNCH_ERROR);
  }

  let errorText = '';
  let errorBytes = 0;
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    if (errorBytes >= MAXIMUM_STDERR_BYTES) return;
    const remaining = MAXIMUM_STDERR_BYTES - errorBytes;
    const bytes = Buffer.from(chunk, 'utf8');
    const kept = bytes.subarray(0, remaining);
    errorText += kept.toString('utf8');
    errorBytes += kept.byteLength;
  });

  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    let settled = false;
    child.once('error', () => {
      if (settled) return;
      settled = true;
      reject(new Error(LAUNCH_ERROR));
    });
    child.once('exit', (code, signal) => {
      if (settled) return;
      settled = true;
      resolve({ code, signal });
    });
  });
  void exited.catch(() => {});

  return {
    child,
    exited,
    stderr(): string { return errorText; }
  };
}


const DIAGNOSTIC_ERROR = 'Chrome bridge diagnostic failed.';

export interface ChromeBridgeDiagnosticInput {
  root: string;
  dbPath: string;
  bootstrapDirectory: string;
  workspaceId: string;
  ownerId: string;
  storageKeyPath?: string;
  encryptionKey?: Uint8Array;
}

export interface ChromeBridgeDiagnosticResult {
  serviceOrigin: string;
  bootstrapPath: string;
  enrollmentPath: string;
  tabId: number;
  pageState: 'login';
}

export interface ChromeBridgeDiagnosticDependencies {
  doctor?: (input: { root: string }) => ChromeBridgeDoctorReport;
  acquireProfileLease?: (input: {
    installationId: string;
    profileId: string;
    profilePath: string;
  }) => SyntheticProfileLease;
  startPortal?: () => Promise<SyntheticPortalServer>;
  startService?: typeof startLocalService;
  startRendezvous?: typeof startChromeBridgeRendezvous;
  launchChrome?: typeof launchDedicatedChrome;
  assets?: ControlAssets;
}

export async function runChromeBridgeDiagnostic(
  input: ChromeBridgeDiagnosticInput,
  dependencies: ChromeBridgeDiagnosticDependencies = {}
): Promise<ChromeBridgeDiagnosticResult> {
  const checked = validateDiagnosticInput(input);
  const doctor = dependencies.doctor ?? doctorChromeBridgeInstallation;
  const acquireProfileLease = dependencies.acquireProfileLease ?? acquireSyntheticProfileLease;
  const startPortal = dependencies.startPortal ?? (() => startSyntheticPortal());
  const startService = dependencies.startService ?? startLocalService;
  const startRendezvous = dependencies.startRendezvous ?? startChromeBridgeRendezvous;
  const launchChrome = dependencies.launchChrome ?? launchDedicatedChrome;
  const report = doctor({ root: checked.root });
  const installation = report.installation;
  if (!report.configured || !report.registered || report.issues.length !== 0 ||
      installation.extensionId === null) diagnosticFail();

  let lease: SyntheticProfileLease | undefined;
  let portal: SyntheticPortalServer | undefined;
  let service: LocalService | undefined;
  let rendezvous: ChromeBridgeRendezvous | undefined;
  let transport: Awaited<ReturnType<ChromeBridgeRendezvous['waitForEnrollment']>>['transport'] | undefined;
  let chrome: DedicatedChromeProcess | undefined;
  let chromeExitedCleanly = false;
  let chromeExitObserved = false;
  let primaryError: unknown;

  try {
    lease = acquireProfileLease({
      installationId: installation.installationId,
      profileId: 'synthetic-chrome',
      profilePath: installation.profilePath
    });
    portal = await startPortal();
    if (portal.origin !== SYNTHETIC_PORTAL_ORIGIN) diagnosticFail();

    service = await startService({
      dbPath: checked.dbPath,
      bootstrapDirectory: checked.bootstrapDirectory,
      workspaceId: checked.workspaceId,
      ownerId: checked.ownerId,
      assets: dependencies.assets ?? loadOwnerControlAssets(),
      upgradeStorage: false,
      syntheticOperations: false,
      port: 0,
      ...(checked.encryptionKey ? { encryptionKey: checked.encryptionKey } : {}),
      ...(checked.storageKeyPath ? { storageKeyPath: checked.storageKeyPath } : {})
    });

    rendezvous = await startRendezvous({
      root: installation.root,
      serviceGeneration: service.serviceGeneration
    });
    chrome = launchChrome({
      chromePath: installation.chromePath,
      profilePath: installation.profilePath
    });

    const enrollmentRace = await Promise.race([
      rendezvous.waitForEnrollment().then(enrollment => ({ kind: 'enrolled' as const, enrollment })),
      chrome.exited.then(
        exit => ({ kind: 'exited' as const, exit }),
        () => ({ kind: 'exited' as const, exit: undefined })
      )
    ]);
    if (enrollmentRace.kind === 'exited') {
      chromeExitObserved = true;
      diagnosticFail();
    }
    const enrolled = enrollmentRace.enrollment;
    transport = enrolled.transport;
    const request = {
      protocolVersion: 1 as const,
      kind: 'inspect' as const,
      requestId: randomUUID(),
      profileId: 'synthetic-chrome',
      connectionGeneration: 1,
      epoch: randomBytes(32).toString('hex'),
      serviceGeneration: service.serviceGeneration,
      origin: SYNTHETIC_PORTAL_ORIGIN,
      tabId: enrolled.tabId,
      sequence: 1,
      expectedPageState: 'login' as const
    };
    const response = parseBrowserResponse(await transport.inspect(request));
    if (response.requestId !== request.requestId || response.profileId !== request.profileId ||
        response.connectionGeneration !== request.connectionGeneration ||
        response.epoch !== request.epoch || response.serviceGeneration !== request.serviceGeneration ||
        response.origin !== request.origin || response.tabId !== request.tabId ||
        response.sequence !== request.sequence || response.pageState !== 'login' ||
        response.snapshot.state !== 'login') diagnosticFail();

    const exit = await chrome.exited;
    chromeExitObserved = true;
    chromeExitedCleanly = exit.code === 0 && exit.signal === null;
    if (!chromeExitedCleanly || chrome.stderr() !== '') diagnosticFail();

    return {
      serviceOrigin: service.origin,
      bootstrapPath: service.bootstrapPath,
      enrollmentPath: rendezvous.enrollmentPath,
      tabId: enrolled.tabId,
      pageState: 'login'
    };
  } catch (error) {
    primaryError = error;
    throw error instanceof Error && error.message === DIAGNOSTIC_ERROR ? error : new Error(DIAGNOSTIC_ERROR);
  } finally {
    let cleanupFailed = false;
    if (primaryError !== undefined && chrome && !chromeExitObserved) {
      chromeExitObserved = await terminateDiagnosticChrome(chrome);
      if (!chromeExitObserved) cleanupFailed = true;
    }
    try { await transport?.close(); } catch { cleanupFailed = true; }
    try {
      if (service && !await service.shutdown()) cleanupFailed = true;
    } catch { cleanupFailed = true; }
    try { await rendezvous?.close(); } catch { cleanupFailed = true; }
    try { await portal?.close(); } catch { cleanupFailed = true; }
    if (chromeExitObserved) {
      try { lease?.release(); } catch { cleanupFailed = true; }
    }
    if (cleanupFailed && primaryError === undefined) diagnosticFail();
  }
}

async function terminateDiagnosticChrome(chrome: DedicatedChromeProcess): Promise<boolean> {
  try { chrome.child.kill('SIGTERM'); } catch { /* exit observation still decides custody release */ }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      chrome.exited,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(DIAGNOSTIC_ERROR)), CHROME_CLEANUP_TIMEOUT_MS);
      })
    ]);
    return true;
  } catch {
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function validateDiagnosticInput(input: unknown): ChromeBridgeDiagnosticInput {
  if (!input || typeof input !== 'object' || Array.isArray(input)) diagnosticFail();
  const item = input as Record<string, unknown>;
  const allowed = new Set(['root', 'dbPath', 'bootstrapDirectory', 'workspaceId', 'ownerId', 'storageKeyPath', 'encryptionKey']);
  if (Object.keys(item).some(key => !allowed.has(key)) ||
      !['root', 'dbPath', 'bootstrapDirectory', 'workspaceId', 'ownerId'].every(key => key in item) ||
      typeof item.root !== 'string' || !isAbsolute(item.root) ||
      typeof item.dbPath !== 'string' || !isAbsolute(item.dbPath) ||
      typeof item.bootstrapDirectory !== 'string' || !isAbsolute(item.bootstrapDirectory) ||
      typeof item.workspaceId !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(item.workspaceId) ||
      typeof item.ownerId !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(item.ownerId) ||
      (item.storageKeyPath !== undefined && (typeof item.storageKeyPath !== 'string' || !isAbsolute(item.storageKeyPath))) ||
      (item.encryptionKey !== undefined && !(item.encryptionKey instanceof Uint8Array))) diagnosticFail();
  return {
    root: item.root,
    dbPath: item.dbPath,
    bootstrapDirectory: item.bootstrapDirectory,
    workspaceId: item.workspaceId,
    ownerId: item.ownerId,
    ...(typeof item.storageKeyPath === 'string' ? { storageKeyPath: item.storageKeyPath } : {}),
    ...(item.encryptionKey instanceof Uint8Array ? { encryptionKey: item.encryptionKey } : {})
  };
}

function diagnosticFail(): never {
  throw new Error(DIAGNOSTIC_ERROR);
}
