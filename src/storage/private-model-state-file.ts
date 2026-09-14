import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  openSync,
  realpathSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeSync
} from 'node:fs';
import { basename, dirname, isAbsolute, join, parse, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  MODEL_STATE_LIMITS,
  ModelStateCodec,
  ModelStateError,
  copyModelStateKey,
  type ModelStateOperationOptions,
  type ModelStatePreflightOptions,
  type ModelStatePurpose
} from './model-state-codec.js';
import { ensurePrivateDirectory, readPrivateFileSnapshot } from './private-files.js';

export interface ModelStateFileSchema<T> {
  empty(): T;
  validate(value: unknown): asserts value is T;
}

export interface ModelStateFileUpdate<T, R> {
  next: T | undefined;
  result: R;
}

interface Identity { device: bigint; inode: bigint }
interface Loaded<T> {
  value: T;
  documentId?: string;
  parent: Identity;
  target?: Identity;
}
interface OwnedLock extends Identity { descriptor: number; path: string }
interface Stage extends Identity { path: string; payloadPath: string; payload?: Identity }

function absent(path: string): boolean {
  try {
    lstatSync(path);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    throw error;
  }
}

function requirePosix(code: 'configuration' | 'unavailable' | 'update' = 'unavailable'): void {
  if (process.platform === 'win32' || typeof process.geteuid !== 'function')
    throw new ModelStateError(code);
}

function statDirectory(path: string, writable: boolean): Identity {
  const stat = lstatSync(path, { bigint: true });
  const mode = stat.mode & 0o777n;
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== BigInt(process.geteuid!()) ||
      (mode & 0o077n) !== 0n || (writable && (mode & 0o300n) !== 0o300n))
    throw new Error('unsafe directory');
  return { device: stat.dev, inode: stat.ino };
}

function sameIdentity(path: string, identity: Identity, kind: 'file' | 'directory', writable = true): boolean {
  try {
    const stat = lstatSync(path, { bigint: true });
    const correctKind = kind === 'file' ? stat.isFile() && stat.nlink === 1n : stat.isDirectory();
    const mode = stat.mode & 0o7777n;
    const validMode = kind === 'file'
      ? (writable ? mode === 0o600n : mode === 0o400n || mode === 0o600n)
      : (mode & 0o077n) === 0n;
    return correctKind && !stat.isSymbolicLink() && stat.uid === BigInt(process.geteuid!()) && validMode &&
      stat.dev === identity.device && stat.ino === identity.inode;
  } catch {
    return false;
  }
}

function sameOwnedPayload(path: string, identity: Identity): boolean {
  try {
    const stat = lstatSync(path, { bigint: true });
    return stat.isFile() && !stat.isSymbolicLink() && stat.uid === BigInt(process.geteuid!()) &&
      (stat.mode & 0o7777n) === 0o600n && (stat.nlink === 1n || stat.nlink === 2n) &&
      stat.dev === identity.device && stat.ino === identity.inode;
  } catch {
    return false;
  }
}

function sameOwnedStageDirectory(path: string, identity: Identity): boolean {
  try {
    const stat = lstatSync(path, { bigint: true });
    return stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === BigInt(process.geteuid!()) &&
      (stat.mode & 0o7777n) === 0o700n && stat.dev === identity.device && stat.ino === identity.inode;
  } catch {
    return false;
  }
}

function writeAll(descriptor: number, bytes: Buffer): void {
  let written = 0;
  while (written < bytes.byteLength) {
    const count = writeSync(descriptor, bytes, written, bytes.byteLength - written, null);
    if (count === 0) throw new Error('short write');
    written += count;
  }
}

function fsyncDirectory(path: string, expected: Identity): void {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(descriptor, { bigint: true });
    if (!stat.isDirectory() || stat.uid !== BigInt(process.geteuid!()) || (stat.mode & 0o077n) !== 0n ||
        stat.dev !== expected.device || stat.ino !== expected.inode)
      throw new Error('replaced directory');
    fsyncSync(descriptor);
  } finally { closeSync(descriptor); }
}

function safeEmpty<T>(schema: ModelStateFileSchema<T>): T {
  const value: unknown = schema.empty();
  schema.validate(value);
  return value;
}

function validateSchema<T>(schema: ModelStateFileSchema<T>): void {
  if (!schema || typeof schema !== 'object' || typeof schema.empty !== 'function' || typeof schema.validate !== 'function')
    throw new ModelStateError('configuration');
}

