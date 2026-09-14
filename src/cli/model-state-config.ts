import { lstatSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  ModelStateError,
  type ModelStateProtectionOptions
} from '../storage/model-state-codec.js';
import { resolveModelStatePath } from '../storage/private-model-state-file.js';
import { loadStorageKeyFile } from '../storage/key-file.js';

export interface ModelStatePathConfiguration {
  modelStateKeyPath: string;
  authPath: string;
  settingsPath?: string;
  dbPath?: string;
  storageKeyPath?: string;
  syntheticOperations?: boolean;
}

interface CanonicalEntry {
  path: string;
  identity?: string;
}

function configurationError(): never {
  throw new ModelStateError('configuration');
}

function canonicalEntry(path: string): CanonicalEntry {
  const canonical = resolveModelStatePath(path);
  try {
    const stat = lstatSync(canonical, { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n) configurationError();
    return { path: canonical, identity: `${stat.dev}:${stat.ino}` };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { path: canonical };
    if (error instanceof ModelStateError) throw error;
    configurationError();
  }
}

function rejectOverlap(groups: readonly (readonly CanonicalEntry[])[]): void {
  const paths = new Set<string>();
  const identities = new Set<string>();
  for (const group of groups) {
    for (const entry of group) {
      if (paths.has(entry.path) || (entry.identity !== undefined && identities.has(entry.identity)))
        configurationError();
      paths.add(entry.path);
      if (entry.identity !== undefined) identities.add(entry.identity);
    }
  }
}

function overlaps(entry: CanonicalEntry, group: readonly CanonicalEntry[]): boolean {
  return group.some(candidate => candidate.path === entry.path ||
    (entry.identity !== undefined && candidate.identity === entry.identity));
}

export function resolveModelStateKeyPath(
  explicitValue: string | undefined,
  environmentValue: string | undefined,
  cwd: string,
  enabled: boolean
): string | undefined {
  if (!enabled) {
    if (explicitValue !== undefined) configurationError();
    return undefined;
  }
  const configured = explicitValue ?? environmentValue;
  if (configured === undefined) return undefined;
  if (configured.length === 0) configurationError();
  try {
    return resolveModelStatePath(resolve(cwd, configured));
  } catch {
    configurationError();
  }
}

export function assertModelStatePathSeparation(
  config: Readonly<ModelStatePathConfiguration>
): void {
  try {
    const data = [config.authPath,
      ...(config.settingsPath === undefined ? [] : [config.settingsPath])].map(canonicalEntry);
    const locks = data.map(entry => canonicalEntry(`${entry.path}.behalvo-model-state-lock`));
    const keys = [config.modelStateKeyPath,
      ...(config.storageKeyPath === undefined ? [] : [config.storageKeyPath])].map(canonicalEntry);
    const reservedPaths = config.dbPath === undefined ? [] : [
      config.dbPath,
      `${config.dbPath}-wal`,
      `${config.dbPath}-shm`,
      `${config.dbPath}-journal`,
      `${config.dbPath}.behalvo-lock`
    ];
    if (config.dbPath !== undefined && config.syntheticOperations === true) {
      const synthetic = `${config.dbPath}.synthetic.sqlite`;
      reservedPaths.push(synthetic, `${synthetic}-wal`, `${synthetic}-shm`, `${synthetic}-journal`);
    }
    const reserved = reservedPaths.map(canonicalEntry);
    rejectOverlap([data, locks, reserved]);
    const forbiddenForKeys = [...data, ...locks, ...reserved];
    if (keys.some(key => overlaps(key, forbiddenForKeys))) configurationError();
  } catch (error) {
    if (error instanceof ModelStateError && error.code === 'configuration') throw error;
    configurationError();
  }
}

export function loadModelStateProtection(
  config: Readonly<ModelStatePathConfiguration>
): ModelStateProtectionOptions {
  try {
    return { encryptionKey: loadStorageKeyFile(config.modelStateKeyPath) };
  } catch {
    throw new ModelStateError('key');
  }
}
