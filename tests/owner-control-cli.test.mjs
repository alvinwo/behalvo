import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { getEventListeners } from 'node:events';
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseOwnerControlArgs, runOwnerControlCli } from '../dist/cli/owner-control-main.js';
import { initializeOwnerControlDemo } from '../dist/control/demo-fixture.js';
import { SqliteStore } from '../dist/index.js';

const CLI_PATH = fileURLToPath(new URL('../dist/cli/owner-control-main.js', import.meta.url));
const POSIX = process.platform !== 'win32';
const CHILD_TIMEOUT_MS = 5_000;
const FIXTURE_SUFFIXES = [
  '',
  '-wal',
  '-shm',
  '-journal',
  '.synthetic.sqlite',
  '.synthetic.sqlite-wal',
  '.synthetic.sqlite-shm',
  '.synthetic.sqlite-journal'
];

function createDirectory(prefix = 'behalvo owner control ') {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  chmodSync(directory, 0o700);
  return directory;
}

function captureDependencies(overrides = {}) {
  const output = { stdout: '', stderr: '' };
  return {
    output,
    dependencies: {
      writeStdout(text) { output.stdout += text; },
      writeStderr(text) { output.stderr += text; },
      ...overrides
    }
  };
}

function stripExactNode22SqliteWarning(stderr) {
  const warning = /\(node:\d+\) ExperimentalWarning: SQLite is an experimental feature and might change at any time\r?\n\(Use `node --trace-warnings \.\.\.` to show where the warning was created\)\r?\n/g;
  let matches = 0;
  const remaining = stderr.replace(warning, () => {
    matches += 1;
    return '';
  });
  assert.ok(matches <= 1, `duplicate Node 22 SQLite warnings: ${JSON.stringify(stderr)}`);
  return remaining;
}

test('subprocess stderr removes only the exact standard Node 22 SQLite warning', () => {
  const warning = '(node:2277) ExperimentalWarning: SQLite is an experimental feature and might change at any time\n' +
    '(Use `node --trace-warnings ...` to show where the warning was created)\n';
  assert.equal(stripExactNode22SqliteWarning(''), '');
  assert.equal(stripExactNode22SqliteWarning(warning), '');
  assert.equal(stripExactNode22SqliteWarning(warning.replaceAll('\n', '\r\n')), '');
  assert.equal(
    stripExactNode22SqliteWarning(`${warning}Owner control command failed.\n`),
    'Owner control command failed.\n'
  );
  assert.equal(
    stripExactNode22SqliteWarning(`${warning}unexpected diagnostic\n`),
    'unexpected diagnostic\n'
  );
  assert.throws(
    () => stripExactNode22SqliteWarning(`${warning}${warning}`),
    /duplicate Node 22 SQLite warnings/i
  );
});

