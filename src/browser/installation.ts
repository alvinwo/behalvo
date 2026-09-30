import {
  chmodSync,
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync
} from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { acquireSyntheticProfileLease, inspectPrivateProfileCustody } from '../connections/private-connection.js';
import { createNativeHostManifest, NATIVE_HOST_NAME } from './native-manifest.js';

const INSTALLATION_ERROR = 'Chrome bridge installation operation failed.';
const METADATA_NAME = 'chrome-bridge-installation.json';
const LAUNCHER_NAME = 'chrome-bridge-native-host';
const PROFILE_NAME = 'chrome-profile';
const EXTENSION_NAME = 'extension';
const PROFILE_ID = 'synthetic-chrome';
const EXTENSION_FILES = [
  'manifest.json',
  'popup.html',
  'dist/background.js',
  'dist/content.js',
  'dist/popup.js',
  'dist/protocol.js'
] as const;

type ExtensionFile = typeof EXTENSION_FILES[number];

export interface ChromeBridgeStageInput {
  root: string;
  packageRoot: string;
  chromePath: string;
  nodePath: string;
  registrationDirectory: string;
}

export interface ChromeBridgeFinalizeInput {
  root: string;
  extensionId: string;
}

export interface ChromeBridgeDoctorInput { root: string }
export interface ChromeBridgeRemoveInput { root: string }

export interface ChromeBridgeInstallation {
  version: 1;
  installationId: string;
  root: string;
  packageRoot: string;
  chromePath: string;
  nodePath: string;
  brokerPath: string;
  profilePath: string;
  extensionPath: string;
  launcherPath: string;
  metadataPath: string;
  registrationDirectory: string;
  registrationPath: string;
  extensionId: string | null;
  profileDevice: string;
  profileInode: string;
  hashes: {
    chrome: string;
    node: string;
    broker: string;
    bundle?: string;
    launcher: string;
    extension: Record<ExtensionFile, string>;
    registration: string | null;
  };
}

export interface ChromeBridgeDoctorReport {
  configured: boolean;
  registered: boolean;
  handshakeObserved: false;
  issues: string[];
  installation: ChromeBridgeInstallation;
}

export interface ChromeBridgeRemovalResult {
  retainedPaths: string[];
}

