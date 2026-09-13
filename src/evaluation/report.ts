import { randomUUID } from 'node:crypto';
import { link, lstat, mkdir, open, rmdir, stat, unlink, type FileHandle } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

export class ReportOutputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReportOutputError';
  }
}

export interface PreparedReportOutput {
  readonly path: string;
  publish(value: unknown): Promise<void>;
  abort(): Promise<void>;
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

function isExisting(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'EEXIST';
}

async function removeCreatedFile(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}

async function removeCreatedDirectory(path: string): Promise<void> {
  try {
    await rmdir(path);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}

async function validatePosixParent(parent: string): Promise<void> {
  if (process.platform === 'win32') return;
  const info = await stat(parent);
  const effectiveUid = process.geteuid?.();
  const trustedOwner = effectiveUid !== undefined && (info.uid === effectiveUid || info.uid === 0);
  const sharedWritable = (info.mode & 0o022) !== 0;
  const sticky = (info.mode & 0o1000) !== 0;
  if (!info.isDirectory() || !trustedOwner || (sharedWritable && !sticky))
    throw new ReportOutputError('Evaluation report parent is not a safe private output location.');
}

async function validatePosixStaging(stagingPath: string): Promise<void> {
  if (process.platform === 'win32') return;
  const info = await lstat(stagingPath);
  const effectiveUid = process.geteuid?.();
  if (!info.isDirectory() || effectiveUid === undefined || info.uid !== effectiveUid || (info.mode & 0o077) !== 0)
    throw new ReportOutputError('Unable to establish private evaluation report staging.');
}

/**
 * Prepares a private same-directory staging area. Publication uses an atomic
 * hard link, so an existing file or symlink at the destination is never
 * replaced. POSIX parent checks prevent a different unprivileged UID from
 * replacing the staging directory through a non-sticky shared parent.
 */
export async function prepareReportOutput(outputPath: string): Promise<PreparedReportOutput> {
  const path = resolve(outputPath);
  const parent = dirname(path);
  try {
    await mkdir(parent, { recursive: true, mode: 0o700 });
    await validatePosixParent(parent);
    try {
      await lstat(path);
      throw new ReportOutputError('Evaluation report output already exists.');
    } catch (error) {
      if (error instanceof ReportOutputError) throw error;
      if (!isMissing(error)) throw error;
    }
  } catch (error) {
    if (error instanceof ReportOutputError) throw error;
    throw new ReportOutputError('Unable to prepare private evaluation report output.');
  }

  const stagingPath = join(parent, `.behalvo-evaluation-${randomUUID()}`);
  const temporaryPath = join(stagingPath, 'report.json');
  let stagingCreated = false;
  try {
    await mkdir(stagingPath, { mode: 0o700 });
    stagingCreated = true;
    await validatePosixStaging(stagingPath);
  } catch (error) {
    if (stagingCreated) {
      try { await removeCreatedDirectory(stagingPath); } catch { /* narrowly scoped best effort */ }
    }
    if (error instanceof ReportOutputError) throw error;
    throw new ReportOutputError('Unable to establish private evaluation report staging.');
  }

  let handle: FileHandle;
  try {
    handle = await open(temporaryPath, 'wx', 0o600);
  } catch {
    try { await removeCreatedDirectory(stagingPath); } catch { /* narrowly scoped best effort */ }
    throw new ReportOutputError('Unable to prepare private evaluation report output.');
  }
  try {
    await handle.chmod(0o600);
  } catch {
    try { await handle.close(); } catch { /* preserve the generic public diagnostic */ }
    try { await removeCreatedFile(temporaryPath); } catch { /* narrowly scoped best effort */ }
    try { await removeCreatedDirectory(stagingPath); } catch { /* narrowly scoped best effort */ }
    throw new ReportOutputError('Unable to prepare private evaluation report output.');
  }

  let settled = false;
  const close = async (): Promise<void> => {
    try {
      await handle.close();
    } catch { /* already closed or unavailable */ }
  };
  const cleanup = async (): Promise<void> => {
    await close();
    try {
      await removeCreatedFile(temporaryPath);
    } catch { /* preserve the generic public diagnostic */ }
    try {
      await removeCreatedDirectory(stagingPath);
    } catch { /* preserve the generic public diagnostic */ }
  };

  return {
    path,
    async publish(value: unknown): Promise<void> {
      if (settled) throw new ReportOutputError('Evaluation report output is no longer available.');
      settled = true;
      try {
        const serialized = JSON.stringify(value, null, 2);
        if (serialized === undefined) throw new Error('Report is not JSON serializable');
        await handle.writeFile(`${serialized}\n`, { encoding: 'utf8' });
        await handle.chmod(0o600);
        await handle.sync();
        await link(temporaryPath, path);
        await cleanup();
      } catch (error) {
        await cleanup();
        if (isExisting(error))
          throw new ReportOutputError('Evaluation report output already exists.');
        throw new ReportOutputError('Unable to publish private evaluation report output.');
      }
    },
    async abort(): Promise<void> {
      if (settled) {
        await cleanup();
        return;
      }
      settled = true;
      await cleanup();
    }
  };
}