function spawnCli(args, options) {
  const child = spawn(process.execPath, [options.cliPath ?? CLI_PATH, ...args], {
    cwd: options.cwd,
    env: options.env,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stdout = '';
  let stderr = '';
  let childError = null;
  let completed = false;
  let complete;
  const completion = new Promise(resolve => { complete = resolve; });
  const finish = result => {
    if (completed) return;
    completed = true;
    complete({ ...result, stdout, stderr });
  };
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.once('error', error => { childError = error; });
  child.once('close', (code, signal) => finish({ code, signal, error: childError }));
  return {
    child,
    completion,
    get stdout() { return stdout; },
    get stderr() { return stderr; }
  };
}

function copyStartupPausedCli(directory) {
  const copiedDist = join(directory, 'paused-dist');
  cpSync('dist', copiedDist, { recursive: true });
  const cliPath = join(copiedDist, 'cli', 'owner-control-main.js');
  const source = readFileSync(cliPath, 'utf8');
  const originalImport = "from '../control/http-server.js';";
  assert.ok(source.includes(originalImport));
  writeFileSync(
    cliPath,
    source.replace(originalImport, "from '../control/http-server-startup-pause-fixture.mjs';")
  );
  writeFileSync(join(copiedDist, 'control', 'http-server-startup-pause-fixture.mjs'), `
import { startOwnerControlServer as start } from './http-server.js';

export async function startOwnerControlServer(options) {
  const server = await start(options);
  let release;
  const paused = new Promise(resolve => { release = resolve; });
  const resume = () => release();
  process.once('SIGINT', resume);
  process.once('SIGTERM', resume);
  process.stdout.write('TEST_STARTUP_PAUSED: ' + JSON.stringify(server.bootstrapPath) + '\\n');
  try {
    await paused;
  } finally {
    process.off('SIGINT', resume);
    process.off('SIGTERM', resume);
  }
  return server;
}
`);
  return cliPath;
}

async function withTimeout(promise, message, timeout = CHILD_TIMEOUT_MS) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeout);
      })
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function waitForOutput(handle, text) {
  if (handle.stdout.includes(text)) return;
  await new Promise((resolve, reject) => {
    let timer;
    const onData = () => {
      if (!handle.stdout.includes(text)) return;
      cleanup();
      resolve();
    };
    const onClose = () => {
      cleanup();
      reject(new Error(`CLI closed before startup: ${JSON.stringify(handle.stderr)}`));
    };
    const cleanup = () => {
      if (timer !== undefined) clearTimeout(timer);
      handle.child.stdout.off('data', onData);
      handle.child.off('close', onClose);
    };
    handle.child.stdout.on('data', onData);
    handle.child.once('close', onClose);
    timer = setTimeout(() => {
      cleanup();
      reject(new Error('owner-control CLI did not start'));
    }, CHILD_TIMEOUT_MS);
  });
}

async function stopOwnedChild(handle, signal = 'SIGKILL') {
  if (handle.child.exitCode === null && handle.child.signalCode === null) handle.child.kill(signal);
  try {
    return await withTimeout(handle.completion, 'owner-control CLI did not stop', 2_000);
  } catch (error) {
    if (handle.child.exitCode === null && handle.child.signalCode === null) handle.child.kill('SIGKILL');
    await withTimeout(handle.completion, 'owner-control CLI survived SIGKILL', 2_000);
    throw error;
  }
}

async function completedChild(args, options, owned) {
  const handle = spawnCli(args, options);
  owned.push(handle);
  return withTimeout(handle.completion, 'owner-control CLI did not exit');
}

function bootstrapPath(stdout) {
  const match = /^Bootstrap file: (.+)$/m.exec(stdout);
  assert.ok(match, `missing bootstrap path: ${JSON.stringify(stdout)}`);
  return JSON.parse(match[1]);
}

