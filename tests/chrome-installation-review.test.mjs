import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, lstatSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  doctorChromeBridgeInstallation,
  finalizeChromeBridgeInstallation,
  removeChromeBridgeInstallation,
  stageChromeBridgeInstallation
} from '../dist/index.js';

const posix = process.platform !== 'win32' && typeof process.geteuid === 'function';

function fixture(t) {
  const temp = mkdtempSync(join(tmpdir(), 'behalvo-install-review-'));
  chmodSync(temp, 0o700);
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const root = join(temp, 'install');
  const packageRoot = join(temp, 'package');
  for (const path of [root, join(packageRoot, 'dist', 'browser'), join(packageRoot, 'extension', 'dist')])
    mkdirSync(path, { recursive: true, mode: 0o700 });
  writeFileSync(join(packageRoot, 'dist', 'browser', 'native-broker.js'), 'export {};\n', { mode: 0o600 });
  for (const path of ['manifest.json', 'popup.html', 'dist/background.js', 'dist/content.js', 'dist/popup.js', 'dist/protocol.js'])
    writeFileSync(join(packageRoot, 'extension', path), '{}\n', { mode: 0o600 });
  const chromePath = join(temp, 'synthetic-chrome');
  writeFileSync(chromePath, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  chmodSync(chromePath, 0o700);
  return {
    temp,
    input: {
      root,
      packageRoot,
      chromePath,
      nodePath: process.execPath,
      registrationDirectory: join(root, 'chrome-profile', 'NativeMessagingHosts')
    }
  };
}

test('review R1: setup creates native registration inside the previously absent dedicated user-data directory',
  { skip: !posix }, t => {
    const { input } = fixture(t);
    assert.equal(existsSync(join(input.root, 'chrome-profile')), false);
    const staged = stageChromeBridgeInstallation(input);
    assert.equal(staged.registrationDirectory, join(staged.profilePath, 'NativeMessagingHosts'));
    assert.equal(existsSync(staged.registrationDirectory), true);
    assert.deepEqual(stageChromeBridgeInstallation(input), staged);
    const finalized = finalizeChromeBridgeInstallation({ root: input.root, extensionId: 'a'.repeat(32) });
    const manifest = JSON.parse(readFileSync(finalized.registrationPath, 'utf8'));
    assert.equal(manifest.path, finalized.launcherPath);
    assert.deepEqual(manifest.allowed_origins, [`chrome-extension://${'a'.repeat(32)}/`]);
    const report = doctorChromeBridgeInstallation({ root: input.root });
    assert.equal(report.configured, true);
    assert.equal(report.registered, true);
    assert.equal(report.handshakeObserved, false);
  });

test('review R1: setup rejects an unrelated private registration directory before creating profile artifacts',
  { skip: !posix }, t => {
    const { input, temp } = fixture(t);
    const unrelated = join(temp, 'unrelated-native-hosts');
    mkdirSync(unrelated, { mode: 0o700 });
    assert.throws(() => stageChromeBridgeInstallation({ ...input, registrationDirectory: unrelated }),
      /Chrome bridge installation operation failed/);
    assert.equal(existsSync(join(input.root, 'chrome-profile')), false);
    assert.equal(existsSync(join(input.root, 'chrome-bridge-installation.json')), false);
  });

for (const marker of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
  test(`review R6: removal retains installation when ${marker} is a dangling symlink`,
    { skip: !posix }, t => {
      const { input } = fixture(t);
      const staged = stageChromeBridgeInstallation(input);
      const finalized = finalizeChromeBridgeInstallation({ root: input.root, extensionId: 'a'.repeat(32) });
      const markerPath = join(staged.profilePath, marker);
      symlinkSync('absent-chrome-target', markerPath);
      assert.throws(() => removeChromeBridgeInstallation({ root: input.root }),
        /Chrome bridge installation operation failed/);
      assert.equal(lstatSync(markerPath).isSymbolicLink(), true);
      assert.equal(existsSync(finalized.registrationPath), true);
      assert.equal(existsSync(staged.metadataPath), true);
    });
}

 test('review R7: changed compiled broker dependency invalidates setup and doctor but permits narrow removal',
  { skip: !posix }, t => {
    const { input } = fixture(t);
    const helper = join(input.packageRoot, 'dist', 'browser', 'helper.js');
    writeFileSync(helper, 'export const value = 1;\n', { mode: 0o600 });
    writeFileSync(join(input.packageRoot, 'dist', 'browser', 'native-broker.js'),
      "import { value } from './helper.js'; export { value };\n", { mode: 0o600 });
    stageChromeBridgeInstallation(input);
    const finalized = finalizeChromeBridgeInstallation({ root: input.root, extensionId: 'a'.repeat(32) });
    assert.equal(doctorChromeBridgeInstallation({ root: input.root }).configured, true);
    writeFileSync(helper, 'export const value = 2;\n', { mode: 0o600 });
    assert.equal(doctorChromeBridgeInstallation({ root: input.root }).configured, false);
    assert.throws(() => stageChromeBridgeInstallation(input), /Chrome bridge installation operation failed/);
    removeChromeBridgeInstallation({ root: input.root });
    assert.equal(existsSync(finalized.metadataPath), false);
    assert.equal(existsSync(finalized.profilePath), true);
  });
