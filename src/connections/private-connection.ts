import { chmodSync, closeSync, constants, existsSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync,
  readFileSync, readdirSync, realpathSync, rmdirSync, unlinkSync, writeFileSync, renameSync } from 'node:fs';
import type { BigIntStats } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import {
  exactSecretObject,
  parseSecretReference,
  safeSecretError,
  secretIdentifier,
  secretOwnerToken,
  type SecretMetadata,
  type SecretProvider,
  type SecretReference
} from '../secrets/types.js';

const CONNECTION_ERROR = 'Private connection operation failed.';
const forbiddenPathParts = new Set(['.git', 'dropbox', 'onedrive', 'google drive', 'icloud drive',
  'cloudstorage', 'mobile documents', 'com~apple~clouddocs', 'clouddocs', 'box', 'box sync',
  'support', 'backup', 'backups']);
const CUSTODY_DIRECTORY_SUFFIX = '.behalvo-private-custody';
const CUSTODY_STATE = 'owner.json';
const RECOVERY_CLAIM_PREFIX = 'recovery-claim-';
const RECOVERY_ELECTION_PREFIX = 'recovery-election-';
const MAXIMUM_CUSTODY_ARTIFACTS = 64;

export interface PrivateConnectionRegistration {
  id: string;
  service: string;
  accountId: string;
  generation: number;
  profileId: string;
  profilePath: string;
  mode: 'synthetic' | 'live';
  dedicated: true;
  fullDiskEncryptionAcknowledged: boolean;
  secretReferences: readonly SecretMetadata[];
}

export interface PrivateConnectionSummary {
  id: string;
  service: string;
  generation: number;
  profileId: string;
  mode: 'synthetic' | 'live';
  state: 'connected' | 'disconnecting' | 'disconnect_failed' | 'disconnected';
  secretPurposes: string[];
}

export interface PrivateConnectionDisconnectResult {
  connectionId: string;
  state: 'disconnected';
  profileRemovalOffered: true;
  profilePath: string;
  deletedPurposes: string[];
}

export interface PrivateProfileCustodyInspection {
  custodyId: string;
  pid: number;
  profileDevice: string;
  profileInode: string;
}

interface StoredConnection extends PrivateConnectionRegistration {
  state: PrivateConnectionSummary['state'];
  profileIdentity: ProfileIdentity;
  custody: ProfileCustody;
  registrationDigest: string;
  progress: DisconnectProgress;
}

interface DisconnectProgress {
  deletePurposes?: string[];
  connectionRevoked: boolean;
  browserRevoked: boolean;
  brokersRevoked: boolean;
  monitorsStopped: boolean;
  deletedPurposes: Set<string>;
  completed: boolean;
}

export interface PrivateConnectionManagerOptions {
  secretProvider: SecretProvider;
  platform?: NodeJS.Platform;
  authority?: PrivateConnectionAuthority;
}

export interface PrivateConnectionAuthority {
  assertConnection(connection: Readonly<PrivateConnectionRegistration>): void;
  revokeConnection(connection: Readonly<PrivateConnectionRegistration>): Promise<void>;
  revokeBrowserEpochs(connection: Readonly<PrivateConnectionRegistration>): Promise<void>;
  stopAndReleaseMonitors(connection: Readonly<PrivateConnectionRegistration>): Promise<void>;
  revokeSecretBrokers(connection: Readonly<PrivateConnectionRegistration>): Promise<void>;
}

export interface PrivateConnectionControl {
  list(): PrivateConnectionSummary[];
  disconnect(input: unknown): Promise<PrivateConnectionDisconnectResult>;
  bindAuthority(authority: PrivateConnectionAuthority): void;
}

function fail(): never { throw new Error(CONNECTION_ERROR); }

export class PrivateConnectionManager implements PrivateConnectionControl {
  readonly #provider: SecretProvider;
  readonly #platform: NodeJS.Platform;
  #authority: PrivateConnectionAuthority | undefined;
  readonly #connections = new Map<string, StoredConnection>();
  readonly #disconnects = new Map<string, Promise<PrivateConnectionDisconnectResult>>();

  constructor(options: PrivateConnectionManagerOptions) {
    if (!options || !options.secretProvider || typeof options.secretProvider.delete !== 'function') fail();
    this.#provider = options.secretProvider; this.#platform = options.platform ?? process.platform;
    if (options.authority !== undefined) this.bindAuthority(options.authority);
  }

  bindAuthority(authority: PrivateConnectionAuthority): void {
    if (this.#authority || !authority || typeof authority.assertConnection !== 'function' ||
        typeof authority.revokeConnection !== 'function' || typeof authority.revokeBrowserEpochs !== 'function' ||
        typeof authority.stopAndReleaseMonitors !== 'function' || typeof authority.revokeSecretBrokers !== 'function') fail();
    this.#authority = authority;
  }