export function stageChromeBridgeInstallation(input: ChromeBridgeStageInput): ChromeBridgeInstallation {
  try {
    const checked = parseStageInput(input);
    const paths = installationPaths(checked.root, checked.registrationDirectory);
    if (lstatSync(paths.metadataPath, { throwIfNoEntry: false })) {
      const metadata = loadMetadata(paths.metadataPath, checked.root);
      assertStageInputMatches(metadata, checked);
      assertSourceHashes(metadata);
      assertOwnedArtifacts(metadata, false);
      return publicInstallation(metadata);
    }

    for (const path of [paths.launcherPath, paths.profilePath, paths.extensionPath, paths.registrationPath])
      if (lstatSync(path, { throwIfNoEntry: false })) fail();

    const packageRoot = canonicalDirectory(checked.packageRoot, false);
    const chromePath = canonicalChromeExecutable(checked.chromePath);
    const nodePath = canonicalRegularFile(checked.nodePath, true);
    const brokerPath = canonicalRegularFile(join(packageRoot, 'dist', 'browser', 'native-broker.js'), false);
    const extensionSource = join(packageRoot, 'extension');
    const sourceHashes = extensionHashes(extensionSource);

    const installationId = randomUUID();
    mkdirOwned(paths.profilePath);
    const lease = acquireSyntheticProfileLease({
      installationId,
      profileId: PROFILE_ID,
      profilePath: paths.profilePath
    });
    const profileDevice = lease.profileDevice;
    const profileInode = lease.profileInode;
    lease.release();
    mkdirOwned(checked.registrationDirectory);

    mkdirOwned(paths.extensionPath);
    mkdirOwned(join(paths.extensionPath, 'dist'));
    for (const relative of EXTENSION_FILES) {
      const destination = join(paths.extensionPath, relative);
      copyFileSync(join(extensionSource, relative), destination, constants.COPYFILE_EXCL);
      chmodSync(destination, 0o600);
    }

    const launcher = launcherSource(nodePath, brokerPath, checked.root);
    writeFileSync(paths.launcherPath, launcher, { encoding: 'utf8', flag: 'wx', mode: 0o700 });
    chmodSync(paths.launcherPath, 0o700);

    const metadata: InstallationMetadata = {
      version: 1,
      installationId,
      root: checked.root,
      packageRoot,
      chromePath,
      nodePath,
      brokerPath,
      profilePath: paths.profilePath,
      extensionPath: paths.extensionPath,
      launcherPath: paths.launcherPath,
      metadataPath: paths.metadataPath,
      registrationDirectory: checked.registrationDirectory,
      registrationPath: paths.registrationPath,
      extensionId: null,
      profileDevice,
      profileInode,
      hashes: {
        chrome: fileDigest(chromePath),
        node: fileDigest(nodePath),
        broker: fileDigest(brokerPath),
        bundle: executableBundleDigest(packageRoot),
        launcher: digestBytes(Buffer.from(launcher, 'utf8')),
        extension: sourceHashes,
        registration: null
      }
    };
    writeFileSync(paths.metadataPath, encodeMetadata(metadata),
      { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    chmodSync(paths.metadataPath, 0o600);
    return publicInstallation(metadata);
  } catch {
    fail();
  }
}

export function finalizeChromeBridgeInstallation(input: ChromeBridgeFinalizeInput): ChromeBridgeInstallation {
  try {
    if (!input || typeof input !== 'object' || Array.isArray(input) ||
        Object.keys(input).sort().join(',') !== 'extensionId,root' ||
        typeof input.root !== 'string' || typeof input.extensionId !== 'string' ||
        !/^[a-p]{32}$/.test(input.extensionId)) fail();
    const root = canonicalDirectory(input.root, true);
    const metadataPath = join(root, METADATA_NAME);
    const metadata = loadMetadata(metadataPath, root);
    assertSourceHashes(metadata);
    assertOwnedArtifacts(metadata, false);
    canonicalDirectory(metadata.registrationDirectory, true);

    if (metadata.extensionId !== null && metadata.extensionId !== input.extensionId) fail();
    const manifest = JSON.stringify(createNativeHostManifest({
      executablePath: metadata.launcherPath,
      extensionId: input.extensionId
    }), null, 2) + '\n';

    if (existsSync(metadata.registrationPath)) {
      assertRegistrationFile(metadata.registrationPath);
      if (readFileSync(metadata.registrationPath, 'utf8') !== manifest) fail();
    } else {
      writeFileSync(metadata.registrationPath, manifest, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      chmodSync(metadata.registrationPath, 0o600);
    }

    const finalized: InstallationMetadata = {
      ...metadata,
      extensionId: input.extensionId,
      hashes: { ...metadata.hashes, registration: digestBytes(Buffer.from(manifest, 'utf8')) }
    };
    replaceMetadata(finalized);
    return publicInstallation(finalized);
  } catch {
    fail();
  }
}

export function doctorChromeBridgeInstallation(input: ChromeBridgeDoctorInput): ChromeBridgeDoctorReport {
  try {
    if (!input || typeof input !== 'object' || Array.isArray(input) ||
        Object.keys(input).join(',') !== 'root' || typeof input.root !== 'string') fail();
    const root = canonicalDirectory(input.root, true);
    const metadata = loadMetadata(join(root, METADATA_NAME), root);
    const issues: string[] = [];
    try { assertSourceHashes(metadata); } catch { issues.push('reviewed_source_changed'); }
    try { assertOwnedArtifacts(metadata, false); } catch { issues.push('staged_artifact_changed'); }

    let registered = false;
    if (metadata.extensionId !== null && metadata.hashes.registration !== null) {
      try {
        canonicalDirectory(metadata.registrationDirectory, true);
        assertRegistrationFile(metadata.registrationPath);
        const expected = expectedRegistration(metadata);
        registered = existsSync(metadata.registrationPath) &&
          readFileSync(metadata.registrationPath, 'utf8') === expected &&
          fileDigest(metadata.registrationPath) === metadata.hashes.registration;
        if (!registered) issues.push('native_host_registration_mismatch');
      } catch {
        issues.push('native_host_registration_mismatch');
      }
    } else {
      issues.push('extension_not_finalized');
    }
    return {
      configured: issues.length === 0 && metadata.extensionId !== null,
      registered,
      handshakeObserved: false,
      issues,
      installation: publicInstallation(metadata)
    };
  } catch {
    fail();
  }
}

export function removeChromeBridgeInstallation(input: ChromeBridgeRemoveInput): ChromeBridgeRemovalResult {
  try {
    if (!input || typeof input !== 'object' || Array.isArray(input) ||
        Object.keys(input).join(',') !== 'root' || typeof input.root !== 'string') fail();
    const root = canonicalDirectory(input.root, true);
    const metadata = loadMetadata(join(root, METADATA_NAME), root);

    assertOwnedArtifacts(metadata, true);
    assertProfileRetainedAndIdle(metadata);
    if (metadata.extensionId !== null) {
      assertRegistrationFile(metadata.registrationPath);
      const expected = expectedRegistration(metadata);
      if (!existsSync(metadata.registrationPath) ||
          readFileSync(metadata.registrationPath, 'utf8') !== expected ||
          fileDigest(metadata.registrationPath) !== metadata.hashes.registration) fail();
    } else if (existsSync(metadata.registrationPath)) fail();

    if (metadata.extensionId !== null) unlinkSync(metadata.registrationPath);
    for (const relative of EXTENSION_FILES) unlinkSync(join(metadata.extensionPath, relative));
    removeIfEmpty(join(metadata.extensionPath, 'dist'));
    removeIfEmpty(metadata.extensionPath);
    unlinkSync(metadata.launcherPath);
    unlinkSync(metadata.metadataPath);

    return { retainedPaths: listRetainedPaths(root) };
  } catch {
    fail();
  }
}

interface InstallationMetadata extends ChromeBridgeInstallation {}

function parseStageInput(input: unknown): ChromeBridgeStageInput {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail();
  const item = input as Record<string, unknown>;
  if (Object.keys(item).sort().join(',') !==
      'chromePath,nodePath,packageRoot,registrationDirectory,root') fail();
  for (const key of ['root', 'packageRoot', 'chromePath', 'nodePath', 'registrationDirectory'])
    if (typeof item[key] !== 'string' || (item[key] as string).length === 0) fail();
  const root = canonicalDirectory(item.root as string, true);
  const registrationDirectory = join(root, PROFILE_NAME, 'NativeMessagingHosts');
  if (item.registrationDirectory !== registrationDirectory) fail();
  return {
    root,
    packageRoot: canonicalDirectory(item.packageRoot as string, false),
    chromePath: canonicalChromeExecutable(item.chromePath as string),
    nodePath: canonicalRegularFile(item.nodePath as string, true),
    registrationDirectory
  };
}

function installationPaths(root: string, registrationDirectory: string) {
  return {
    metadataPath: join(root, METADATA_NAME),
    launcherPath: join(root, LAUNCHER_NAME),
    profilePath: join(root, PROFILE_NAME),
    extensionPath: join(root, EXTENSION_NAME),
    registrationPath: join(registrationDirectory, `${NATIVE_HOST_NAME}.json`)
  };
}

function canonicalDirectory(path: string, owned: boolean): string {
  if (typeof path !== 'string' || path.length === 0 || resolve(path) !== path) fail();
  const canonical = realpathSync(path);
  if (canonical !== path) fail();
  const stat = lstatSync(path, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail();
  if (owned) {
    if (typeof process.geteuid !== 'function' || stat.uid !== BigInt(process.geteuid()) ||
        (stat.mode & 0o077n) !== 0n) fail();
  }
  return canonical;
}

// macOS Chrome creates code-sign clones with hard-linked main executables.
// Only that external executable may have aliases; its canonical path and content
// digest remain pinned. Generated artifacts and other sources stay single-link.
function canonicalChromeExecutable(path: string): string {
  return canonicalRegularFile(path, true, process.platform === 'darwin');
}

function canonicalRegularFile(path: string, executable: boolean, allowHardLinks = false): string {
  if (typeof path !== 'string' || path.length === 0 || resolve(path) !== path || realpathSync(path) !== path) fail();
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || (!allowHardLinks && stat.nlink !== 1) || (executable && (stat.mode & 0o111) === 0)) fail();
  return path;
}

function mkdirOwned(path: string): void {
  mkdirSync(path, { mode: 0o700 });
  chmodSync(path, 0o700);
  canonicalDirectory(path, true);
}

function extensionHashes(extensionSource: string): Record<ExtensionFile, string> {
  canonicalDirectory(extensionSource, false);
  const result = {} as Record<ExtensionFile, string>;
  for (const relative of EXTENSION_FILES)
    result[relative] = fileDigest(canonicalRegularFile(join(extensionSource, relative), false));
  return result;
}

// Pin the compiled package, including transitive broker helpers and module metadata.
// A missing legacy bundle pin is readable for explicit removal, never runnable.
function executableBundleDigest(packageRoot: string): string {
  const files: Array<[string, string]> = [];
  const visit = (relative: string): void => {
    const directory = canonicalDirectory(join(packageRoot, relative), false);
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const child = join(relative, entry.name);
      if (entry.isDirectory()) visit(child);
      else if (entry.isSymbolicLink()) fail();
      else if (entry.name.endsWith('.js') || entry.name.endsWith('.json'))
        files.push([child, fileDigest(canonicalRegularFile(join(packageRoot, child), false))]);
    }
  };
  visit('dist');
  const manifest = join(packageRoot, 'package.json');
  if (lstatSync(manifest, { throwIfNoEntry: false }))
    files.push(['package.json', fileDigest(canonicalRegularFile(manifest, false))]);
  return digestBytes(Buffer.from(JSON.stringify(files), 'utf8'));
}

function fileDigest(path: string): string {
  return digestBytes(readFileSync(path));
}

function digestBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function launcherSource(nodePath: string, brokerPath: string, root: string): string {
  return `#!/bin/sh\nexec ${shellQuote(nodePath)} ${shellQuote(brokerPath)} --root ${shellQuote(root)} "$@"\n`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function encodeMetadata(metadata: InstallationMetadata): string {
  return JSON.stringify(metadata, null, 2) + '\n';
}

function replaceMetadata(metadata: InstallationMetadata): void {
  const temporary = `${metadata.metadataPath}.tmp`;
  if (existsSync(temporary)) fail();
  try {
    writeFileSync(temporary, encodeMetadata(metadata), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, metadata.metadataPath);
  } catch (error) {
    try { if (existsSync(temporary)) unlinkSync(temporary); } catch { /* fixed failure surface */ }
    throw error;
  }
}

function loadMetadata(path: string, expectedRoot: string): InstallationMetadata {
  const stat = lstatSync(path, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n ||
      typeof process.geteuid !== 'function' || stat.uid !== BigInt(process.geteuid()) ||
      (stat.mode & 0o077n) !== 0n) fail();
  const item = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  const expectedKeys = [
    'version', 'installationId', 'root', 'packageRoot', 'chromePath', 'nodePath', 'brokerPath',
    'profilePath', 'extensionPath', 'launcherPath', 'metadataPath', 'registrationDirectory',
    'registrationPath', 'extensionId', 'profileDevice', 'profileInode', 'hashes'
  ].sort().join(',');
  if (Object.keys(item).sort().join(',') !== expectedKeys || item.version !== 1 ||
      typeof item.installationId !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(item.installationId) ||
      item.root !== expectedRoot || item.metadataPath !== path ||
      typeof item.packageRoot !== 'string' || typeof item.chromePath !== 'string' ||
      typeof item.nodePath !== 'string' || typeof item.brokerPath !== 'string' ||
      typeof item.profilePath !== 'string' || typeof item.extensionPath !== 'string' ||
      typeof item.launcherPath !== 'string' || typeof item.registrationDirectory !== 'string' ||
      typeof item.registrationPath !== 'string' ||
      (item.extensionId !== null && (typeof item.extensionId !== 'string' || !/^[a-p]{32}$/.test(item.extensionId))) ||
      typeof item.profileDevice !== 'string' || !/^\d+$/.test(item.profileDevice) ||
      typeof item.profileInode !== 'string' || !/^\d+$/.test(item.profileInode) ||
      !item.hashes || typeof item.hashes !== 'object' || Array.isArray(item.hashes)) fail();

  if (item.registrationDirectory !== join(expectedRoot, PROFILE_NAME, 'NativeMessagingHosts')) fail();
  const paths = installationPaths(expectedRoot, item.registrationDirectory as string);
  if (item.profilePath !== paths.profilePath || item.extensionPath !== paths.extensionPath ||
      item.launcherPath !== paths.launcherPath || item.registrationPath !== paths.registrationPath) fail();

  const hashes = item.hashes as Record<string, unknown>;
  if (!['broker,chrome,extension,launcher,node,registration',
    'broker,bundle,chrome,extension,launcher,node,registration'].includes(Object.keys(hashes).sort().join(',')) ||
      (hashes.bundle !== undefined && !digestString(hashes.bundle)) ||
      !digestString(hashes.chrome) || !digestString(hashes.node) || !digestString(hashes.broker) ||
      !digestString(hashes.launcher) ||
      (hashes.registration !== null && !digestString(hashes.registration)) ||
      !hashes.extension || typeof hashes.extension !== 'object' || Array.isArray(hashes.extension)) fail();
  const extension = hashes.extension as Record<string, unknown>;
  if (Object.keys(extension).sort().join(',') !== [...EXTENSION_FILES].sort().join(',') ||
      EXTENSION_FILES.some(relative => !digestString(extension[relative]))) fail();
  return item as unknown as InstallationMetadata;
}

function digestString(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function assertStageInputMatches(metadata: InstallationMetadata, input: ChromeBridgeStageInput): void {
  if (metadata.root !== input.root || metadata.packageRoot !== input.packageRoot ||
      metadata.chromePath !== input.chromePath || metadata.nodePath !== input.nodePath ||
      metadata.registrationDirectory !== input.registrationDirectory) fail();
}

function assertSourceHashes(metadata: InstallationMetadata): void {
  if (canonicalDirectory(metadata.packageRoot, false) !== metadata.packageRoot ||
      canonicalChromeExecutable(metadata.chromePath) !== metadata.chromePath ||
      canonicalRegularFile(metadata.nodePath, true) !== metadata.nodePath ||
      canonicalRegularFile(metadata.brokerPath, false) !== metadata.brokerPath ||
      metadata.brokerPath !== join(metadata.packageRoot, 'dist', 'browser', 'native-broker.js') ||
      fileDigest(metadata.chromePath) !== metadata.hashes.chrome ||
      fileDigest(metadata.nodePath) !== metadata.hashes.node ||
      fileDigest(metadata.brokerPath) !== metadata.hashes.broker ||
      executableBundleDigest(metadata.packageRoot) !== metadata.hashes.bundle) fail();
  const source = extensionHashes(join(metadata.packageRoot, 'extension'));
  for (const relative of EXTENSION_FILES)
    if (source[relative] !== metadata.hashes.extension[relative]) fail();
}

function assertOwnedArtifacts(metadata: InstallationMetadata, forRemoval: boolean): void {
  const root = canonicalDirectory(metadata.root, true);
  if (canonicalDirectory(metadata.registrationDirectory, true) !== metadata.registrationDirectory) fail();
  if (root !== metadata.root || canonicalDirectory(metadata.profilePath, true) !== metadata.profilePath ||
      canonicalDirectory(metadata.extensionPath, true) !== metadata.extensionPath ||
      canonicalRegularFile(metadata.launcherPath, true) !== metadata.launcherPath ||
      fileDigest(metadata.launcherPath) !== metadata.hashes.launcher) fail();
  const profile = lstatSync(metadata.profilePath, { bigint: true });
  if (String(profile.dev) !== metadata.profileDevice || String(profile.ino) !== metadata.profileInode) fail();
  for (const relative of EXTENSION_FILES) {
    const path = canonicalRegularFile(join(metadata.extensionPath, relative), false);
    const stat = lstatSync(path);
    if ((stat.mode & 0o077) !== 0 || fileDigest(path) !== metadata.hashes.extension[relative]) fail();
  }
  if (!forRemoval && metadata.extensionId !== null && metadata.hashes.registration !== null) {
    assertRegistrationFile(metadata.registrationPath);
    const expected = expectedRegistration(metadata);
    if (!existsSync(metadata.registrationPath) ||
        readFileSync(metadata.registrationPath, 'utf8') !== expected ||
        fileDigest(metadata.registrationPath) !== metadata.hashes.registration) fail();
  }
}

function assertRegistrationFile(path: string): void {
  canonicalRegularFile(path, false);
  const stat = lstatSync(path);
  if (typeof process.geteuid !== 'function' || stat.uid !== process.geteuid() ||
      (stat.mode & 0o077) !== 0) fail();
}

function expectedRegistration(metadata: InstallationMetadata): string {
  if (metadata.extensionId === null) fail();
  return JSON.stringify(createNativeHostManifest({
    executablePath: metadata.launcherPath,
    extensionId: metadata.extensionId
  }), null, 2) + '\n';
}

function assertProfileRetainedAndIdle(metadata: InstallationMetadata): void {
  if (inspectPrivateProfileCustody(metadata.profilePath) !== null) fail();
  for (const marker of ['SingletonLock', 'SingletonCookie', 'SingletonSocket'])
    if (lstatSync(join(metadata.profilePath, marker), { throwIfNoEntry: false }) !== undefined) fail();
  const profile = lstatSync(metadata.profilePath, { bigint: true });
  if (!profile.isDirectory() || profile.isSymbolicLink() ||
      String(profile.dev) !== metadata.profileDevice || String(profile.ino) !== metadata.profileInode) fail();
}

function removeIfEmpty(path: string): void {
  if (!existsSync(path)) return;
  if (readdirSync(path).length === 0) rmdirSync(path);
}

function listRetainedPaths(root: string): string[] {
  const result: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name);
      result.push(path);
      if (entry.isDirectory() && !entry.isSymbolicLink()) visit(path);
    }
  };
  visit(root);
  return result;
}

function publicInstallation(metadata: InstallationMetadata): ChromeBridgeInstallation {
  return structuredClone(metadata);
}

function fail(): never {
  throw new Error(INSTALLATION_ERROR);
}
