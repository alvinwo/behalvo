import { resolve } from 'node:path';
import { lstatSync } from 'node:fs';
import { identifier } from '../kernel/types.js';
import type { ModelGateway, ModelRef } from '../model/types.js';
import type { ControlAssets } from '../control/http-server.js';
import type { ModelStateProtectionOptions } from '../storage/model-state-codec.js';
import { assertModelStatePathSeparation } from '../cli/model-state-config.js';
import { resolveModelStatePath } from '../storage/private-model-state-file.js';

export interface LocalServiceOptions {
  dbPath: string;
  bootstrapDirectory: string;
  workspaceId: string;
  ownerId: string;
  assets: ControlAssets;
  gateways?: readonly ModelGateway[];
  model?: ModelRef;
  syntheticOperations?: boolean;
  upgradeStorage: boolean;
  port?: number;
  encryptionKey?: Uint8Array;
  modelStateProtection?: ModelStateProtectionOptions;
  modelStateKeyPath?: string;
  authPath?: string;
  settingsPath?: string;
  storageKeyPath?: string;
  clock?: () => number;
}

function invalid(): never {
  throw new Error('Invalid local service configuration.');
}

interface PathEntry { path: string; identity?: string }

function pathEntry(path: string): PathEntry {
  try {
    const canonical = resolveModelStatePath(path);
    try {
      const stat = lstatSync(canonical, { bigint: true });
      return { path: canonical, identity: `${stat.dev}:${stat.ino}` };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { path: canonical };
      throw error;
    }
  } catch { invalid(); }
}

function aliases(left: PathEntry, right: PathEntry): boolean {
  return left.path === right.path ||
    (left.identity !== undefined && right.identity !== undefined && left.identity === right.identity);
}

function assertPathSeparation(options: LocalServiceOptions): void {
  if ((options.authPath === undefined) !== (options.settingsPath === undefined)) invalid();
  const data = [options.authPath, options.settingsPath]
    .filter((path): path is string => path !== undefined).map(pathEntry);
  const locks = data.map(entry => pathEntry(`${entry.path}.behalvo-model-state-lock`));
  const databasePaths = [options.dbPath, `${options.dbPath}-wal`, `${options.dbPath}-shm`,
    `${options.dbPath}-journal`, `${options.dbPath}.behalvo-lock`];
  if (options.syntheticOperations) {
    const synthetic = `${options.dbPath}.synthetic.sqlite`;
    databasePaths.push(synthetic, `${synthetic}-wal`, `${synthetic}-shm`, `${synthetic}-journal`);
  }
  const reserved = [...databasePaths.map(pathEntry), pathEntry(options.bootstrapDirectory)];
  const ordinary = [...data, ...locks, ...reserved];
  for (let left = 0; left < ordinary.length; left++) {
    for (let right = left + 1; right < ordinary.length; right++) {
      if (aliases(ordinary[left]!, ordinary[right]!)) invalid();
    }
  }
  const keys = [options.modelStateKeyPath, options.storageKeyPath]
    .filter((path): path is string => path !== undefined).map(pathEntry);
  if (keys.some(key => ordinary.some(candidate => aliases(key, candidate)))) invalid();
}

export function validateLocalServiceOptions(options: LocalServiceOptions): LocalServiceOptions {
  if (process.platform === 'win32' || typeof process.geteuid !== 'function' || !options ||
    typeof options !== 'object' || options.dbPath === ':memory:' || typeof options.dbPath !== 'string' ||
    typeof options.bootstrapDirectory !== 'string' || !options.bootstrapDirectory ||
    typeof options.upgradeStorage !== 'boolean' || !options.assets || typeof options.assets.html !== 'string' ||
    typeof options.assets.javascript !== 'string' || typeof options.assets.css !== 'string' ||
    (options.port !== undefined && (!Number.isSafeInteger(options.port) || options.port < 0 || options.port > 65_535)) ||
    (options.gateways !== undefined && !Array.isArray(options.gateways))) invalid();
  try { identifier(options.workspaceId, 'workspaceId'); identifier(options.ownerId, 'ownerId'); }
  catch { invalid(); }
  if (options.syntheticOperations === true && options.encryptionKey !== undefined)
    throw new Error('Encrypted storage cannot use persistent synthetic operations.');
  if (resolve(options.dbPath) === resolve(options.bootstrapDirectory)) invalid();
  assertPathSeparation(options);
  if (options.modelStateKeyPath !== undefined) {
    if (!options.authPath || !options.settingsPath) invalid();
    assertModelStatePathSeparation({
      modelStateKeyPath: options.modelStateKeyPath,
      authPath: options.authPath,
      settingsPath: options.settingsPath,
      dbPath: options.dbPath,
      ...(options.storageKeyPath ? { storageKeyPath: options.storageKeyPath } : {}),
      syntheticOperations: options.syntheticOperations === true
    });
  }
  return options;
}
