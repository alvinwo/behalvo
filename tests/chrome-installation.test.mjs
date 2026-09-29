import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  rmSync, statSync, writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  doctorChromeBridgeInstallation,
  finalizeChromeBridgeInstallation,
  NATIVE_HOST_NAME,
  removeChromeBridgeInstallation,
  stageChromeBridgeInstallation
} from '../dist/index.js';

const posix = process.platform !== 'win32' && typeof process.geteuid === 'function';
const extensionId = 'a'.repeat(32);

function sha(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function privateDir(parent, name) {
  const path = join(parent, name);
  mkdirSync(path, { mode: 0o700 });
  chmodSync(path, 0o700);
  return path;
}

function fixture(t, options = {}) {
  const temp = mkdtempSync(join(tmpdir(), 'behalvo-chrome-install-'));
  chmodSync(temp, 0o700);
  t.after(() => rmSync(temp, { recursive: true, force: true }));

  const packageRoot = privateDir(temp, options.quoted ? "package root 'quoted'" : 'package');
  const extension = privateDir(packageRoot, 'extension');
  const extensionDist = privateDir(extension, 'dist');
  const sourceFiles = {
    'manifest.json': '{"manifest_version":3}\n',
    'popup.html': '<!doctype html>\n',
    'dist/background.js': 'export const background = true;\n',
    'dist/content.js': 'export const content = true;\n',
    'dist/popup.js': 'export const popup = true;\n',
    'dist/protocol.js': 'export const protocol = true;\n'
  };
  for (const [relative, content] of Object.entries(sourceFiles)) {
    const path = join(extension, relative);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, content, { mode: 0o600 });
  }

  const brokerDir = privateDir(packageRoot, 'dist');
  const browserDir = privateDir(brokerDir, 'browser');
  const brokerPath = join(browserDir, 'native-broker.js');
  writeFileSync(brokerPath, `
    import { writeFileSync } from 'node:fs';
    import { join } from 'node:path';
    if (process.argv[2] !== '--root' || !process.argv[3]) process.exit(64);
    writeFileSync(join(process.argv[3], 'launched.json'), JSON.stringify(process.argv.slice(2)) + '\\n');
  `, { mode: 0o600 });

  const chromePath = join(temp, options.quoted ? "Chrome 'Synthetic'" : 'chrome');
  writeFileSync(chromePath, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  chmodSync(chromePath, 0o700);

  const root = privateDir(temp, options.quoted ? "install root 'quoted'" : 'install');
  const registrationDirectory = join(root, 'chrome-profile', 'NativeMessagingHosts');
  return { temp, packageRoot, brokerPath, chromePath, root, registrationDirectory, sourceFiles };
}

function stageInput(f) {
  return {
    root: f.root,
    packageRoot: f.packageRoot,
    chromePath: f.chromePath,
    nodePath: process.execPath,
    registrationDirectory: f.registrationDirectory
  };
}

function treeSnapshot(path) {
  const result = {};
  const visit = current => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(current, entry.name);
      const relative = full.slice(path.length + 1);
      const stat = lstatSync(full);
      result[relative] = {
        kind: entry.isDirectory() ? 'directory' : 'file',
        mode: stat.mode & 0o777,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        digest: entry.isFile() ? sha(full) : null
      };
      if (entry.isDirectory()) visit(full);
    }
  };
  visit(path);
  return result;
}

test('setup stages a reviewed bridge into a dedicated profile and exact repeat is idempotent',
  { skip: !posix }, t => {
    const f = fixture(t);
    const first = stageChromeBridgeInstallation(stageInput(f));
    const second = stageChromeBridgeInstallation(stageInput(f));
    assert.deepEqual(second, first);
    assert.equal(first.root, f.root);
    assert.equal(first.packageRoot, f.packageRoot);
    assert.equal(first.chromePath, f.chromePath);
    assert.equal(first.nodePath, process.execPath);
    assert.equal(first.profilePath, join(f.root, 'chrome-profile'));
    assert.equal(first.extensionPath, join(f.root, 'extension'));
    assert.equal(first.registrationPath, join(f.registrationDirectory, `${NATIVE_HOST_NAME}.json`));
    assert.ok(existsSync(first.profilePath));
    assert.equal(lstatSync(first.profilePath).mode & 0o777, 0o700);
    for (const [relative, source] of Object.entries(f.sourceFiles)) {
      const staged = join(first.extensionPath, relative);
      assert.equal(readFileSync(staged, 'utf8'), source);
      assert.equal(lstatSync(staged).mode & 0o777, 0o600);
    }
    assert.equal(first.hashes.chrome, sha(f.chromePath));
    assert.equal(first.hashes.node, sha(process.execPath));
    assert.equal(first.hashes.broker, sha(f.brokerPath));
    assert.match(first.installationId, /^[A-Za-z0-9._:-]{1,128}$/);
  });

