import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  realpathSync,
  unlinkSync,
  writeSync
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { ensurePrivateDirectory } from './private-files.js';

const LOCK_ERROR = 'Local process lock unavailable.';

interface HeldLock {
  readonly dbPath: string;
  readonly lockPath: string;
  readonly device: bigint;
  readonly inode: bigint;
  readonly descriptor: number;
  references: number;
}

const heldLocks = new Map<string, HeldLock>();

export interface LocalProcessLock {
  readonly dbPath: string;
  release(): void;
}

function fail(): never {
  throw new Error(LOCK_ERROR);
}

function requirePosix(): void {
  if (process.platform === 'win32' || typeof process.geteuid !== 'function') fail();
}

function absent(path: string): boolean {
  try {
    lstatSync(path);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    throw error;
  }
}

function sameIdentity(path: string, held: Pick<HeldLock, 'device' | 'inode'>): boolean {
  try {
    const stat = lstatSync(path, { bigint: true });
    return stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1n &&
      stat.uid === BigInt(process.geteuid!()) && stat.dev === held.device && stat.ino === held.inode;
  } catch {
    return false;
  }
}

function validateExistingDatabase(path: string): void {
  if (absent(path)) return;
  const before = lstatSync(path, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.uid !== BigInt(process.geteuid!()) || before.nlink !== 1n) fail();
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = fstatSync(descriptor, { bigint: true });
    const after = lstatSync(path, { bigint: true });
    if (!opened.isFile() || opened.uid !== BigInt(process.geteuid!()) || opened.nlink !== 1n ||
      opened.dev !== before.dev || opened.ino !== before.ino ||
      after.dev !== opened.dev || after.ino !== opened.ino || !after.isFile() || after.isSymbolicLink()) fail();
  } finally {
    closeSync(descriptor);
  }
}

function canonicalDatabasePath(path: string): string {
  if (typeof path !== 'string' || path.length === 0 || basename(path) === '.' || basename(path) === '..') fail();
  const requestedParent = dirname(path);
  let parent: string;
  try {
    parent = realpathSync(requestedParent);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    ensurePrivateDirectory(requestedParent);
    parent = realpathSync(requestedParent);
  }
  ensurePrivateDirectory(parent);
  const parentStat = lstatSync(parent);
  if ((parentStat.mode & 0o300) !== 0o300) fail();
  const canonical = join(parent, basename(path));
  validateExistingDatabase(canonical);
  return canonical;
}

function handle(held: HeldLock): LocalProcessLock {
  let released = false;
  return {
    dbPath: held.dbPath,
    release(): void {
      if (released) return;
      released = true;
      const current = heldLocks.get(held.dbPath);
      if (current !== held) return;
      current.references--;
      if (current.references !== 0) return;
      heldLocks.delete(held.dbPath);
      if (sameIdentity(held.lockPath, held)) {
        try { unlinkSync(held.lockPath); } catch { /* Preserve the fixed release surface. */ }
      }
      try { closeSync(held.descriptor); } catch { /* Release is idempotent and best effort. */ }
    }
  };
}

export function acquireLocalProcessLock(dbPath: string): LocalProcessLock {
  if (dbPath === ':memory:') return { dbPath, release(): void {} };
  let descriptor: number | undefined;
  let created: { path: string; device: bigint; inode: bigint } | undefined;
  try {
    requirePosix();
    const canonical = canonicalDatabasePath(dbPath);
    const existing = heldLocks.get(canonical);
    if (existing) {
      if (!sameIdentity(existing.lockPath, existing)) fail();
      existing.references++;
      return handle(existing);
    }
    const lockPath = `${canonical}.behalvo-lock`;
    descriptor = openSync(lockPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600);
    const opened = fstatSync(descriptor, { bigint: true });
    created = { path: lockPath, device: opened.dev, inode: opened.ino };
    if (!opened.isFile() || opened.uid !== BigInt(process.geteuid!()) || opened.nlink !== 1n) fail();
    fchmodSync(descriptor, 0o600);
    const identity = fstatSync(descriptor, { bigint: true });
    if (!identity.isFile() || identity.uid !== BigInt(process.geteuid!()) || identity.nlink !== 1n ||
      identity.dev !== opened.dev || identity.ino !== opened.ino || (identity.mode & 0o777n) !== 0o600n) fail();
    const instanceId = randomUUID();
    writeSync(descriptor, JSON.stringify({ version: 1, pid: process.pid, instanceId }) + '\n', undefined, 'utf8');
    fsyncSync(descriptor);
    const held: HeldLock = { dbPath: canonical, lockPath,
      device: identity.dev, inode: identity.ino, descriptor, references: 1 };
    heldLocks.set(canonical, held);
    descriptor = undefined;
    return handle(held);
  } catch {
    if (created && sameIdentity(created.path, created)) {
      try { unlinkSync(created.path); } catch { /* Use the fixed error below. */ }
    }
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch { /* Use the fixed error below. */ }
    }
    fail();
  }
}
