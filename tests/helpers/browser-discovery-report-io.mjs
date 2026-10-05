import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { constants, realpathSync, lstatSync, mkdirSync, readFileSync, readlinkSync, openSync, writeFileSync,
  fsyncSync, closeSync, linkSync, unlinkSync, fstatSync } from 'node:fs';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { serializeDiscoveryReport } from './browser-discovery-report.mjs';
const execute = promisify(execFile);
const fail = () => { throw new Error('Synthetic discovery evidence operation failed.'); };
const handles = new WeakMap();
const workspaceId = 'synthetic-browser-discovery';
const digest = value => createHash('sha256').update(value).digest('hex');
async function git(root, args) {
  const { stdout } = await execute('git', ['-c', 'core.fsmonitor=false', ...args],
    { cwd: root, timeout: 5000, maxBuffer: 8 * 1024 * 1024, encoding: 'buffer' });
  return stdout;
}
/** Local navigation provenance only, never an authenticated source attestation. */
export async function captureDiscoverySource(repoRoot) {
  try {
    const root = realpathSync(repoRoot);
    if (realpathSync((await git(root, ['rev-parse', '--show-toplevel'])).toString().trim()) !== root) fail();
    const head = (await git(root, ['rev-parse', 'HEAD'])).toString().trim();
    if (!/^[a-f0-9]{40}$/.test(head)) fail();
    const diffArgs = ['--no-ext-diff', '--no-textconv', '--binary', '--'];
    const [tracked, staged, unstaged, untracked] = await Promise.all([
      git(root, ['diff', 'HEAD', ...diffArgs]), git(root, ['diff', '--cached', ...diffArgs]),
      git(root, ['diff', ...diffArgs]), git(root, ['ls-files', '--others', '--exclude-standard', '-z'])
    ]);
    const aggregate = createHash('sha256').update(`tracked\0${digest(tracked)}\0`);
    const paths = untracked.toString().split('\0').filter(Boolean).sort();
    if (paths.length > 10000) fail();
    let bytes = 0;
    for (const name of paths) {
      if (isAbsolute(name) || name.split('/').includes('..')) fail();
      const path = join(root, name), stat = lstatSync(path);
      aggregate.update(`path\0${name}\0`);
      if (stat.isSymbolicLink()) aggregate.update(`symlink\0${readlinkSync(path)}\0`);
      else if (stat.isFile()) {
        bytes += stat.size; if (bytes > 8 * 1024 * 1024) fail();
        aggregate.update(`file\0${digest(readFileSync(path))}\0`);
      } else fail();
    }
    if ((await git(root, ['rev-parse', 'HEAD'])).toString().trim() !== head) fail();
    return { head, dirty: staged.length > 0 || unstaged.length > 0 || paths.length > 0, fingerprint: aggregate.digest('hex') };
  } catch { return fail(); }
}
export function discoveryProvenance(before, after) {
  for (const value of [before, after]) if (!value || typeof value.head !== 'string' || !/^[a-f0-9]{40}$/.test(value.head) ||
    typeof value.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(value.fingerprint) || typeof value.dirty !== 'boolean') fail();
  const changed = before.head !== after.head || before.fingerprint !== after.fingerprint || before.dirty !== after.dirty;
  return !before.dirty && !after.dirty && !changed ? { kind: 'clean_commit', commit: before.head }
    : { kind: 'dirty_tree', baseCommit: before.head, beforeFingerprint: before.fingerprint,
      afterFingerprint: after.fingerprint, changedDuringRun: changed };
}
function directory(path, privateMode = false) {
  const info = lstatSync(path, { bigint: true });
  if (typeof process.getuid !== 'function' || !info.isDirectory() || info.isSymbolicLink() ||
      info.uid !== BigInt(process.getuid()) || (info.mode & 0o022n) !== 0n ||
      (privateMode && (info.mode & 0o777n) !== 0o700n)) fail();
  return { path, dev: info.dev, ino: info.ino, birth: info.birthtimeNs, privateMode };
}
function verify(handle) {
  for (const identity of handle.identities) {
    const now = directory(identity.path, identity.privateMode);
    if (now.dev !== identity.dev || now.ino !== identity.ino || now.birth !== identity.birth) fail();
  }
}
/** Only helper-owned handles can publish; canonical root and descendants are checked. */
export function createDiscoveryReportRun(repoRoot) {
  try {
    const root = realpathSync(resolve(repoRoot)); const identities = [directory(root)];
    const runId = randomUUID(); let path = root;
    for (const part of ['data', 'verification', 'browser-discovery', workspaceId, runId]) {
      path = join(path, part);
      try { mkdirSync(path, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST' || part === runId) throw error; }
      identities.push(directory(path, !['data', 'verification'].includes(part)));
    }
    const run = Object.freeze({ workspaceId, runId, runDirectory: path });
    handles.set(run, { root, identities }); return run;
  } catch { return fail(); }
}
/** Exclusive publication; optional I/O seams are confined to verification tests. */
export function persistDiscoveryReport(run, report, operations = {}) {
  let temporary, fd;
  try {
    const handle = handles.get(run); if (!handle) fail();
    handles.delete(run); // One publication attempt per handle, including failed attempts.
    const bytes = serializeDiscoveryReport(report);
    if (report.workspaceId !== run.workspaceId || report.runId !== run.runId ||
        relative(handle.root, run.runDirectory) !== join('data', 'verification', 'browser-discovery', workspaceId, run.runId)) fail();
    verify(handle);
    temporary = join(run.runDirectory, `.report-${randomUUID()}.tmp`);
    fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    (operations.write ?? writeFileSync)(fd, bytes); fsyncSync(fd);
    const file = fstatSync(fd);
    if (!file.isFile() || file.nlink !== 1 || (file.mode & 0o777) !== 0o600 || file.size !== bytes.length) fail();
    closeSync(fd); fd = undefined;
    verify(handle);
    const destination = join(run.runDirectory, 'report.json');
    (operations.publish ?? linkSync)(temporary, destination);
    unlinkSync(temporary); temporary = undefined;
    const parent = openSync(run.runDirectory, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { fsyncSync(parent); } finally { closeSync(parent); }
    return destination;
  } catch { return fail(); }
  finally {
    if (fd !== undefined) { try { closeSync(fd); } catch {} }
    if (temporary) { try { unlinkSync(temporary); } catch {} }
  }
}
