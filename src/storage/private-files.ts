import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  rmSync,
  unlinkSync
} from 'node:fs';
import { dirname, join } from 'node:path';

const FILE_ERROR = 'Private file operation failed.';
const SIDECAR_SUFFIXES = ['-wal', '-shm', '-journal'] as const;

function fail(): never {
  throw new Error(FILE_ERROR);
}

function requirePosix(): void {
  if (process.platform === 'win32' || typeof process.geteuid !== 'function') fail();
}

function exists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function validateDirectory(path: string): void {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.geteuid!() || (stat.mode & 0o077) !== 0)
    fail();
}

function fsyncDirectory(path: string): void {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function openValidatedPrivateFile(path: string, readOnly: boolean): number {
  validateDirectory(dirname(path));
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(descriptor);
    const mode = stat.mode & 0o7777;
    const validMode = readOnly ? mode === 0o400 || mode === 0o600 : mode === 0o600;
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.geteuid!() || !validMode)
      fail();
    return descriptor;
  } catch (error) {
    closeSync(descriptor);
    throw error;
  }
}

function noSidecars(path: string): void {
  if (SIDECAR_SUFFIXES.some(suffix => exists(`${path}${suffix}`))) fail();
}

export function ensurePrivateDirectory(path: string): void {
  try {
    requirePosix();
    if (!exists(path)) mkdirSync(path, { recursive: true, mode: 0o700 });
    validateDirectory(path);
  } catch {
    fail();
  }
}

export function validatePrivateFile(path: string, options: { readOnly?: boolean } = {}): void {
  let descriptor: number | undefined;
  try {
    requirePosix();
    descriptor = openValidatedPrivateFile(path, options.readOnly === true);
  } catch {
    fail();
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

/** @internal Read through the same validated descriptor used by private-file checks. */
export function readPrivateFile(path: string, maximumBytes: number): Buffer {
  let descriptor: number | undefined;
  try {
    requirePosix();
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) fail();
    descriptor = openValidatedPrivateFile(path, true);
    const initial = fstatSync(descriptor);
    if (initial.size > maximumBytes) fail();
    const output = Buffer.alloc(maximumBytes + 1);
    let total = 0;
    while (total <= maximumBytes) {
      const count = readSync(descriptor, output, total, output.byteLength - total, null);
      if (count === 0) break;
      total += count;
    }
    if (total > maximumBytes) fail();
    return Buffer.from(output.subarray(0, total));
  } catch {
    fail();
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  fail();
}

export function preparePrivateDatabasePath(path: string, readOnly: boolean): void {
  try {
    requirePosix();
    if (typeof readOnly !== 'boolean') fail();
    const directory = dirname(path);
    if (readOnly) validateDirectory(directory);
    else ensurePrivateDirectory(directory);

    if (exists(path)) {
      validatePrivateFile(path, { readOnly });
      for (const suffix of SIDECAR_SUFFIXES) {
        const sidecar = `${path}${suffix}`;
        if (exists(sidecar)) validatePrivateFile(sidecar, { readOnly });
      }
      return;
    }

    noSidecars(path);
    if (readOnly) fail();
    const descriptor = openSync(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600
    );
    try {
      fchmodSync(descriptor, 0o600);
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    fsyncDirectory(directory);
  } catch {
    fail();
  }
}

export async function publishPrivateFile(
  destination: string,
  write: (stagedPath: string) => Promise<void>,
  options: { sqlite?: boolean } = {}
): Promise<void> {
  let stagingDirectory: string | undefined;
  try {
    requirePosix();
    if (typeof write !== 'function') fail();
    const directory = dirname(destination);
    ensurePrivateDirectory(directory);
    if (exists(destination)) fail();
    if (options.sqlite === true) noSidecars(destination);

    stagingDirectory = mkdtempSync(join(directory, '.behalvo-stage-'));
    chmodSync(stagingDirectory, 0o700);
    validateDirectory(stagingDirectory);
    const stagedPath = join(stagingDirectory, 'payload');
    const initialDescriptor = openSync(
      stagedPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600
    );
    try {
      fchmodSync(initialDescriptor, 0o600);
    } finally {
      closeSync(initialDescriptor);
    }

    await write(stagedPath);

    const stagedDescriptor = openValidatedPrivateFile(stagedPath, false);
    try {
      fsyncSync(stagedDescriptor);
    } finally {
      closeSync(stagedDescriptor);
    }
    fsyncDirectory(stagingDirectory);
    if (options.sqlite === true) noSidecars(destination);
    linkSync(stagedPath, destination);
    unlinkSync(stagedPath);
    fsyncDirectory(directory);
  } catch {
    fail();
  } finally {
    if (stagingDirectory !== undefined) {
      try {
        rmSync(stagingDirectory, { recursive: true, force: true });
      } catch {
        // Publication already has a fixed failure surface; never remove other paths.
      }
    }
  }
}