export function resolveModelStatePath(path: string): string {
  try {
    if (typeof path !== 'string' || path.length === 0 || path.includes('\0')) throw new Error('invalid path');
    if (basename(path) === '.' || basename(path) === '..') throw new Error('invalid path');
    const absolute = isAbsolute(path) ? resolve(path) : resolve(process.cwd(), path);
    if (absolute === parse(absolute).root || basename(absolute) === '.' || basename(absolute) === '..')
      throw new Error('invalid path');
    const requestedParent = dirname(absolute);
    try {
      const immediate = lstatSync(requestedParent);
      if (immediate.isSymbolicLink()) throw new Error('symlink parent');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const suffix: string[] = [];
    let existing = requestedParent;
    while (true) {
      try {
        lstatSync(existing);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        const parent = dirname(existing);
        if (parent === existing) throw error;
        suffix.unshift(basename(existing));
        existing = parent;
      }
    }
    const canonicalAncestor = realpathSync(existing);
    if (!lstatSync(canonicalAncestor).isDirectory()) throw new Error('invalid ancestor');
    return join(canonicalAncestor, ...suffix, basename(absolute));
  } catch (error) {
    if (error instanceof ModelStateError) throw error;
    throw new ModelStateError('configuration');
  }
}

export class PrivateModelStateFile<T> {
  readonly #path: string;
  readonly #lockPath: string;
  readonly #codec: ModelStateCodec;
  readonly #schema: ModelStateFileSchema<T>;
  #observed = false;

  constructor(path: string, purpose: ModelStatePurpose, key: Uint8Array, schema: ModelStateFileSchema<T>) {
    validateSchema(schema);
    this.#path = resolveModelStatePath(path);
    this.#lockPath = `${this.#path}.behalvo-model-state-lock`;
    this.#codec = new ModelStateCodec(copyModelStateKey(key), purpose);
    this.#schema = schema;
  }

  async preflight(options: ModelStatePreflightOptions = {}): Promise<void> {
    this.#throwIfCancelledBeforeCallback(options.signal);
    try {
      requirePosix();
      ensurePrivateDirectory(dirname(this.#path));
      statDirectory(dirname(this.#path), options.writable === true);
      if (absent(this.#path)) {
        if (!absent(this.#lockPath) || this.#observed) throw new Error('missing state');
        safeEmpty(this.#schema);
        return;
      }
      this.#loadExisting(options.writable !== true);
    } catch (error) {
      if (error instanceof ModelStateError && error.code === 'cancelled') throw error;
      throw new ModelStateError('unavailable');
    }
  }

  async read(options: ModelStateOperationOptions = {}): Promise<T> {
    this.#throwIfCancelledBeforeCallback(options.signal);
    try {
      requirePosix();
      ensurePrivateDirectory(dirname(this.#path));
      statDirectory(dirname(this.#path), false);
      if (absent(this.#path)) {
        if (this.#observed || !absent(this.#lockPath)) throw new Error('missing state');
        return safeEmpty(this.#schema);
      }
      return this.#loadExisting(true).value;
    } catch (error) {
      if (error instanceof ModelStateError && error.code === 'cancelled') throw error;
      throw new ModelStateError('unavailable');
    }
  }

  async update<R>(
    change: (current: T) => Promise<ModelStateFileUpdate<T, R>>,
    options: ModelStateOperationOptions = {}
  ): Promise<R> {
    if (typeof change !== 'function') throw new ModelStateError('configuration');
    const lock = await this.#acquireLock(options.signal);
    let completed = false;
    try {
      const snapshot = this.#loadValidatedSnapshotUnderOwnedLock(lock);
      this.#throwIfCancelledBeforeCallback(options.signal);
      const changed = await change(snapshot.value);
      let next: T | undefined;
      let result: R;
      try {
        if (!changed || typeof changed !== 'object' || !Object.prototype.hasOwnProperty.call(changed, 'next') ||
            !Object.prototype.hasOwnProperty.call(changed, 'result'))
          throw new Error('invalid update');
        next = changed.next;
        result = changed.result;
      } catch {
        throw new ModelStateError('update');
      }
      if (next !== undefined) {
        let bytes: Buffer;
        try {
          this.#schema.validate(next);
          const plaintext = JSON.stringify(next);
          if (typeof plaintext !== 'string') throw new Error('not JSON');
          bytes = this.#codec.seal(plaintext, snapshot.documentId).bytes;
        } catch {
          throw new ModelStateError('update');
        }
        this.#publishCiphertextWithOwnedIdentities(bytes, snapshot, lock);
        this.#observed = true;
      }
      completed = true;
      return result;
    } finally {
      const released = this.#releaseLock(lock);
      if (completed && !released) throw new ModelStateError('update');
    }
  }

  #loadExisting(readOnly: boolean): Loaded<T> {
    const snapshot = readPrivateFileSnapshot(this.#path, MODEL_STATE_LIMITS.outerBytes, { readOnly });
    const decoded = this.#codec.open(snapshot.bytes);
    const value: unknown = JSON.parse(decoded.plaintext);
    this.#schema.validate(value);
    this.#observed = true;
    return {
      value,
      documentId: decoded.documentId,
      parent: statDirectory(dirname(this.#path), !readOnly),
      target: { device: snapshot.device, inode: snapshot.inode }
    };
  }

  #loadValidatedSnapshotUnderOwnedLock(lock: OwnedLock): Loaded<T> {
    try {
      if (!sameIdentity(lock.path, lock, 'file')) throw new Error('replaced lock');
      const parent = statDirectory(dirname(this.#path), true);
      if (absent(this.#path)) {
        if (this.#observed) throw new Error('missing state');
        return { value: safeEmpty(this.#schema), parent };
      }
      return this.#loadExisting(false);
    } catch {
      throw new ModelStateError('unavailable');
    }
  }

  #throwIfCancelledBeforeCallback(signal?: AbortSignal): void {
    if (signal?.aborted) throw new ModelStateError('cancelled');
  }

  async #acquireLock(signal?: AbortSignal): Promise<OwnedLock> {
    this.#throwIfCancelledBeforeCallback(signal);
    try {
      requirePosix();
      ensurePrivateDirectory(dirname(this.#path));
      statDirectory(dirname(this.#path), true);
    } catch {
      throw new ModelStateError('unavailable');
    }
    const started = performance.now();
    while (true) {
      this.#throwIfCancelledBeforeCallback(signal);
      let descriptor: number | undefined;
      let identity: Identity | undefined;
      try {
        descriptor = openSync(this.#lockPath,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_NONBLOCK,
          0o600);
        const opened = fstatSync(descriptor, { bigint: true });
        identity = { device: opened.dev, inode: opened.ino };
        fchmodSync(descriptor, 0o600);
        const checked = fstatSync(descriptor, { bigint: true });
        if (!checked.isFile() || checked.uid !== BigInt(process.geteuid!()) || checked.nlink !== 1n ||
            (checked.mode & 0o7777n) !== 0o600n || checked.dev !== identity.device || checked.ino !== identity.inode)
          throw new Error('unsafe lock');
        const metadata = Buffer.from(JSON.stringify({ version: 1, pid: process.pid, instanceId: randomUUID() }) + '\n');
        writeAll(descriptor, metadata);
        fsyncSync(descriptor);
        return { descriptor, path: this.#lockPath, ...identity };
      } catch (error) {
        if (descriptor !== undefined) {
          if (identity && sameIdentity(this.#lockPath, identity, 'file')) {
            try { unlinkSync(this.#lockPath); } catch { /* fixed error below */ }
          }
          try { closeSync(descriptor); } catch { /* fixed error below */ }
        }
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST')
          throw new ModelStateError('busy');
        try {
          readPrivateFileSnapshot(this.#lockPath, 4096, { readOnly: false });
        } catch {
          let disappeared = false;
          try { disappeared = absent(this.#lockPath); } catch { /* Treat uncertain identity as busy. */ }
          if (!disappeared) throw new ModelStateError('busy');
        }
      }
      const elapsed = performance.now() - started;
      if (elapsed >= MODEL_STATE_LIMITS.lockWaitMs) throw new ModelStateError('busy');
      await this.#wait(Math.min(MODEL_STATE_LIMITS.lockPollMs, MODEL_STATE_LIMITS.lockWaitMs - elapsed), signal);
    }
  }

  async #wait(milliseconds: number, signal?: AbortSignal): Promise<void> {
    await new Promise<void>((resolveWait, reject) => {
      const timer = setTimeout(done, milliseconds);
      const onAbort = (): void => done(new ModelStateError('cancelled'));
      function done(error?: Error): void {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        if (error) reject(error); else resolveWait();
      }
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort();
    });
  }

  #publishCiphertextWithOwnedIdentities(bytes: Buffer, snapshot: Loaded<T>, lock: OwnedLock): void {
    let stage: Stage | undefined;
    let failed = false;
    try {
      if (!sameIdentity(dirname(this.#path), snapshot.parent, 'directory') ||
          !sameIdentity(lock.path, lock, 'file')) throw new Error('replaced identity');
      if (snapshot.target) {
        if (!sameIdentity(this.#path, snapshot.target, 'file')) throw new Error('replaced target');
      } else if (!absent(this.#path)) throw new Error('created target');

      const stagePath = mkdtempSync(join(dirname(this.#path), '.behalvo-model-state-stage-'));
      const stageStat = lstatSync(stagePath, { bigint: true });
      stage = { path: stagePath, payloadPath: join(stagePath, 'payload'),
        device: stageStat.dev, inode: stageStat.ino };
      chmodSync(stagePath, 0o700);
      if (!sameOwnedStageDirectory(stage.path, stage)) throw new Error('unsafe stage');
      const descriptor = openSync(stage.payloadPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600);
      try {
        fchmodSync(descriptor, 0o600);
        const payloadStat = fstatSync(descriptor, { bigint: true });
        stage.payload = { device: payloadStat.dev, inode: payloadStat.ino };
        if (!payloadStat.isFile() || payloadStat.uid !== BigInt(process.geteuid!()) || payloadStat.nlink !== 1n ||
            (payloadStat.mode & 0o7777n) !== 0o600n)
          throw new Error('unsafe staged payload');
        writeAll(descriptor, bytes);
        fsyncSync(descriptor);
      } finally { closeSync(descriptor); }
      fsyncDirectory(stage.path, stage);

      if (!sameIdentity(dirname(this.#path), snapshot.parent, 'directory') ||
          !sameIdentity(lock.path, lock, 'file')) throw new Error('replaced identity');
      if (!sameOwnedStageDirectory(stage.path, stage) || !stage.payload ||
          !sameIdentity(stage.payloadPath, stage.payload, 'file'))
        throw new Error('replaced stage');
      if (snapshot.target) {
        if (!sameIdentity(this.#path, snapshot.target, 'file')) throw new Error('replaced target');
        renameSync(stage.payloadPath, this.#path);
        this.#observed = true;
        if (!stage.payload || !sameIdentity(this.#path, stage.payload, 'file'))
          throw new Error('replaced publication');
        delete stage.payload;
      } else {
        if (!absent(this.#path)) throw new Error('created target');
        linkSync(stage.payloadPath, this.#path);
        this.#observed = true;
        if (!stage.payload || !sameOwnedPayload(stage.payloadPath, stage.payload) ||
            !sameOwnedPayload(this.#path, stage.payload))
          throw new Error('replaced staged link');
        unlinkSync(stage.payloadPath);
        if (!sameIdentity(this.#path, stage.payload, 'file'))
          throw new Error('invalid published link');
        delete stage.payload;
      }
      fsyncDirectory(dirname(this.#path), snapshot.parent);
    } catch {
      failed = true;
    }
    const cleaned = stage === undefined || this.#cleanupStage(stage);
    if (failed || !cleaned) throw new ModelStateError('update');
  }

  #cleanupStage(stage: Stage): boolean {
    if (!sameOwnedStageDirectory(stage.path, stage)) return false;
    let complete = true;
    if (stage.payload) {
      if (sameOwnedPayload(stage.payloadPath, stage.payload)) {
        try { unlinkSync(stage.payloadPath); } catch { return false; }
      } else {
        try {
          if (!absent(stage.payloadPath)) return false;
          complete = false;
        } catch {
          return false;
        }
      }
    }
    if (!sameOwnedStageDirectory(stage.path, stage)) return false;
    try { rmdirSync(stage.path); } catch { return false; }
    return complete;
  }

  #releaseLock(lock: OwnedLock): boolean {
    let owned = sameIdentity(lock.path, lock, 'file');
    if (owned) {
      try { unlinkSync(lock.path); } catch { owned = false; }
    }
    try { closeSync(lock.descriptor); } catch { owned = false; }
    return owned;
  }
}
