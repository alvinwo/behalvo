import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { NATIVE_HOST_NAME } from '../dist/index.js';
import { parseBrowserArgs, runBrowserCli } from '../dist/cli/browser-main.js';

const posix = process.platform !== 'win32' && typeof process.geteuid === 'function';
const cliPath = resolve('dist/cli/browser-main.js');
const extensionId = 'a'.repeat(32);

function privateDir(parent, name) {
  const path = join(parent, name);
  mkdirSync(path, { mode: 0o700 });
  chmodSync(path, 0o700);
  return path;
}

function fixture(t) {
  const temp = mkdtempSync(join(tmpdir(), 'behalvo-browser-cli-'));
  chmodSync(temp, 0o700);
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const root = privateDir(temp, 'install');
  const registrationDirectory = join(root, 'chrome-profile', 'NativeMessagingHosts');
  const chromePath = join(temp, 'chrome');
  writeFileSync(chromePath, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  chmodSync(chromePath, 0o700);
  return { temp, root, registrationDirectory, chromePath };
}

function run(args) {
  return spawnSync(process.execPath, [cliPath, ...args], { encoding: 'utf8' });
}

function parseSuccess(result) {
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  return JSON.parse(result.stdout);
}

test('browser CLI stages, finalizes, and diagnoses one dedicated synthetic Chrome installation',
  { skip: !posix }, t => {
    const { root, registrationDirectory, chromePath } = fixture(t);

    const staged = parseSuccess(run([
      'setup', '--root', root, '--chrome', chromePath,
      '--registration-dir', registrationDirectory
    ]));
    assert.deepEqual(Object.keys(staged).sort(),
      ['extensionPath', 'launcherPath', 'profilePath', 'root', 'status'].sort());
    assert.equal(staged.status, 'staged');
    assert.equal(staged.root, root);
    assert.equal(staged.profilePath, join(root, 'chrome-profile'));
    assert.equal(staged.extensionPath, join(root, 'extension'));
    assert.equal(staged.launcherPath, join(root, 'chrome-bridge-native-host'));

    const configured = parseSuccess(run([
      'setup', '--root', root, '--extension-id', extensionId
    ]));
    assert.deepEqual(configured, {
      status: 'configured',
      root,
      extensionId,
      registrationPath: join(registrationDirectory, `${NATIVE_HOST_NAME}.json`)
    });

    const doctor = parseSuccess(run(['doctor', '--root', root]));
    assert.deepEqual(doctor, {
      configured: true,
      registered: true,
      handshakeObserved: false,
      issues: [],
      root,
      profilePath: join(root, 'chrome-profile'),
      extensionPath: join(root, 'extension'),
      registrationPath: join(registrationDirectory, `${NATIVE_HOST_NAME}.json`)
    });
    assert.match(readFileSync(configured.registrationPath, 'utf8'),
      new RegExp(`chrome-extension://${extensionId}/`));
  });

test('browser CLI remove preserves the profile and unknown artifacts including empty directories',
  { skip: !posix }, t => {
    const { root, registrationDirectory, chromePath } = fixture(t);
    parseSuccess(run([
      'setup', '--root', root, '--chrome', chromePath,
      '--registration-dir', registrationDirectory
    ]));
    parseSuccess(run(['setup', '--root', root, '--extension-id', extensionId]));

    const unknownDirectory = privateDir(root, 'owner-retained-empty');
    const unknownFile = join(root, 'owner-retained.txt');
    writeFileSync(unknownFile, 'retain me\n', { mode: 0o600 });

    const removed = parseSuccess(run(['remove', '--root', root]));
    assert.equal(removed.status, 'removed');
    assert.ok(removed.retainedPaths.includes(join(root, 'chrome-profile')));
    assert.ok(removed.retainedPaths.includes(unknownDirectory));
    assert.ok(removed.retainedPaths.includes(unknownFile));
  });

test('browser CLI rejects ambiguous setup forms and emits one fixed error without echoing input',
  { skip: !posix }, t => {
    const { root, registrationDirectory, chromePath } = fixture(t);
    const secretMarker = 'private-input-must-not-echo';
    const cases = [
      ['setup', '--root', root],
      ['setup', '--root', root, '--chrome', chromePath, '--extension-id', extensionId,
        '--registration-dir', registrationDirectory],
      ['doctor', '--root', secretMarker],
      ['unknown', '--root', root]
    ];
    for (const args of cases) {
      const result = run(args);
      assert.notEqual(result.status, 0);
      assert.equal(result.stdout, '');
      assert.equal(result.stderr, 'Chrome bridge command failed.\n');
      assert.doesNotMatch(result.stderr, /private-input|browser-cli|extension-id|unknown/);
    }
  });


test('browser CLI run accepts only an install root and private storage key path', () => {
  assert.deepEqual(parseBrowserArgs([
    'run',
    '--root', '/private/install',
    '--storage-key-file', '/private/storage.key'
  ]), {
    kind: 'run',
    root: '/private/install',
    storageKeyPath: '/private/storage.key'
  });
  for (const args of [
    ['run', '--root', '/private/install'],
    ['run', '--storage-key-file', '/private/storage.key'],
    ['run', '--root', '/private/install', '--storage-key-file', '/private/storage.key', '--db', '/tmp/db'],
    ['run', '--root', 'relative', '--storage-key-file', '/private/storage.key']
  ]) {
    assert.throws(() => parseBrowserArgs(args));
  }
});

test('browser CLI run loads and wipes the storage key and invokes diagnostic once with fixed synthetic paths',
  async () => {
    const output = [];
    const errors = [];
    const calls = [];
    const key = new Uint8Array(32).fill(7);
    const code = await runBrowserCli([
      'run',
      '--root', '/private/install',
      '--storage-key-file', '/private/storage.key'
    ], {
      writeStdout(text) { output.push(text); },
      writeStderr(text) { errors.push(text); },
      loadStorageKey(path) {
        assert.equal(path, '/private/storage.key');
        return key;
      },
      async diagnostic(input) {
        calls.push(structuredClone(input));
        assert.deepEqual(Array.from(input.encryptionKey), Array(32).fill(7));
        return {
          serviceOrigin: 'http://127.0.0.1:45555',
          bootstrapPath: '/private/install/service-bootstrap/bootstrap.json',
          enrollmentPath: '/private/install/runtime/bridge-enrollment.json',
          tabId: 7,
          pageState: 'login'
        };
      }
    });

    assert.equal(code, 0);
    assert.deepEqual(errors, []);
    assert.equal(calls.length, 1);
    assert.deepEqual({
      root: calls[0].root,
      dbPath: calls[0].dbPath,
      bootstrapDirectory: calls[0].bootstrapDirectory,
      workspaceId: calls[0].workspaceId,
      ownerId: calls[0].ownerId,
      storageKeyPath: calls[0].storageKeyPath
    }, {
      root: '/private/install',
      dbPath: '/private/install/synthetic-service.db',
      bootstrapDirectory: '/private/install/service-bootstrap',
      workspaceId: 'synthetic-chrome-diagnostic',
      ownerId: 'owner',
      storageKeyPath: '/private/storage.key'
    });
    assert.deepEqual(Array.from(key), Array(32).fill(0));
    assert.match(output.join(''), /bridge-enrollment\.json/);
    assert.match(output.join(''), /extension popup/i);
    assert.match(output.join(''), /"pageState":"login"/);
  });