  register(input: PrivateConnectionRegistration): PrivateConnectionSummary {
    try {
      const checked = parseRegistration(input, this.#platform);
      if (!this.#authority) fail();
      this.#authority.assertConnection(checked);
      if (this.#connections.has(checked.id)) fail();
      const profileIdentity = validateProfile(checked.profilePath);
      const digest = registrationDigest(checked, profileIdentity);
      const custody = acquireProfileCustody(checked.profilePath, profileIdentity, secretOwnerToken(), digest);
      const stored: StoredConnection = { ...checked, state: 'connected', profileIdentity, custody,
        registrationDigest: digest,
        progress: emptyProgress() };
      this.#connections.set(stored.id, stored);
      return summary(stored);
    } catch { fail(); }
  }

  recover(input: PrivateConnectionRegistration, options: unknown): PrivateConnectionSummary {
    try {
      const checked = parseRegistration(input, this.#platform);
      if (!this.#authority || this.#connections.has(checked.id)) fail();
      const recovery = exactSecretObject(options, ['expectedCustodyId', 'confirmStaleProcessExited']);
      if (recovery.confirmStaleProcessExited !== true) fail();
      const expectedCustodyId = secretIdentifier(recovery.expectedCustodyId);
      const profileIdentity = validateProfile(checked.profilePath);
      const digest = registrationDigest(checked, profileIdentity);
      const { lockPath, statePath } = custodyPaths(checked.profilePath);
      const custodyDirectoryPresent = pathEntryExists(lockPath);
      const custodyStatePresent = custodyDirectoryPresent && pathEntryExists(statePath);
      const recovered = custodyStatePresent
        ? recoverProfileCustody(checked.profilePath, profileIdentity, expectedCustodyId, digest)
        : recoverDisconnectReceipt(checked, profileIdentity, expectedCustodyId, digest);
      if (custodyDirectoryPresent && !custodyStatePresent)
        finalizeOrphanedCustody(lockPath, custodyHeader(expectedCustodyId, profileIdentity, digest));
      const state = recovered.progress.completed ? 'disconnected'
        : recovered.progress.deletePurposes ? 'disconnect_failed' : 'connected';
      if (!recovered.progress.deletePurposes) this.#authority.assertConnection(checked);
      const stored: StoredConnection = { ...checked, state, profileIdentity, custody: recovered.custody,
        registrationDigest: digest,
        progress: recovered.progress };
      if (custodyStatePresent && recovered.progress.completed) {
        writeDisconnectReceipt(stored);
        stored.custody.release();
      }
      this.#connections.set(stored.id, stored);
      return summary(stored);
    } catch { fail(); }
  }

  list(): PrivateConnectionSummary[] {
    return [...this.#connections.values()].map(summary).sort((left, right) => left.id.localeCompare(right.id));
  }

  async disconnect(input: unknown): Promise<PrivateConnectionDisconnectResult> {
    try {
      const item = exactSecretObject(input, ['connectionId', 'deletePurposes']);
      const connectionId = secretIdentifier(item.connectionId);
      if (!Array.isArray(item.deletePurposes) || item.deletePurposes.some(value => typeof value !== 'string')) fail();
      const deletePurposes = [...new Set(item.deletePurposes.map(secretIdentifier))].sort();
      const connection = this.#connections.get(connectionId);
      if (!connection || !['connected', 'disconnecting', 'disconnect_failed', 'disconnected'].includes(connection.state)) fail();
      if (deletePurposes.some(purpose => !connection!.secretReferences.some(reference => reference.purpose === purpose)))
        fail();
      if (connection.progress.deletePurposes && !sameStrings(connection.progress.deletePurposes, deletePurposes)) fail();
      const active = this.#disconnects.get(connectionId);
      if (active) return active;
      const attempt = this.#continueDisconnect(connection, deletePurposes);
      this.#disconnects.set(connectionId, attempt);
      try { return await attempt; }
      finally { if (this.#disconnects.get(connectionId) === attempt) this.#disconnects.delete(connectionId); }
    } catch { throw new Error(CONNECTION_ERROR); }
  }

  async #continueDisconnect(connection: StoredConnection, deletePurposes: string[]):
  Promise<PrivateConnectionDisconnectResult> {
    try {
      if (!connection.progress.deletePurposes) {
        connection.custody.record({ type: 'disconnect.started', deletePurposes });
        connection.progress.deletePurposes = [...deletePurposes];
      }
      connection.state = 'disconnecting';
      if (!connection.progress.connectionRevoked) {
        await this.#authority!.revokeConnection(connection);
        connection.custody.record({ type: 'connection.revoked' }); connection.progress.connectionRevoked = true;
      }
      if (!connection.progress.browserRevoked) {
        await this.#authority!.revokeBrowserEpochs(connection);
        connection.custody.record({ type: 'browser.revoked' }); connection.progress.browserRevoked = true;
      }
      if (!connection.progress.brokersRevoked) {
        await this.#authority!.revokeSecretBrokers(connection);
        connection.custody.record({ type: 'brokers.revoked' }); connection.progress.brokersRevoked = true;
      }
      if (!connection.progress.monitorsStopped) {
        await this.#authority!.stopAndReleaseMonitors(connection);
        connection.custody.record({ type: 'monitors.stopped' }); connection.progress.monitorsStopped = true;
      }
      const selected = connection.secretReferences.filter(reference => deletePurposes.includes(reference.purpose));
      for (const reference of selected) {
        if (connection.progress.deletedPurposes.has(reference.purpose)) continue;
        const query = { service: reference.service, connectionId: reference.connectionId,
          accountId: reference.accountId, purpose: reference.purpose };
        const before = await this.#provider.list(query);
        if (before.some(item => item.reference === reference.reference)) {
          try {
            await this.#provider.delete({ service: reference.service, connectionId: reference.connectionId,
              purpose: reference.purpose, accountId: reference.accountId, reference: reference.reference });
          } catch {
            const after = await this.#provider.list(query);
            if (after.some(item => item.reference === reference.reference)) throw new Error(CONNECTION_ERROR);
          }
        }
        connection.custody.record({ type: 'secret.deleted', purpose: reference.purpose });
        connection.progress.deletedPurposes.add(reference.purpose);
      }
      if (!connection.progress.completed) {
        connection.custody.record({ type: 'disconnect.completed' }); connection.progress.completed = true;
      }
      writeDisconnectReceipt(connection);
      connection.custody.release(); connection.state = 'disconnected';
      return disconnectResult(connection);
    } catch {
      connection.state = 'disconnect_failed';
      throw new Error(CONNECTION_ERROR);
    }
  }
}

function emptyProgress(): DisconnectProgress {
  return { connectionRevoked: false, browserRevoked: false, brokersRevoked: false, monitorsStopped: false,
    deletedPurposes: new Set(), completed: false };
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function disconnectResult(connection: StoredConnection): PrivateConnectionDisconnectResult {
  return { connectionId: connection.id, state: 'disconnected', profileRemovalOffered: true,
    profilePath: connection.profilePath, deletedPurposes: [...connection.progress.deletedPurposes].sort() };
}

function parseRegistration(value: unknown, platform: NodeJS.Platform): PrivateConnectionRegistration {
  const item = exactSecretObject(value, ['id', 'service', 'accountId', 'generation', 'profileId', 'profilePath',
    'mode', 'dedicated', 'fullDiskEncryptionAcknowledged', 'secretReferences']);
  if (!Number.isSafeInteger(item.generation) || (item.generation as number) < 1 ||
      (item.mode !== 'synthetic' && item.mode !== 'live') || item.dedicated !== true ||
      typeof item.fullDiskEncryptionAcknowledged !== 'boolean' || !Array.isArray(item.secretReferences) ||
      typeof item.profilePath !== 'string' || !item.profilePath) fail();
  if (item.mode === 'live' && (platform !== 'darwin' || item.fullDiskEncryptionAcknowledged !== true)) fail();
  const id = secretIdentifier(item.id); const service = secretIdentifier(item.service);
  const accountId = secretIdentifier(item.accountId); const profileId = secretIdentifier(item.profileId);
  const secretReferences = item.secretReferences.map(reference => parseMetadata(reference));
  if (secretReferences.some(reference => reference.connectionId !== id || reference.service !== service ||
      reference.accountId !== accountId)) fail();
  return { id, service, accountId, generation: item.generation as number, profileId,
    profilePath: item.profilePath, mode: item.mode, dedicated: true,
    fullDiskEncryptionAcknowledged: item.fullDiskEncryptionAcknowledged, secretReferences };
}

function parseMetadata(value: unknown): SecretMetadata {
  const item = exactSecretObject(value,
    ['service', 'connectionId', 'purpose', 'accountId', 'reference', 'provider', 'createdAt']);
  const reference = parseSecretReference({ service: item.service, connectionId: item.connectionId,
    purpose: item.purpose, accountId: item.accountId, reference: item.reference });
  if ((item.provider !== 'synthetic' && item.provider !== 'keychain') || typeof item.createdAt !== 'string' ||
      Number.isNaN(Date.parse(item.createdAt))) fail();
  return { ...reference, provider: item.provider, createdAt: item.createdAt };
}

interface ProfileIdentity { path: string; device: string; inode: string }
type CustodyEvent =
  | { type: 'disconnect.started'; deletePurposes: string[] }
  | { type: 'connection.revoked' | 'browser.revoked' | 'brokers.revoked' | 'monitors.stopped' |
      'disconnect.completed' }
  | { type: 'secret.deleted'; purpose: string };
interface ProfileCustody { readonly custodyId: string; record(event: CustodyEvent): void; release(): void }
interface CustodyHeader {
  version: 1;
  custodyId: string;
  pid: number;
  profileDevice: string;
  profileInode: string;
  registrationDigest: string;
}
interface RecoveryClaim {
  version: 1;
  claimId: string;
  pid: number;
  custodyId: string;
  registrationDigest: string;
  sourceDirectoryIdentity: string;
  sourceStateIdentity: string;
  sourceDigest: string;
}

function validateProfile(path: string): ProfileIdentity {
  const resolved = resolve(path);
  if (resolved !== path || realpathSync(path) !== resolved) fail();
  const parts = resolved.split(sep).map(part => part.toLowerCase());
  if (parts.some(forbiddenProfilePart)) fail();
  for (let current = resolved; basename(current); current = dirname(current)) {
    if (basename(current) === '.git' || existsSync(join(current, '.git'))) fail();
    if (dirname(current) === current) break;
  }
  const stat = privateDirectoryStat(resolved);
  privateDirectoryStat(dirname(resolved));
  for (const chromeMarker of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    if (pathEntryExists(join(resolved, chromeMarker))) fail();
  }
  return { path: resolved, device: String(stat.dev), inode: String(stat.ino) };
}

function pathEntryExists(path: string): boolean {
  try { lstatSync(path); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function forbiddenProfilePart(part: string): boolean {
  return forbiddenPathParts.has(part) || /^(?:dropbox|onedrive|google drive|icloud drive)(?:\b|[\s_(-])/.test(part);
}

function acquireProfileCustody(profilePath: string, profileIdentity: ProfileIdentity, custodyId: string,
  digest: string, events: readonly CustodyEvent[] = []): ProfileCustody {
  const lockPath = `${profilePath}${CUSTODY_DIRECTORY_SUFFIX}`;
  const statePath = join(lockPath, CUSTODY_STATE);
  let created = false;
  try {
    mkdirSync(lockPath, { mode: 0o700 }); created = true; chmodSync(lockPath, 0o700);
    const header = custodyHeader(custodyId, profileIdentity, digest);
    writeFileSync(statePath, encodeCustodyState(header, events),
      { encoding: 'utf8', flag: 'wx', mode: 0o600, flush: true });
    validatePrivateCustodyFile(statePath);
    syncPrivateDirectory(lockPath);
    return profileCustody(lockPath, statePath, header, events);
  } catch {
    if (created) {
      try { unlinkSync(statePath); } catch { /* fixed error */ }
      try { rmdirSync(lockPath); } catch { /* fixed error */ }
    }
    fail();
  }
}

function custodyHeader(custodyId: string, profileIdentity: ProfileIdentity, digest: string): CustodyHeader {
  return { version: 1, custodyId, pid: process.pid, profileDevice: profileIdentity.device,
    profileInode: profileIdentity.inode, registrationDigest: digest };
}

function encodeCustodyState(header: CustodyHeader, events: readonly CustodyEvent[]): string {
  return [JSON.stringify(header), ...events.map(event => JSON.stringify(event))].join('\n') + '\n';
}

function validatePrivateCustodyFile(path: string, maximumLinks = 1n): BigIntStats {
  const stat = lstatSync(path, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink < 1n || stat.nlink > maximumLinks ||
      (typeof process.geteuid === 'function' && stat.uid !== BigInt(process.geteuid())) ||
      (stat.mode & 0o077n) !== 0n) fail();
  return stat;
}

function profileCustody(lockPath: string, statePath: string, header: CustodyHeader,
  initialEvents: readonly CustodyEvent[]): ProfileCustody {
  let released = false; let stateRemoved = false;
  const events = [...initialEvents];
  return {
    custodyId: header.custodyId,
    record(event: CustodyEvent): void {
      // One canonical owner writes checkpoints synchronously. Its exact fixed
      // stage name remains attributable even if it dies before writing a byte.
      const temporaryPath = checkpointStagePath(lockPath, header);
      try {
        writeFileSync(temporaryPath, encodeCustodyState(header, [...events, event]),
          { encoding: 'utf8', flag: 'wx', mode: 0o600, flush: true });
        validatePrivateCustodyFile(temporaryPath);
        renameSync(temporaryPath, statePath);
        syncPrivateDirectory(lockPath);
        events.push(event);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
          try { unlinkSync(temporaryPath); } catch { /* fixed checkpoint error */ }
        }
        fail();
      }
    },
    release(): void {
      if (released) return;
      try {
        if (stateRemoved && !pathEntryExists(lockPath)) {
          syncPrivateDirectory(dirname(lockPath)); released = true; return;
        }
        cleanupCustodyArtifacts(lockPath, header, process.pid);
        if (!stateRemoved) {
          const state = JSON.parse(readFileSync(statePath, 'utf8').split('\n', 1)[0]!) as { custodyId?: unknown };
          if (state.custodyId !== header.custodyId) fail();
          unlinkSync(statePath); stateRemoved = true;
        }
        rmdirSync(lockPath); syncPrivateDirectory(dirname(lockPath)); released = true;
      } catch { fail(); }
    }
  };
}

function syncPrivateDirectory(path: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    fsyncSync(descriptor);
  } finally { if (descriptor !== undefined) closeSync(descriptor); }
}

function registrationDigest(connection: PrivateConnectionRegistration, profile: ProfileIdentity): string {
  return createHash('sha256').update(JSON.stringify({ id: connection.id, service: connection.service,
    accountId: connection.accountId, generation: connection.generation, profileId: connection.profileId,
    profile, mode: connection.mode, references: connection.secretReferences })).digest('hex');
}

interface ParsedCustody {
  header: CustodyHeader;
  events: CustodyEvent[];
  progress: DisconnectProgress;
  directoryIdentity: string;
  stateIdentity: string;
  sourceDigest: string;
}

function custodyPaths(profilePath: string): { lockPath: string; statePath: string } {
  const lockPath = `${profilePath}${CUSTODY_DIRECTORY_SUFFIX}`;
  return { lockPath, statePath: join(lockPath, CUSTODY_STATE) };
}

function readCustody(profilePath: string): ParsedCustody {
  return readCustodyAt(custodyPaths(profilePath).lockPath);
}

function readCustodyAt(lockPath: string): ParsedCustody {
  const statePath = join(lockPath, CUSTODY_STATE);
  const directory = lstatSync(lockPath, { bigint: true });
  if (!directory.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o077n) !== 0n ||
      (typeof process.geteuid === 'function' && directory.uid !== BigInt(process.geteuid()))) fail();
  const { header, events, progress, file, sourceDigest } = readCustodyFile(statePath);
  return { header, events, progress,
    directoryIdentity: `${directory.dev}:${directory.ino}`, stateIdentity: `${file.dev}:${file.ino}`, sourceDigest };
}

function readCustodyFile(path: string): Pick<ParsedCustody, 'header' | 'events' | 'progress' | 'sourceDigest'> &
  { file: BigIntStats } {
  const file = validatePrivateCustodyFile(path);
  const source = readFileSync(path, 'utf8');
  if (!source.endsWith('\n')) fail();
  const lines = source.slice(0, -1).split('\n');
  if (lines.length < 1) fail();
  const header = parseCustodyHeader(lines[0]!);
  const events = lines.slice(1).map(line => parseCustodyEvent(JSON.parse(line)));
  return { header, events, progress: progressFromEvents(events), file,
    sourceDigest: createHash('sha256').update(source).digest('hex') };
}

function parseCustodyHeader(source: string): CustodyHeader {
  const header = JSON.parse(source) as Record<string, unknown>;
  const headerKeys = Object.keys(header).sort();
  if (headerKeys.join(',') !== 'custodyId,pid,profileDevice,profileInode,registrationDigest,version' ||
      header.version !== 1 || !Number.isSafeInteger(header.pid) || (header.pid as number) < 1 ||
      typeof header.custodyId !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(header.custodyId) ||
      typeof header.profileDevice !== 'string' || !/^\d+$/.test(header.profileDevice) ||
      typeof header.profileInode !== 'string' || !/^\d+$/.test(header.profileInode) ||
      typeof header.registrationDigest !== 'string' || !/^[a-f0-9]{64}$/.test(header.registrationDigest)) fail();
  return header as unknown as CustodyHeader;
}

function parseCustodyEvent(value: unknown): CustodyEvent {
  const item = exactSecretObject(value, ['type'], ['deletePurposes', 'purpose']);
  if (item.type === 'disconnect.started') {
    const exact = exactSecretObject(value, ['type', 'deletePurposes']);
    if (!Array.isArray(exact.deletePurposes) || exact.deletePurposes.some(part => typeof part !== 'string')) fail();
    const deletePurposes = exact.deletePurposes.map(secretIdentifier).sort();
    if (new Set(deletePurposes).size !== deletePurposes.length) fail();
    return { type: item.type, deletePurposes };
  }
  if (item.type === 'secret.deleted') {
    const exact = exactSecretObject(value, ['type', 'purpose']);
    return { type: item.type, purpose: secretIdentifier(exact.purpose) };
  }
  if (!['connection.revoked', 'browser.revoked', 'brokers.revoked', 'monitors.stopped',
    'disconnect.completed'].includes(String(item.type)) || Object.keys(item).length !== 1) fail();
  return { type: item.type as Exclude<CustodyEvent, { type: 'disconnect.started' | 'secret.deleted' }>['type'] };
}

function progressFromEvents(events: readonly CustodyEvent[]): DisconnectProgress {
  const progress = emptyProgress();
  for (const event of events) {
    if (event.type === 'disconnect.started') {
      if (progress.deletePurposes) fail(); progress.deletePurposes = [...event.deletePurposes];
    } else if (!progress.deletePurposes) fail();
    else if (event.type === 'connection.revoked' && !progress.connectionRevoked) progress.connectionRevoked = true;
    else if (event.type === 'browser.revoked' && progress.connectionRevoked && !progress.browserRevoked)
      progress.browserRevoked = true;
    else if (event.type === 'brokers.revoked' && progress.browserRevoked && !progress.brokersRevoked)
      progress.brokersRevoked = true;
    else if (event.type === 'monitors.stopped' && progress.brokersRevoked && !progress.monitorsStopped)
      progress.monitorsStopped = true;
    else if (event.type === 'secret.deleted' && progress.monitorsStopped &&
        progress.deletePurposes.includes(event.purpose) && !progress.deletedPurposes.has(event.purpose))
      progress.deletedPurposes.add(event.purpose);
    else if (event.type === 'disconnect.completed' && progress.monitorsStopped &&
        !progress.completed && progress.deletePurposes.every(purpose => progress.deletedPurposes.has(purpose)))
      progress.completed = true;
    else fail();
  }
  return progress;
}

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}

function recoverProfileCustody(profilePath: string, profileIdentity: ProfileIdentity, expectedCustodyId: string,
  digest: string): { custody: ProfileCustody; progress: DisconnectProgress } {
  const observed = readCustody(profilePath);
  validateRecoverableCustody(observed, profileIdentity, expectedCustodyId, digest);
  const { lockPath, statePath } = custodyPaths(profilePath);
  inspectCustodyArtifacts(lockPath, observed.header);
  const claimId = secretOwnerToken();
  const claimPath = join(lockPath, `${RECOVERY_CLAIM_PREFIX}${claimId}.json`);
  const claimStagePath = join(lockPath, `recovery-stage-${process.pid}-${claimId}.tmp`);
  const temporaryStatePath = join(lockPath, `owner-${claimId}.tmp`);
  const claim = recoveryClaim(claimId, observed, expectedCustodyId, digest);
  let electionPath: string | undefined;
  try {
    writeFileSync(claimStagePath, JSON.stringify(claim) + '\n',
      { encoding: 'utf8', flag: 'wx', mode: 0o600, flush: true });
    readRecoveryClaim(claimStagePath);
    renameSync(claimStagePath, claimPath); syncPrivateDirectory(lockPath);
    electionPath = electRecoveryClaim(lockPath, claimPath, claim, observed);
    const current = readCustody(profilePath);
    validateRecoverableCustody(current, profileIdentity, expectedCustodyId, digest);
    if (!sameCustodySnapshot(observed, current)) fail();
    // Only the elected replacement may remove exact dead-owner stages. Keep
    // every election/claim until publication so a competitor cannot re-elect
    // against a removed predecessor while this source is still authoritative.
    for (const entry of readdirSync(lockPath)) {
      if (!/^owner-[A-Za-z0-9_-]{43}\.tmp$/.test(entry)) continue;
      const stagePath = join(lockPath, entry);
      try {
        const staged = readOwnerStage(lockPath, stagePath, current.header);
        if (processAlive(staged.pid)) continue;
        if (!sameCustodySnapshot(current, readCustody(profilePath)) ||
            !ownsRecoveryElection(claimPath, electionPath, claim)) fail();
        unlinkSync(stagePath); syncPrivateDirectory(lockPath);
      } catch (error) { if (!pathMissing(error)) throw error; }
    }
    writeFileSync(temporaryStatePath,
      encodeCustodyState(custodyHeader(expectedCustodyId, profileIdentity, digest), current.events),
      { encoding: 'utf8', flag: 'wx', mode: 0o600, flush: true });
    validatePrivateCustodyFile(temporaryStatePath); syncPrivateDirectory(lockPath);
    const immediate = readCustody(profilePath);
    if (!sameCustodySnapshot(current, immediate) || !ownsRecoveryElection(claimPath, electionPath, claim)) fail();
    renameSync(temporaryStatePath, statePath);
    syncPrivateDirectory(lockPath);
    const header = custodyHeader(expectedCustodyId, profileIdentity, digest);
    cleanupCustodyArtifacts(lockPath, header, process.pid);
    return { custody: profileCustody(lockPath, statePath, header, current.events), progress: current.progress };
  } catch {
    try { unlinkSync(temporaryStatePath); } catch { /* fixed recovery error */ }
    try { unlinkSync(claimStagePath); } catch { /* fixed recovery error */ }
    if (electionPath && ownsRecoveryElection(claimPath, electionPath, claim)) {
      try { unlinkSync(electionPath); } catch { /* fixed recovery error */ }
    }
    try { unlinkSync(claimPath); } catch { /* fixed recovery error */ }
    fail();
  }
}

function recoveryClaim(claimId: string, source: ParsedCustody, custodyId: string,
  registrationDigestValue: string): RecoveryClaim {
  return { version: 1, claimId, pid: process.pid, custodyId, registrationDigest: registrationDigestValue,
    sourceDirectoryIdentity: source.directoryIdentity, sourceStateIdentity: source.stateIdentity,
    sourceDigest: source.sourceDigest };
}

function electRecoveryClaim(lockPath: string, claimPath: string, claim: RecoveryClaim,
  source: ParsedCustody): string {
  let predecessor = 'source';
  for (let attempt = 0; attempt < MAXIMUM_CUSTODY_ARTIFACTS; attempt++) {
    const key = createHash('sha256').update(JSON.stringify({ directory: source.directoryIdentity,
      state: source.stateIdentity, digest: source.sourceDigest, predecessor })).digest('hex');
    const electionPath = join(lockPath, `${RECOVERY_ELECTION_PREFIX}${key}.json`);
    try {
      linkSync(claimPath, electionPath); syncPrivateDirectory(lockPath);
      if (!ownsRecoveryElection(claimPath, electionPath, claim)) fail();
      return electionPath;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const existing = readRecoveryClaim(electionPath);
      if (!claimMatchesSnapshot(existing.claim, source) || existing.claim.custodyId !== claim.custodyId ||
          existing.claim.registrationDigest !== claim.registrationDigest || processAlive(existing.claim.pid)) fail();
      predecessor = `${existing.file.dev}:${existing.file.ino}:${existing.digest}`;
    }
  }
  fail();
}

function readRecoveryClaim(path: string): { claim: RecoveryClaim; file: BigIntStats; digest: string } {
  const file = validatePrivateCustodyFile(path, 2n);
  const source = readFileSync(path, 'utf8');
  if (!source.endsWith('\n')) fail();
  const item = exactSecretObject(JSON.parse(source), ['version', 'claimId', 'pid', 'custodyId',
    'registrationDigest', 'sourceDirectoryIdentity', 'sourceStateIdentity', 'sourceDigest']);
  if (item.version !== 1 || typeof item.claimId !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(item.claimId) ||
      !Number.isSafeInteger(item.pid) || (item.pid as number) < 1 || typeof item.custodyId !== 'string' ||
      !/^[A-Za-z0-9_-]{43}$/.test(item.custodyId) || typeof item.registrationDigest !== 'string' ||
      !/^[a-f0-9]{64}$/.test(item.registrationDigest) || typeof item.sourceDirectoryIdentity !== 'string' ||
      !/^\d+:\d+$/.test(item.sourceDirectoryIdentity) || typeof item.sourceStateIdentity !== 'string' ||
      !/^\d+:\d+$/.test(item.sourceStateIdentity) || typeof item.sourceDigest !== 'string' ||
      !/^[a-f0-9]{64}$/.test(item.sourceDigest)) fail();
  return { claim: item as unknown as RecoveryClaim, file,
    digest: createHash('sha256').update(source).digest('hex') };
}

function claimMatchesSnapshot(claim: RecoveryClaim, snapshot: ParsedCustody): boolean {
  return claim.sourceDirectoryIdentity === snapshot.directoryIdentity &&
    claim.sourceStateIdentity === snapshot.stateIdentity && claim.sourceDigest === snapshot.sourceDigest;
}

function validateRecoverableCustody(parsed: ParsedCustody, profileIdentity: ProfileIdentity,
  expectedCustodyId: string, digest: string): void {
  if (parsed.header.custodyId !== expectedCustodyId || parsed.header.registrationDigest !== digest ||
      parsed.header.profileDevice !== profileIdentity.device || parsed.header.profileInode !== profileIdentity.inode ||
      processAlive(parsed.header.pid)) fail();
}

function sameCustodySnapshot(left: ParsedCustody, right: ParsedCustody): boolean {
  return left.directoryIdentity === right.directoryIdentity && left.stateIdentity === right.stateIdentity &&
    left.sourceDigest === right.sourceDigest;
}

function ownsRecoveryElection(claimPath: string, electionPath: string, claim: RecoveryClaim): boolean {
  try {
    const claimFile = validatePrivateCustodyFile(claimPath, 2n);
    const electionFile = validatePrivateCustodyFile(electionPath, 2n);
    const current = readRecoveryClaim(electionPath).claim;
    return claimFile.dev === electionFile.dev && claimFile.ino === electionFile.ino &&
      current.claimId === claim.claimId && current.pid === process.pid &&
      current.custodyId === claim.custodyId && current.registrationDigest === claim.registrationDigest &&
      current.sourceDirectoryIdentity === claim.sourceDirectoryIdentity &&
      current.sourceStateIdentity === claim.sourceStateIdentity && current.sourceDigest === claim.sourceDigest;
  } catch { return false; }
}

function inspectCustodyArtifacts(lockPath: string, header: CustodyHeader): void {
  const entries = readdirSync(lockPath);
  if (entries.length > MAXIMUM_CUSTODY_ARTIFACTS) fail();
  for (const entry of entries) {
    if (entry === CUSTODY_STATE) continue;
    const path = join(lockPath, entry);
    try {
      if (/^owner-[A-Za-z0-9_-]{43}\.tmp$/.test(entry)) {
        readOwnerStage(lockPath, path, header);
        continue;
      }
      const recoveryStage = /^recovery-stage-(\d+)-[A-Za-z0-9_-]{43}\.tmp$/.exec(entry);
      if (recoveryStage) {
        validatePrivateCustodyFile(path);
        if (!Number.isSafeInteger(Number(recoveryStage[1])) || Number(recoveryStage[1]) < 1) fail();
        continue;
      }
      if (new RegExp(`^${RECOVERY_CLAIM_PREFIX}[A-Za-z0-9_-]{43}\\.json$`).test(entry) ||
          new RegExp(`^${RECOVERY_ELECTION_PREFIX}[a-f0-9]{64}\\.json$`).test(entry)) {
        const recovered = readRecoveryClaim(path).claim;
        if (recovered.custodyId !== header.custodyId ||
            recovered.registrationDigest !== header.registrationDigest) fail();
        continue;
      }
      fail();
    } catch (error) { if (!pathMissing(error)) throw error; }
  }
}

function cleanupCustodyArtifacts(lockPath: string, header: CustodyHeader, ownedPid: number | undefined): void {
  inspectCustodyArtifacts(lockPath, header);
  let removed = false;
  for (const entry of readdirSync(lockPath)) {
    if (entry === CUSTODY_STATE) continue;
    const path = join(lockPath, entry);
    try {
      if (/^owner-[A-Za-z0-9_-]{43}\.tmp$/.test(entry)) {
        const staged = readOwnerStage(lockPath, path, header);
        if (staged.pid === ownedPid || !processAlive(staged.pid)) {
          unlinkSync(path); removed = true;
        }
        continue;
      }
      const recoveryStage = /^recovery-stage-(\d+)-[A-Za-z0-9_-]{43}\.tmp$/.exec(entry);
      if (recoveryStage) {
        const stagePid = Number(recoveryStage[1]);
        validatePrivateCustodyFile(path);
        if (stagePid === ownedPid || !processAlive(stagePid)) { unlinkSync(path); removed = true; }
        continue;
      }
      const recovered = readRecoveryClaim(path).claim;
      if (recovered.pid === ownedPid || !processAlive(recovered.pid)) {
        unlinkSync(path); removed = true;
      }
    } catch (error) { if (!pathMissing(error)) throw error; }
  }
  if (removed) syncPrivateDirectory(lockPath);
}

function checkpointStagePath(lockPath: string, header: CustodyHeader): string {
  return join(lockPath, `owner-${header.custodyId}.tmp`);
}

function readOwnerStage(lockPath: string, path: string, header: CustodyHeader): CustodyHeader {
  if (path === checkpointStagePath(lockPath, header)) {
    validateCheckpointStage(path, header); return header;
  }
  const claimId = /^owner-([A-Za-z0-9_-]{43})\.tmp$/.exec(basename(path))?.[1];
  if (!claimId) fail();
  const claimPath = join(lockPath, `${RECOVERY_CLAIM_PREFIX}${claimId}.json`);
  if (pathEntryExists(claimPath)) {
    const { claim } = readRecoveryClaim(claimPath);
    const canonical = readCustodyAt(lockPath);
    if (claim.claimId !== claimId || claim.custodyId !== header.custodyId ||
        claim.registrationDigest !== header.registrationDigest ||
        !sameCustodyHeader(canonical.header, header) || !claimMatchesSnapshot(claim, canonical)) fail();
    const stagedHeader = { ...canonical.header, pid: claim.pid };
    validateCheckpointStage(path, stagedHeader); return stagedHeader;
  }
  // Legacy randomly named stages have no independent incomplete-write binding.
  // They require a complete exact header; a partial event tail is never used.
  validatePrivateCustodyFile(path);
  const source = readFileSync(path, 'utf8');
  const headerEnd = source.indexOf('\n');
  if (headerEnd < 0) fail();
  const staged = parseCustodyHeader(source.slice(0, headerEnd));
  if (!sameCustodyHeader(staged, header)) fail();
  return staged;
}

function validateCheckpointStage(path: string, header: CustodyHeader): void {
  privateDirectoryStat(dirname(path));
  validatePrivateCustodyFile(path);
  const source = readFileSync(path, 'utf8');
  const encodedHeader = JSON.stringify(header) + '\n';
  // The private directory, exact canonical-owner filename and single-link file
  // establish ownership independently of the uncommitted bytes. Any available
  // header bytes must agree, including PID; events are never replayed from here.
  if (!encodedHeader.startsWith(source) && !source.startsWith(encodedHeader)) fail();
}

function pathMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function sameCustodyHeader(left: ParsedCustody['header'], right: CustodyHeader): boolean {
  return left.version === right.version && left.custodyId === right.custodyId &&
    left.profileDevice === right.profileDevice && left.profileInode === right.profileInode &&
    left.registrationDigest === right.registrationDigest;
}

export function inspectPrivateProfileCustody(profilePath: string): PrivateProfileCustodyInspection | null {
  try {
    const resolved = resolve(profilePath);
    if (resolved !== profilePath || !existsSync(`${resolved}${CUSTODY_DIRECTORY_SUFFIX}`)) return null;
    const { header } = readCustody(resolved);
    return { custodyId: header.custodyId, pid: header.pid,
      profileDevice: header.profileDevice, profileInode: header.profileInode };
  } catch { throw new Error(CONNECTION_ERROR); }
}

function receiptPath(connection: Pick<PrivateConnectionRegistration, 'profilePath' | 'id' | 'generation'>): string {
  return `${connection.profilePath}.behalvo-disconnect-${connection.id}-${connection.generation}.json`;
}

function writeDisconnectReceipt(connection: StoredConnection): void {
  const value = { version: 1, custodyId: connection.custody.custodyId,
    registrationDigest: connection.registrationDigest, profileDevice: connection.profileIdentity.device,
    profileInode: connection.profileIdentity.inode, deletePurposes: connection.progress.deletePurposes ?? [],
    deletedPurposes: [...connection.progress.deletedPurposes].sort() };
  const path = receiptPath(connection);
  const encoded = JSON.stringify(value) + '\n';
  const temporaryPath = `${path}.tmp`;
  let ownsTemporary = false;
  try {
    if (!pathEntryExists(path)) {
      if (!pathEntryExists(temporaryPath)) {
        ownsTemporary = true;
        writeFileSync(temporaryPath, encoded, { encoding: 'utf8', flag: 'wx', mode: 0o600, flush: true });
      } else if (readFileSyncAfterPrivateValidation(temporaryPath) !== encoded) {
        // Only the exclusive canonical completed owner may discard this exact
        // unlinked receipt stage. A receipt never gains authority from a prefix.
        const current = readCustody(connection.profilePath);
        if (current.header.pid !== process.pid || current.header.custodyId !== connection.custody.custodyId ||
            current.header.registrationDigest !== connection.registrationDigest ||
            current.header.profileDevice !== connection.profileIdentity.device ||
            current.header.profileInode !== connection.profileIdentity.inode || !current.progress.completed ||
            !sameStrings(current.progress.deletePurposes ?? [], value.deletePurposes) ||
            !sameStrings([...current.progress.deletedPurposes].sort(), value.deletedPurposes)) fail();
        privateDirectoryStat(dirname(temporaryPath));
        if (!encoded.startsWith(readFileSyncAfterPrivateValidation(temporaryPath))) fail();
        unlinkSync(temporaryPath); syncPrivateDirectory(dirname(temporaryPath));
        ownsTemporary = true;
        writeFileSync(temporaryPath, encoded, { encoding: 'utf8', flag: 'wx', mode: 0o600, flush: true });
      }
      validateExactPrivateFile(temporaryPath, encoded, 2n);
      try { linkSync(temporaryPath, path); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    }
    reconcileReceiptLinks(path, temporaryPath, encoded);
    syncPrivateDirectory(dirname(path));
  } catch (error) {
    if (ownsTemporary && (error as NodeJS.ErrnoException).code !== 'EEXIST' && !pathEntryExists(path)) {
      try { unlinkSync(temporaryPath); } catch { /* fixed receipt error */ }
    }
    fail();
  }
  validateExactPrivateFile(path, encoded);
}

function readFileSyncAfterPrivateValidation(path: string): string {
  validatePrivateCustodyFile(path);
  return readFileSync(path, 'utf8');
}

function validateExactPrivateFile(path: string, encoded: string, maximumLinks = 1n): BigIntStats {
  const stat = validatePrivateCustodyFile(path, maximumLinks);
  if (readFileSync(path, 'utf8') !== encoded) fail();
  return stat;
}

function reconcileReceiptLinks(path: string, temporaryPath: string, encoded: string): void {
  const receipt = validateExactPrivateFile(path, encoded, 2n);
  if (pathEntryExists(temporaryPath)) {
    const temporary = validateExactPrivateFile(temporaryPath, encoded, 2n);
    if ((receipt.dev !== temporary.dev || receipt.ino !== temporary.ino) && receipt.nlink !== 1n) fail();
    unlinkSync(temporaryPath);
  }
  validateExactPrivateFile(path, encoded);
}

function recoverDisconnectReceipt(connection: PrivateConnectionRegistration, profileIdentity: ProfileIdentity,
  expectedCustodyId: string, digest: string): { custody: ProfileCustody; progress: DisconnectProgress } {
  const path = receiptPath(connection);
  validatePrivateCustodyFile(path, 2n);
  const source = readFileSync(path, 'utf8');
  const item = exactSecretObject(JSON.parse(source),
    ['version', 'custodyId', 'registrationDigest', 'profileDevice', 'profileInode', 'deletePurposes',
      'deletedPurposes']);
  if (item.version !== 1 || item.custodyId !== expectedCustodyId || item.registrationDigest !== digest ||
      item.profileDevice !== profileIdentity.device || item.profileInode !== profileIdentity.inode ||
      !Array.isArray(item.deletePurposes) || !Array.isArray(item.deletedPurposes)) fail();
  const deletePurposes = item.deletePurposes.map(secretIdentifier).sort();
  const deletedPurposes = item.deletedPurposes.map(secretIdentifier).sort();
  if (!sameStrings(deletePurposes, deletedPurposes)) fail();
  reconcileReceiptLinks(path, `${path}.tmp`, source);
  syncPrivateDirectory(dirname(path));
  const progress: DisconnectProgress = { deletePurposes, connectionRevoked: true, browserRevoked: true,
    brokersRevoked: true, monitorsStopped: true, deletedPurposes: new Set(deletedPurposes), completed: true };
  const custody: ProfileCustody = { custodyId: expectedCustodyId, record() { fail(); }, release() {} };
  return { custody, progress };
}

function finalizeOrphanedCustody(lockPath: string, header: CustodyHeader): void {
  privateDirectoryStat(lockPath);
  cleanupCustodyArtifacts(lockPath, header, undefined);
  if (readdirSync(lockPath).length !== 0) fail();
  rmdirSync(lockPath);
  syncPrivateDirectory(dirname(lockPath));
}

function privateDirectoryStat(path: string): BigIntStats {
  const stat = lstatSync(path, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink() ||
      (typeof process.geteuid === 'function' && stat.uid !== BigInt(process.geteuid())) ||
      (stat.mode & 0o077n) !== 0n) fail();
  return stat;
}

function summary(connection: StoredConnection): PrivateConnectionSummary {
  return { id: connection.id, service: connection.service, generation: connection.generation,
    profileId: connection.profileId, mode: connection.mode, state: connection.state,
    secretPurposes: connection.secretReferences.map(item => item.purpose).sort() };
}

export function exactSecretAccess(reference: SecretReference, allowed: readonly SecretMetadata[]): SecretReference {
  const checked = parseSecretReference(reference);
  if (!allowed.some(item => item.reference === checked.reference && item.service === checked.service &&
      item.connectionId === checked.connectionId && item.purpose === checked.purpose &&
      item.accountId === checked.accountId)) throw safeSecretError();
  return checked;
}