test('setup and finalization refuse conflicting generated or registration files without replacing them',
  { skip: !posix }, t => {
    const f = fixture(t);
    const foreignExtension = join(f.root, 'extension');
    mkdirSync(foreignExtension, { mode: 0o700 });
    writeFileSync(join(foreignExtension, 'foreign.txt'), 'foreign', { mode: 0o600 });
    assert.throws(() => stageChromeBridgeInstallation(stageInput(f)), /Chrome bridge installation/i);
    assert.equal(readFileSync(join(foreignExtension, 'foreign.txt'), 'utf8'), 'foreign');
    rmSync(foreignExtension, { recursive: true });

    const staged = stageChromeBridgeInstallation(stageInput(f));
    writeFileSync(staged.registrationPath, '{"foreign":true}\n', { mode: 0o600 });
    assert.throws(() => finalizeChromeBridgeInstallation({ root: f.root, extensionId }),
      /Chrome bridge installation/i);
    assert.equal(readFileSync(staged.registrationPath, 'utf8'), '{"foreign":true}\n');
  });

test('finalization binds the exact extension origin to the staged launcher and is idempotent',
  { skip: !posix }, t => {
    const f = fixture(t);
    const staged = stageChromeBridgeInstallation(stageInput(f));
    const finalized = finalizeChromeBridgeInstallation({ root: f.root, extensionId });
    assert.equal(finalized.extensionId, extensionId);
    assert.deepEqual(finalizeChromeBridgeInstallation({ root: f.root, extensionId }), finalized);
    const manifest = JSON.parse(readFileSync(staged.registrationPath, 'utf8'));
    assert.deepEqual(manifest, {
      name: NATIVE_HOST_NAME,
      description: 'Behalvo local synthetic browser boundary',
      path: staged.launcherPath,
      type: 'stdio',
      allowed_origins: [`chrome-extension://${extensionId}/`]
    });
  });

test('doctor is read-only and separates configured registration from an observed handshake',
  { skip: !posix }, t => {
    const f = fixture(t);
    stageChromeBridgeInstallation(stageInput(f));
    finalizeChromeBridgeInstallation({ root: f.root, extensionId });
    const beforeRoot = treeSnapshot(f.root);
    const beforeRegistration = treeSnapshot(f.registrationDirectory);
    const report = doctorChromeBridgeInstallation({ root: f.root });
    assert.deepEqual(report.issues, []);
    assert.equal(report.configured, true);
    assert.equal(report.registered, true);
    assert.equal(report.handshakeObserved, false);
    assert.deepEqual(treeSnapshot(f.root), beforeRoot);
    assert.deepEqual(treeSnapshot(f.registrationDirectory), beforeRegistration);
  });

test('generated launcher safely quotes paths and executes the absolute Node broker as a separate process',
  { skip: !posix }, t => {
    const f = fixture(t, { quoted: true });
    const staged = stageChromeBridgeInstallation(stageInput(f));
    const launcher = readFileSync(staged.launcherPath, 'utf8');
    assert.match(launcher, /^#!\/bin\/sh\nexec /);
    assert.doesNotMatch(launcher, /\bnpm\b/);
    const result = spawnSync(staged.launcherPath, [], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '');
    assert.deepEqual(JSON.parse(readFileSync(join(f.root, 'launched.json'), 'utf8')),
      ['--root', f.root]);
  });

test('narrow removal refuses changed owned artifacts and retains profile plus unknown files and empty directories',
  { skip: !posix }, t => {
    const f = fixture(t);
    const staged = stageChromeBridgeInstallation(stageInput(f));
    finalizeChromeBridgeInstallation({ root: f.root, extensionId });
    writeFileSync(join(staged.profilePath, 'profile-data'), 'retain me', { mode: 0o600 });
    writeFileSync(join(f.root, 'unknown.txt'), 'retain me too', { mode: 0o600 });
    const unknownEmpty = join(staged.extensionPath, 'unknown-empty');
    mkdirSync(unknownEmpty, { mode: 0o700 });
    const originalLauncher = readFileSync(staged.launcherPath, 'utf8');
    writeFileSync(staged.launcherPath, originalLauncher + '# changed\n', { mode: 0o700 });
    assert.throws(() => removeChromeBridgeInstallation({ root: f.root }), /Chrome bridge installation/i);
    assert.ok(existsSync(staged.registrationPath));
    writeFileSync(staged.launcherPath, originalLauncher, { mode: 0o700 });
    chmodSync(staged.launcherPath, 0o700);

    const result = removeChromeBridgeInstallation({ root: f.root });
    assert.equal(existsSync(staged.registrationPath), false);
    assert.equal(existsSync(staged.metadataPath), false);
    assert.equal(existsSync(staged.launcherPath), false);
    assert.ok(existsSync(staged.profilePath));
    assert.equal(readFileSync(join(staged.profilePath, 'profile-data'), 'utf8'), 'retain me');
    assert.equal(readFileSync(join(f.root, 'unknown.txt'), 'utf8'), 'retain me too');
    assert.equal(statSync(unknownEmpty).isDirectory(), true);
    for (const relative of Object.keys(f.sourceFiles))
      assert.equal(existsSync(join(staged.extensionPath, relative)), false);
    assert.ok(result.retainedPaths.includes(staged.profilePath));
    assert.ok(result.retainedPaths.includes(join(f.root, 'unknown.txt')));
    assert.ok(result.retainedPaths.includes(unknownEmpty));
  });
