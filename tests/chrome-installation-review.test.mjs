import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  doctorChromeBridgeInstallation,
  finalizeChromeBridgeInstallation,
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