test('owner-control CLI parses help, init, defaults, explicit workspace, and port endpoints', () => {
  const directory = createDirectory();
  try {
    assert.deepEqual(parseOwnerControlArgs([], directory), { kind: 'help' });
    assert.deepEqual(parseOwnerControlArgs(['--help'], directory), { kind: 'help' });
    assert.deepEqual(
      parseOwnerControlArgs(['init-demo', '--db', 'data/demo.db'], directory),
      { kind: 'init-demo', dbPath: join(directory, 'data/demo.db') }
    );

    const defaultServe = parseOwnerControlArgs([
      'serve', '--db', 'data/demo.db', '--bootstrap-dir', 'data/bootstrap'
    ], directory);
    assert.deepEqual(defaultServe, {
      kind: 'serve',
      dbPath: join(directory, 'data/demo.db'),
      bootstrapDirectory: join(directory, 'data/bootstrap'),
      workspaceId: 'owner-control-demo',
      port: 0
    });

    for (const port of ['0', '1', '65535']) {
      assert.deepEqual(parseOwnerControlArgs([
        'serve', '--db', 'demo.db', '--bootstrap-dir', 'bootstrap',
        '--workspace', 'explicit-workspace', '--port', port
      ], directory), {
        kind: 'serve',
        dbPath: join(directory, 'demo.db'),
        bootstrapDirectory: join(directory, 'bootstrap'),
        workspaceId: 'explicit-workspace',
        port: Number(port)
      });
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('owner-control CLI rejects the complete command-specific invalid-form matrix', () => {
  const directory = createDirectory();
  const invalid = [
    ['help'],
    ['--help', 'extra'],
    ['unknown'],
    ['init-demo'],
    ['init-demo', '--db'],
    ['init-demo', '--db', ''],
    ['init-demo', '--db', ':memory:'],
    ['init-demo', '--db=demo.db'],
    ['init-demo', '--db', 'one.db', '--db', 'two.db'],
    ['init-demo', '--db', 'demo.db', '--workspace', 'extra'],
    ['init-demo', 'demo.db'],
    ['serve'],
    ['serve', '--db', 'demo.db'],
    ['serve', '--bootstrap-dir', 'bootstrap'],
    ['serve', '--db', '', '--bootstrap-dir', 'bootstrap'],
    ['serve', '--db', 'demo.db', '--bootstrap-dir', ''],
    ['serve', '--db', ':memory:', '--bootstrap-dir', 'bootstrap'],
    ['serve', '--db', 'demo.db', '--bootstrap-dir', ':memory:'],
    ['serve', '--db=demo.db', '--bootstrap-dir', 'bootstrap'],
    ['serve', '--db', 'demo.db', '--bootstrap-dir=bootstrap'],
    ['serve', '--db', 'one.db', '--db', 'two.db', '--bootstrap-dir', 'bootstrap'],
    ['serve', '--db', 'demo.db', '--bootstrap-dir', 'one', '--bootstrap-dir', 'two'],
    ['serve', '--db', 'demo.db', '--bootstrap-dir', 'bootstrap', '--workspace', ''],
    ['serve', '--db', 'demo.db', '--bootstrap-dir', 'bootstrap', '--host', '0.0.0.0'],
    ['serve', '--db', 'demo.db', '--bootstrap-dir', 'bootstrap', 'positional'],
    ['serve', '--db', 'demo.db', '--bootstrap-dir', 'bootstrap', '--port'],
    ['serve', '--db', 'demo.db', '--bootstrap-dir', 'bootstrap', '--port', '-1'],
    ['serve', '--db', 'demo.db', '--bootstrap-dir', 'bootstrap', '--port', '1.5'],
    ['serve', '--db', 'demo.db', '--bootstrap-dir', 'bootstrap', '--port', '01'],
    ['serve', '--db', 'demo.db', '--bootstrap-dir', 'bootstrap', '--port', '65536'],
    ['serve', '--db', 'demo.db', '--bootstrap-dir', 'bootstrap', '--port', 'Infinity']
  ];
  try {
    for (const argv of invalid) {
      assert.throws(
        () => parseOwnerControlArgs(argv, directory),
        undefined,
        `accepted invalid arguments: ${JSON.stringify(argv)}`
      );
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('init-demo creates the exact synthetic workspace, works, and proposed commands once', async () => {
  const directory = createDirectory();
  const dbPath = join(directory, 'demo.db');
  try {
    const fixture = await initializeOwnerControlDemo(dbPath);
    assert.equal(fixture.dbPath, dbPath);
    assert.equal(fixture.workspaceId, 'owner-control-demo');
    assert.equal(fixture.ownerId, 'owner');

    const store = new SqliteStore(dbPath, { readOnly: true });
    try {
      const state = store.state('owner-control-demo');
      assert.equal(state.ownerId, 'owner');
      assert.equal(state.version, 6);
      assert.deepEqual(Object.keys(state.works).sort(), ['contact-work', 'subscription-work']);
      assert.deepEqual(state.works['contact-work'], {
        id: 'contact-work',
        title: 'Update synthetic contact',
        goal: 'Set the synthetic email',
        phase: 'open',
        revision: 1,
        threadIds: ['owner-control-contact'],
        evidenceRefs: []
      });
      assert.deepEqual(state.works['subscription-work'], {
        id: 'subscription-work',
        title: 'Cancel synthetic subscription',
        goal: 'Cancel the synthetic plan',
        phase: 'open',
        revision: 1,
        threadIds: ['owner-control-subscription'],
        evidenceRefs: []
      });

      const actions = [
        state.actions[fixture.approveActionId],
        state.actions[fixture.cancelActionId]
      ];
      assert.equal(Object.keys(state.actions).length, 2);
      assert.deepEqual(actions.map(action => action.status), ['proposed', 'proposed']);
      assert.deepEqual(actions.map(action => action.workRevision), [1, 1]);
      assert.deepEqual(actions.map(action => action.key), [
        'owner-control-demo:owner-control-contact',
        'owner-control-demo:owner-control-subscription'
      ]);

      const contact = actions[0].command;
      assert.deepEqual(contact, {
        kind: 'operation.execute',
        operationId: 'contact.update',
        operationVersion: '1',
        connectionId: 'synthetic-account',
        provider: 'synthetic-accounts',
        subject: 'synthetic-person',
        connectionGeneration: 1,
        resourceId: 'contact-profile',
        arguments: { email: 'owner-control@example.test' },
        affectedResourceIds: ['contact-profile'],
        precondition: {
          state: { kind: 'contact-profile', email: 'synthetic@example.test', locale: 'en-US' },
          source: 'synthetic-contact-readback',
          observedAt: contact.precondition.observedAt,
          providerVersion: 'contact:1'
        },
        expectedResult: {
          kind: 'contact-profile', email: 'owner-control@example.test', locale: 'en-US'
        },
        subjectRevision: 0,
        requestFingerprint: contact.requestFingerprint
      });
      assert.match(contact.precondition.observedAt, /^\d{4}-\d{2}-\d{2}T/);
      assert.match(contact.requestFingerprint, /^[a-f0-9]{64}$/);

      const subscription = actions[1].command;
      assert.deepEqual(subscription, {
        kind: 'operation.execute',
        operationId: 'subscription.cancel',
        operationVersion: '1',
        connectionId: 'synthetic-account',
        provider: 'synthetic-accounts',
        subject: 'synthetic-person',
        connectionGeneration: 1,
        resourceId: 'subscription',
        arguments: { reason: 'Synthetic owner-control demonstration' },
        affectedResourceIds: ['subscription'],
        precondition: {
          state: {
            kind: 'subscription',
            plan: 'Synthetic demo plan',
            status: 'active',
            cancellationReason: null
          },
          source: 'synthetic-subscription-readback',
          observedAt: subscription.precondition.observedAt,
          providerVersion: 'subscription:1'
        },
        expectedResult: {
          kind: 'subscription',
          plan: 'Synthetic demo plan',
          status: 'cancelled',
          cancellationReason: 'Synthetic owner-control demonstration'
        },
        subjectRevision: 0,
        requestFingerprint: subscription.requestFingerprint
      });
      assert.match(subscription.precondition.observedAt, /^\d{4}-\d{2}-\d{2}T/);
      assert.match(subscription.requestFingerprint, /^[a-f0-9]{64}$/);
    } finally {
      store.close();
    }

    await assert.rejects(
      initializeOwnerControlDemo(dbPath),
      /already exists or is incomplete/i
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('init-demo preserves every existing or dangling path in both SQLite families', async () => {
  const directory = createDirectory();
  try {
    for (const [kind, dangling] of [['file', false], ['dangling symlink', true]]) {
      for (const suffix of FIXTURE_SUFFIXES) {
        const stem = suffix.replaceAll('.', '_').replaceAll('-', '_') || 'main';
        const dbPath = join(directory, `${kind.replace(' ', '-')}-${stem}.db`);
        const target = `${dbPath}${suffix}`;
        if (dangling) symlinkSync(`missing-${stem}`, target);
        else writeFileSync(target, `canary-${stem}`, { mode: 0o600 });

        await assert.rejects(
          initializeOwnerControlDemo(dbPath),
          undefined,
          `${kind} was accepted for suffix ${suffix}`
        );
        if (dangling) {
          assert.ok(lstatSync(target).isSymbolicLink());
          assert.equal(readlinkSync(target), `missing-${stem}`);
        } else {
          assert.equal(readFileSync(target, 'utf8'), `canary-${stem}`);
        }
      }
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('injected abort removes its listener, bootstrap, and process lock and permits restart', { skip: !POSIX }, async () => {
  const directory = createDirectory();
  const dbPath = join(directory, 'demo.db');
  const bootstrapDirectory = join(directory, 'bootstrap');
  const controller = new AbortController();
  const abortListeners = getEventListeners(controller.signal, 'abort').length;
  const sigintListeners = getEventListeners(process, 'SIGINT').length;
  const sigtermListeners = getEventListeners(process, 'SIGTERM').length;
  let publishedPath;
  let scheduledAbort;
  let scheduledAssertionError;
  let liveListenerObserved = false;
  let invocation;
  try {
    await initializeOwnerControlDemo(dbPath);
    const captured = captureDependencies({
      signal: controller.signal,
      writeStdout(text) {
        captured.output.stdout += text;
        const match = /^Bootstrap file: (.+)$/m.exec(captured.output.stdout);
        if (match && scheduledAbort === undefined) {
          publishedPath = JSON.parse(match[1]);
          scheduledAbort = setImmediate(() => {
            scheduledAbort = undefined;
            try {
              assert.equal(
                getEventListeners(controller.signal, 'abort').length,
                abortListeners + 1
              );
              liveListenerObserved = true;
            } catch (error) {
              scheduledAssertionError = error;
            } finally {
              controller.abort();
            }
          });
        }
      }
    });

    invocation = runOwnerControlCli([
      'serve', '--db', dbPath, '--bootstrap-dir', bootstrapDirectory
    ], captured.dependencies);
    assert.equal(await withTimeout(invocation, 'injected abort did not settle'), 0);
    if (scheduledAssertionError) throw scheduledAssertionError;
    assert.equal(liveListenerObserved, true);
    assert.equal(captured.output.stderr, '');
    assert.match(captured.output.stdout, /Local synthetic owner control:/);
    assert.equal(getEventListeners(controller.signal, 'abort').length, abortListeners);
    assert.equal(getEventListeners(process, 'SIGINT').length, sigintListeners);
    assert.equal(getEventListeners(process, 'SIGTERM').length, sigtermListeners);
    assert.equal(existsSync(publishedPath), false);
    assert.equal(existsSync(`${dbPath}.behalvo-lock`), false);

    const restart = new AbortController();
    const restarted = captureDependencies({
      signal: restart.signal,
      writeStdout(text) {
        restarted.output.stdout += text;
        restart.abort();
      }
    });
    assert.equal(await runOwnerControlCli([
      'serve', '--db', dbPath, '--bootstrap-dir', join(directory, 'restart-bootstrap')
    ], restarted.dependencies), 0);
  } finally {
    if (scheduledAbort !== undefined) clearImmediate(scheduledAbort);
    if (!controller.signal.aborted) controller.abort();
    if (invocation) {
      await withTimeout(
        invocation.catch(() => undefined),
        'injected-abort cleanup did not settle',
        2_000
      );
    }
    rmSync(directory, { recursive: true, force: true });
  }
});

test('an already-aborted serve does not acquire resources or print ready output', { skip: !POSIX }, async () => {
  const directory = createDirectory();
  const dbPath = join(directory, 'demo.db');
  const bootstrapDirectory = join(directory, 'bootstrap');
  const controller = new AbortController();
  controller.abort();
  const abortListeners = getEventListeners(controller.signal, 'abort').length;
  const sigintListeners = getEventListeners(process, 'SIGINT').length;
  const sigtermListeners = getEventListeners(process, 'SIGTERM').length;
  try {
    await initializeOwnerControlDemo(dbPath);
    const captured = captureDependencies({ signal: controller.signal });
    assert.equal(await withTimeout(runOwnerControlCli([
      'serve', '--db', dbPath, '--bootstrap-dir', bootstrapDirectory
    ], captured.dependencies), 'already-aborted serve did not settle', 2_000), 0);
    assert.equal(captured.output.stdout, '');
    assert.equal(captured.output.stderr, '');
    assert.equal(getEventListeners(controller.signal, 'abort').length, abortListeners);
    assert.equal(getEventListeners(process, 'SIGINT').length, sigintListeners);
    assert.equal(getEventListeners(process, 'SIGTERM').length, sigtermListeners);
    assert.equal(existsSync(bootstrapDirectory), false);
    assert.equal(existsSync(`${dbPath}.behalvo-lock`), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('serve startup failure closes in bounded time and releases the process lock', { skip: !POSIX }, async () => {
  const directory = createDirectory();
  const dbPath = join(directory, 'demo.db');
  const unsafeBootstrap = join(directory, 'unsafe-bootstrap');
  const sigintListeners = getEventListeners(process, 'SIGINT').length;
  const sigtermListeners = getEventListeners(process, 'SIGTERM').length;
  try {
    await initializeOwnerControlDemo(dbPath);
    mkdirSync(unsafeBootstrap, { mode: 0o755 });
    chmodSync(unsafeBootstrap, 0o755);
    const failed = captureDependencies();
    const code = await withTimeout(runOwnerControlCli([
      'serve', '--db', dbPath, '--bootstrap-dir', unsafeBootstrap
    ], failed.dependencies), 'serve startup failure did not settle', 2_000);
    assert.equal(code, 1);
    assert.equal(failed.output.stdout, '');
    assert.equal(failed.output.stderr, 'Owner control server failed.\n');
    assert.equal(existsSync(`${dbPath}.behalvo-lock`), false);
    assert.equal(getEventListeners(process, 'SIGINT').length, sigintListeners);
    assert.equal(getEventListeners(process, 'SIGTERM').length, sigtermListeners);

    const controller = new AbortController();
    const restarted = captureDependencies({
      signal: controller.signal,
      writeStdout(text) {
        restarted.output.stdout += text;
        controller.abort();
      }
    });
    assert.equal(await runOwnerControlCli([
      'serve', '--db', dbPath, '--bootstrap-dir', join(directory, 'valid-bootstrap')
    ], restarted.dependencies), 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('SIGINT and SIGTERM during startup stop before ready and clean acquired resources', { skip: !POSIX }, async () => {
  const directory = createDirectory('behalvo startup signal ');
  const dbPath = join(directory, 'demo.db');
  const owned = [];
  try {
    await initializeOwnerControlDemo(dbPath);
    const cliPath = copyStartupPausedCli(directory);
    for (const signal of ['SIGINT', 'SIGTERM']) {
      const bootstrapDirectory = join(directory, `bootstrap-${signal}`);
      const serving = spawnCli([
        'serve', '--db', dbPath, '--bootstrap-dir', bootstrapDirectory
      ], { cwd: directory, env: process.env, cliPath });
      owned.push(serving);
      await waitForOutput(serving, 'TEST_STARTUP_PAUSED:');
      const match = /^TEST_STARTUP_PAUSED: (.+)$/m.exec(serving.stdout);
      assert.ok(match);
      const publishedPath = JSON.parse(match[1]);
      assert.equal(existsSync(`${dbPath}.behalvo-lock`), true);
      assert.equal(existsSync(publishedPath), true);

      serving.child.kill(signal);
      const stopped = await withTimeout(
        serving.completion,
        `owner-control CLI did not stop during startup after ${signal}`,
        2_000
      );
      assert.equal(stopped.error, null);
      assert.equal(stopped.code, 0, stopped.stderr);
      assert.equal(stopped.signal, null);
      assert.equal(stripExactNode22SqliteWarning(stopped.stderr), '');
      assert.equal(stopped.stdout.includes('Local synthetic owner control:'), false);
      assert.equal(stopped.stdout.includes('Bootstrap file:'), false);
      assert.equal(existsSync(publishedPath), false);
      assert.equal(existsSync(`${dbPath}.behalvo-lock`), false);
      assert.deepEqual(readdirSync(bootstrapDirectory), []);
    }

    const restart = spawnCli([
      'serve', '--db', dbPath, '--bootstrap-dir', join(directory, 'restart-bootstrap')
    ], { cwd: directory, env: process.env });
    owned.push(restart);
    await waitForOutput(restart, 'Local synthetic owner control:');
    restart.child.kill('SIGTERM');
    const restarted = await withTimeout(restart.completion, 'restart did not stop', 2_000);
    assert.equal(restarted.code, 0, restarted.stderr);
    assert.equal(restarted.signal, null);
    assert.equal(stripExactNode22SqliteWarning(restarted.stderr), '');
    assert.equal(existsSync(`${dbPath}.behalvo-lock`), false);
  } finally {
    for (const handle of owned) {
      if (handle.child.exitCode === null && handle.child.signalCode === null) {
        await stopOwnedChild(handle);
      } else {
        await withTimeout(handle.completion, 'owner-control CLI pipes did not close', 2_000);
      }
    }
    rmSync(directory, { recursive: true, force: true });
  }
});

test('real SIGINT and SIGTERM children from a spaced cwd preserve auth and settings canaries', { skip: !POSIX }, async () => {
  const directory = createDirectory('behalvo spaced owner control ');
  const dbPath = join(directory, 'owner-control.db');
  const dataDirectory = join(directory, 'data');
  const configuredDirectory = join(directory, 'configured');
  mkdirSync(dataDirectory, { mode: 0o700 });
  mkdirSync(configuredDirectory, { mode: 0o700 });

  const canaries = new Map([
    [join(dataDirectory, 'pi-auth.json'), 'ORDINARY_AUTH_FILE_CANARY'],
    [join(dataDirectory, 'agent.db.settings.json'), 'ORDINARY_SETTINGS_FILE_CANARY'],
    [`${dbPath}.settings.json`, 'CONFIGURED_DB_SETTINGS_FILE_CANARY'],
    [join(configuredDirectory, 'behalvo-auth.json'), 'BEHALVO_AUTH_FILE_CANARY'],
    [join(configuredDirectory, 'operator-auth.json'), 'OPERATOR_AUTH_FILE_CANARY'],
    [join(configuredDirectory, 'storage-key.json'), 'STORAGE_KEY_FILE_CANARY']
  ]);
  for (const [path, contents] of canaries) writeFileSync(path, contents, { mode: 0o600 });
  const canarySnapshots = new Map([...canaries].map(([path, contents]) => {
    const stat = lstatSync(path);
    return [path, {
      contents,
      device: stat.dev,
      inode: stat.ino,
      mode: stat.mode,
      size: stat.size,
      modified: stat.mtimeMs
    }];
  }));

  const environmentMarkers = [
    'BEHALVO_MODEL_ENV_CANARY',
    'OPERATOR_MODEL_ENV_CANARY',
    'BEHALVO_DB_ENV_CANARY',
    'OPERATOR_DB_ENV_CANARY',
    'BEHALVO_WORKSPACE_ENV_CANARY',
    'OPERATOR_WORKSPACE_ENV_CANARY'
  ];
  const env = {
    ...process.env,
    BEHALVO_MODEL: environmentMarkers[0],
    OPERATOR_MODEL: environmentMarkers[1],
    BEHALVO_DB: environmentMarkers[2],
    OPERATOR_DB: environmentMarkers[3],
    BEHALVO_WORKSPACE: environmentMarkers[4],
    OPERATOR_WORKSPACE: environmentMarkers[5],
    BEHALVO_PI_AUTH: join(configuredDirectory, 'behalvo-auth.json'),
    OPERATOR_PI_AUTH: join(configuredDirectory, 'operator-auth.json'),
    BEHALVO_STORAGE_KEY_FILE: join(configuredDirectory, 'storage-key.json')
  };
  const owned = [];
  const capturedOutput = [];

  try {
    const initialized = await completedChild([
      'init-demo', '--db', 'owner-control.db'
    ], { cwd: directory, env }, owned);
    capturedOutput.push(initialized.stdout, initialized.stderr);
    assert.equal(initialized.error, null);
    assert.equal(initialized.code, 0, initialized.stderr);
    assert.equal(stripExactNode22SqliteWarning(initialized.stderr), '');
    assert.equal(initialized.stdout,
      'Synthetic owner-control demo initialized for owner-control-demo.\n');

    for (const signal of ['SIGINT', 'SIGTERM']) {
      const bootstrapDirectory = join(directory, `bootstrap ${signal}`);
      const serving = spawnCli([
        'serve', '--db', 'owner-control.db', '--bootstrap-dir', `bootstrap ${signal}`
      ], { cwd: directory, env });
      owned.push(serving);
      await waitForOutput(serving, 'Local synthetic owner control:');
      const publishedPath = bootstrapPath(serving.stdout);
      assert.equal(existsSync(publishedPath), true);

      if (signal === 'SIGINT') {
        const refused = await completedChild([
          'serve', '--db', 'owner-control.db', '--bootstrap-dir', 'refused bootstrap'
        ], { cwd: directory, env }, owned);
        capturedOutput.push(refused.stdout, refused.stderr);
        assert.equal(refused.error, null);
        assert.equal(refused.code, 1);
        assert.equal(refused.stdout, '');
        assert.equal(stripExactNode22SqliteWarning(refused.stderr),
          'Owner control command failed.\n');
      }

      serving.child.kill(signal);
      const stopped = await withTimeout(serving.completion,
        `owner-control CLI did not stop after ${signal}`);
      capturedOutput.push(stopped.stdout, stopped.stderr);
      assert.equal(stopped.error, null);
      assert.equal(stopped.code, 0, stopped.stderr);
      assert.equal(stopped.signal, null);
      assert.equal(stripExactNode22SqliteWarning(stopped.stderr), '');
      assert.equal(existsSync(publishedPath), false);
      assert.equal(existsSync(`${dbPath}.behalvo-lock`), false);
      assert.deepEqual(readdirSync(bootstrapDirectory), []);
    }

    for (const [path, snapshot] of canarySnapshots) {
      const stat = lstatSync(path);
      assert.equal(readFileSync(path, 'utf8'), snapshot.contents);
      assert.deepEqual({
        device: stat.dev,
        inode: stat.ino,
        mode: stat.mode,
        size: stat.size,
        modified: stat.mtimeMs
      }, {
        device: snapshot.device,
        inode: snapshot.inode,
        mode: snapshot.mode,
        size: snapshot.size,
        modified: snapshot.modified
      });
    }
    const allOutput = capturedOutput.join('\n');
    for (const marker of [...canaries.values(), ...environmentMarkers, ...canaries.keys()]) {
      assert.equal(allOutput.includes(marker), false, `canary disclosed: ${marker}`);
    }
  } finally {
    for (const handle of owned) {
      if (handle.child.exitCode === null && handle.child.signalCode === null) {
        await stopOwnedChild(handle);
      } else {
        await withTimeout(handle.completion, 'owner-control CLI pipes did not close', 2_000);
      }
    }
    rmSync(directory, { recursive: true, force: true });
  }
});
