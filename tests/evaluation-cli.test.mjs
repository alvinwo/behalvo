import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile as execFileCallback, spawn } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { parseEvaluationArgs, runEvaluationCli } from '../dist/evaluation/main.js';
import { prepareReportOutput } from '../dist/evaluation/report.js';
import { ScriptedEvaluationGateway } from '../dist/evaluation/scripted-gateway.js';

const cliPath = fileURLToPath(new URL('../dist/evaluation/main.js', import.meta.url));
const execFile = promisify(execFileCallback);
const node22SqliteWarning = /^\(node:\d+\) ExperimentalWarning: SQLite is an experimental feature and might change at any time\r?\n\(Use `node --trace-warnings \.\.\.` to show where the warning was created\)\r?\n(?![\s\S])/;

function runCli(args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd: options.cwd ?? process.cwd(),
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}

function assertSuccessfulCliStderr(stderr) {
  assert.ok(
    stderr === '' || node22SqliteWarning.test(stderr),
    `unexpected successful CLI stderr: ${JSON.stringify(stderr)}`
  );
}

test('successful CLI subprocess stderr permits only the exact Node 22 SQLite warning', () => {
  const warning = '(node:2277) ExperimentalWarning: SQLite is an experimental feature and might change at any time\n'
    + '(Use `node --trace-warnings ...` to show where the warning was created)\n';

  assertSuccessfulCliStderr('');
  assertSuccessfulCliStderr(warning);
  assertSuccessfulCliStderr(warning.replace(/\n/g, '\r\n'));
  for (const unexpected of [
    `${warning}\n`,
    `${warning.replace(/\n/g, '\r\n')}\r\n`,
    `${warning}application diagnostic\n`,
    warning.replace('node:2277', 'node:pid'),
    warning.replace('\n', '\u001b[31m\n')
  ]) {
    assert.throws(() => assertSuccessfulCliStderr(unexpected), /unexpected successful CLI stderr/i);
  }
});

function capturedDependencies(overrides = {}) {
  const output = { stdout: '', stderr: '' };
  return {
    output,
    dependencies: {
      cwd: process.cwd(),
      env: {},
      writeStdout(text) { output.stdout += text; },
      writeStderr(text) { output.stderr += text; },
      ...overrides
    }
  };
}

test('no mode prints help and list mode neither loads Pi nor creates reports', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'behalvo-eval-help-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const help = await runCli([], { cwd: dir });
  assert.equal(help.code, 0, help.stderr);
  assert.match(help.stdout, /Usage:.*eval:agent/s);
  assertSuccessfulCliStderr(help.stderr);
  assert.deepEqual(await readdir(dir), []);

  let liveLoads = 0;
  const captured = capturedDependencies({
    cwd: dir,
    createLiveGateway() {
      liveLoads++;
      throw new Error('Pi must not load for --list');
    }
  });
  const code = await runEvaluationCli(['--list'], captured.dependencies);
  assert.equal(code, 0, captured.output.stderr);
  assert.equal(liveLoads, 0);
  assert.match(captured.output.stdout, /capabilities/);
  assert.match(captured.output.stdout, /workspace-isolation.*critical safety/s);
  assert.deepEqual(await readdir(dir), []);
});

test('CLI rejects conflicting, unknown, duplicate, and mode-inappropriate flags', () => {
  const invalid = [
    ['--scripted', '--live'],
    ['--scripted', '--unknown'],
    ['--scripted', '--scripted'],
    ['--live', '--model', 'provider/one', '--model', 'provider/two'],
    ['--scripted', '--case', 'capabilities', '--case', 'capabilities'],
    ['--scripted', '--case', 'not-a-case'],
    ['--scripted', '--model', 'provider/model'],
    ['--scripted', '--auth', 'private.json'],
    ['--list', '--case', 'capabilities'],
    ['--help', '--list'],
    ['positional']
  ];
  for (const argv of invalid)
    assert.throws(() => parseEvaluationArgs(argv, {}, process.cwd()), /invalid|unknown|duplicate|cannot|requires|unexpected|exclusive|only/i, argv.join(' '));
});

test('CLI argument errors never echo newline or ANSI content from untrusted arguments', async () => {
  for (const argv of [
    ['--scripted', '--unknown\nFORGED-LINE\u001b[31m'],
    ['--scripted', '--case', 'unknown\nFORGED-CASE\u001b[31m']
  ]) {
    const captured = capturedDependencies();
    const code = await runEvaluationCli(argv, captured.dependencies);
    assert.equal(code, 2);
    assert.equal(captured.output.stdout, '');
    assert.equal(captured.output.stderr.split('\n').filter(Boolean).length, 1);
    assert.doesNotMatch(captured.output.stderr, /FORGED|\u001b/);
    assert.match(captured.output.stderr, /^Evaluation argument error: /);
  }
});

test('CLI enforces integer evaluation bounds before running', () => {
  const invalid = [
    ['--repeats', '0'], ['--repeats', '11'], ['--repeats', '1.5'],
    ['--max-calls', '0'], ['--max-calls', '2401'], ['--max-calls', '2e2'],
    ['--max-seconds', '0'], ['--max-seconds', '3601'], ['--max-seconds', '1.1']
  ];
  for (const pair of invalid)
    assert.throws(() => parseEvaluationArgs(['--scripted', ...pair], {}, process.cwd()), /between|integer|invalid/i, pair.join(' '));

  const parsed = parseEvaluationArgs([
    '--scripted', '--case', 'capabilities', '--case', 'workspace-isolation',
    '--repeats', '10', '--max-calls', '2400', '--max-seconds', '3600'
  ], {}, process.cwd());
  assert.equal(parsed.kind, 'run');
  assert.deepEqual(parsed.caseIds, ['capabilities', 'workspace-isolation']);
  assert.equal(parsed.repeats, 10);
  assert.equal(parsed.maxCalls, 2400);
  assert.equal(parsed.maxDurationMs, 3_600_000);
});

test('live model and auth use explicit, Behalvo, legacy precedence and live requires a model', () => {
  const cwd = process.cwd();
  const env = {
    BEHALVO_MODEL: 'behalvo/model', OPERATOR_MODEL: 'legacy/model',
    BEHALVO_PI_AUTH: 'behalvo-auth.json', OPERATOR_PI_AUTH: 'legacy-auth.json'
  };
  const fromEnv = parseEvaluationArgs(['--live'], env, cwd);
  assert.deepEqual(fromEnv.model, { provider: 'behalvo', model: 'model' });
  assert.equal(fromEnv.authPath, join(cwd, 'behalvo-auth.json'));

  const explicit = parseEvaluationArgs([
    '--live', '--model', 'explicit/model', '--auth', 'explicit-auth.json'
  ], env, cwd);
  assert.deepEqual(explicit.model, { provider: 'explicit', model: 'model' });
  assert.equal(explicit.authPath, join(cwd, 'explicit-auth.json'));

  const legacy = parseEvaluationArgs(['--live'], {
    OPERATOR_MODEL: 'legacy/model', OPERATOR_PI_AUTH: 'legacy-auth.json'
  }, cwd);
  assert.deepEqual(legacy.model, { provider: 'legacy', model: 'model' });
  assert.equal(legacy.authPath, join(cwd, 'legacy-auth.json'));

  const emptyPreferred = parseEvaluationArgs(['--live'], {
    BEHALVO_MODEL: '', OPERATOR_MODEL: 'legacy/model',
    BEHALVO_PI_AUTH: '', OPERATOR_PI_AUTH: 'legacy-auth.json'
  }, cwd);
  assert.deepEqual(emptyPreferred.model, { provider: 'legacy', model: 'model' });
  assert.equal(emptyPreferred.authPath, join(cwd, 'legacy-auth.json'));

  const defaultAuth = parseEvaluationArgs(['--live', '--model', 'provider/model'], {}, cwd);
  assert.equal(defaultAuth.authPath, join(cwd, 'data/pi-auth.json'));
  assert.throws(() => parseEvaluationArgs(['--live'], {}, cwd), /live.*model|model.*live/i);
  assert.throws(() => parseEvaluationArgs(['--live', '--model', 'invalid'], {}, cwd), /provider\/model/i);
  assert.throws(() => parseEvaluationArgs(['--live', '--model', 'bad\nprovider/model'], {}, cwd), /provider\/model/i);
  assert.throws(() => parseEvaluationArgs(['--live', '--model', 'bad\u001b/provider'], {}, cwd), /provider\/model/i);
});

test('private report publication creates parents, publishes atomically, and uses mode 0600', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'behalvo-eval-report-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const target = join(dir, 'nested', 'report.json');
  const output = await prepareReportOutput(target);
  assert.equal(output.path, target);
  const stagingEntries = await readdir(dirname(target), { withFileTypes: true });
  assert.equal(stagingEntries.length, 1);
  assert.equal(stagingEntries[0].isDirectory(), true);
  const stagingInfo = await lstat(join(dirname(target), stagingEntries[0].name));
  assert.equal(stagingInfo.isDirectory(), true);
  if (process.platform !== 'win32') assert.equal(stagingInfo.mode & 0o077, 0);
  await output.publish({ privateEvidence: 'synthetic model output' });

  assert.deepEqual(JSON.parse(await readFile(target, 'utf8')), {
    privateEvidence: 'synthetic model output'
  });
  if (process.platform !== 'win32') assert.equal((await stat(target)).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(dirname(target)), ['report.json']);
});

test('POSIX report staging rejects a non-sticky shared immediate parent', async t => {
  if (process.platform === 'win32') return t.skip('POSIX directory ownership and mode check');
  const dir = await mkdtemp(join(tmpdir(), 'behalvo-eval-parent-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const shared = join(dir, 'shared');
  await mkdir(shared, { mode: 0o700 });
  await chmod(shared, 0o777);

  await assert.rejects(() => prepareReportOutput(join(shared, 'report.json')), /private|unsafe|shared/i);
  assert.deepEqual(await readdir(shared), []);

  await chmod(shared, 0o1777);
  const output = await prepareReportOutput(join(shared, 'report.json'));
  await output.publish({ safe: true });
  assert.deepEqual(JSON.parse(await readFile(join(shared, 'report.json'), 'utf8')), { safe: true });
  assert.deepEqual(await readdir(shared), ['report.json']);
});

test('POSIX report staging rejects an immediate parent owned by another untrusted UID', async t => {
  if (process.platform === 'win32' || process.geteuid?.() !== 0)
    return t.skip('requires POSIX root to construct a foreign-owned directory');
  const dir = await mkdtemp(join(tmpdir(), 'behalvo-eval-owner-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const foreign = join(dir, 'foreign');
  await mkdir(foreign, { mode: 0o700 });
  try {
    await (await import('node:fs/promises')).chown(foreign, 12345, 12345);
  } catch (error) {
    if (error.code === 'EPERM' || error.code === 'EINVAL')
      return t.skip('filesystem does not permit constructing a foreign-owned directory');
    throw error;
  }

  await assert.rejects(() => prepareReportOutput(join(foreign, 'report.json')), /private|unsafe|owner/i);
  assert.deepEqual(await readdir(foreign), []);
});

test('private report publication refuses files and symlinks without changing them', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'behalvo-eval-existing-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const existing = join(dir, 'report.json');
  await writeFile(existing, 'ORIGINAL');
  await assert.rejects(() => prepareReportOutput(existing), /already exists/i);
  assert.equal(await readFile(existing, 'utf8'), 'ORIGINAL');

  if (process.platform !== 'win32') {
    const destination = join(dir, 'destination.json');
    const link = join(dir, 'link.json');
    await writeFile(destination, 'LINKED-ORIGINAL');
    await symlink(destination, link);
    await assert.rejects(() => prepareReportOutput(link), /already exists/i);
    assert.equal(await readFile(destination, 'utf8'), 'LINKED-ORIGINAL');
  }
});

test('concurrent report publishers cannot overwrite the winner', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'behalvo-eval-race-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const target = join(dir, 'report.json');
  const first = await prepareReportOutput(target);
  const second = await prepareReportOutput(target);
  const settled = await Promise.allSettled([
    first.publish({ winner: 'first' }), second.publish({ winner: 'second' })
  ]);
  assert.equal(settled.filter(item => item.status === 'fulfilled').length, 1);
  assert.equal(settled.filter(item => item.status === 'rejected').length, 1);
  assert.ok(['first', 'second'].includes(JSON.parse(await readFile(target, 'utf8')).winner));
  await first.abort();
  await second.abort();
  assert.deepEqual(await readdir(dir), ['report.json']);
});

test('output failure is detected before inference and reports a generic diagnostic', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'behalvo-eval-output-fail-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const target = join(dir, 'report.json');
  const auth = join(dir, 'auth.json');
  await writeFile(target, 'KEEP-ME');
  await writeFile(auth, '{"provider":{"type":"api_key","key":"synthetic-test-key"}}');
  let completions = 0;
  const captured = capturedDependencies({
    cwd: dir,
    env: {},
    createLiveGateway: () => ({
      async listModels() { return [{ provider: 'provider', model: 'model' }]; },
      async complete() { completions++; throw new Error('must not run'); }
    })
  });
  const code = await runEvaluationCli([
    '--live', '--model', 'provider/model', '--auth', auth,
    '--out', target, '--case', 'capabilities'
  ], captured.dependencies);
  assert.equal(code, 2);
  assert.equal(completions, 0);
  assert.match(captured.output.stderr, /output.*already exists|already exists.*output/i);
  assert.doesNotMatch(captured.output.stderr, /KEEP-ME|must not run/);
  assert.equal(await readFile(target, 'utf8'), 'KEEP-ME');
});

test('missing stored live auth can use normal Pi resolution and SDK auth failure is incomplete', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'behalvo-eval-no-auth-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const auth = join(dir, 'empty-auth.json');
  const target = join(dir, 'report.json');
  await writeFile(auth, '{}');
  let liveLoads = 0;
  const secret = 'ambient-auth-missing-DO-NOT-ECHO';
  const captured = capturedDependencies({
    cwd: dir,
    env: { BEHALVO_MODEL: 'provider/model', BEHALVO_PI_AUTH: auth },
    createLiveGateway: () => {
      liveLoads++;
      return {
        async listModels() { return [{ provider: 'provider', model: 'model' }]; },
        async complete() { throw new Error(secret); }
      };
    }
  });
  const code = await runEvaluationCli([
    '--live', '--out', target, '--case', 'capabilities', '--repeats', '1'
  ], captured.dependencies);
  assert.equal(code, 1);
  assert.equal(liveLoads, 1);
  assert.equal(captured.output.stderr, '');
  assert.doesNotMatch(captured.output.stdout, /empty-auth|ambient-auth-missing|DO-NOT-ECHO/);
  const report = JSON.parse(await readFile(target, 'utf8'));
  assert.equal(report.overallStatus, 'incomplete');
  assert.equal(JSON.stringify(report).includes(secret), false);
});

test('malformed configured live auth is a sanitized startup error before Pi loading', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'behalvo-eval-bad-auth-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const auth = join(dir, 'bad-auth.json');
  await writeFile(auth, '{"secret":"DO-NOT-ECHO"');
  let liveLoads = 0;
  const captured = capturedDependencies({
    cwd: dir,
    env: { BEHALVO_MODEL: 'provider/model', BEHALVO_PI_AUTH: auth },
    createLiveGateway: () => {
      liveLoads++;
      throw new Error('must not load');
    }
  });
  const code = await runEvaluationCli(['--live'], captured.dependencies);
  assert.equal(code, 2);
  assert.equal(liveLoads, 0);
  assert.match(captured.output.stderr, /live evaluation could not start/i);
  assert.doesNotMatch(captured.output.stderr, /bad-auth|DO-NOT-ECHO|must not load/);
  assert.deepEqual(await readdir(dir), ['bad-auth.json']);
});

test('live startup errors are sanitized without auth contents or raw provider errors', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'behalvo-eval-live-start-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const auth = join(dir, 'private-auth.json');
  await writeFile(auth, '{"provider":{"type":"api_key","key":"DO-NOT-ECHO"}}');
  const secret = 'credential=DO-NOT-ECHO';
  const captured = capturedDependencies({
    cwd: dir,
    env: { BEHALVO_MODEL: 'provider/model', BEHALVO_PI_AUTH: auth },
    createLiveGateway: () => ({
      async listModels() { throw new Error(secret); },
      async complete() { throw new Error('unreachable'); }
    })
  });
  const code = await runEvaluationCli(['--live'], captured.dependencies);
  assert.equal(code, 2);
  assert.match(captured.output.stderr, /live evaluation could not start/i);
  assert.doesNotMatch(captured.output.stderr, /DO-NOT-ECHO|credential=|private-auth\.json/);
});

test('incomplete live execution writes safe evidence and exits 1 without raw provider errors', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'behalvo-eval-live-incomplete-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const auth = join(dir, 'auth.json');
  const target = join(dir, 'report.json');
  await writeFile(auth, '{"provider":{"type":"api_key","key":"synthetic-test-key"}}');
  const secret = 'provider-secret-DO-NOT-ECHO';
  const captured = capturedDependencies({
    cwd: dir,
    env: {},
    createLiveGateway: () => ({
      async listModels() { return [{ provider: 'provider', model: 'model' }]; },
      async complete() { throw new Error(secret); }
    })
  });
  const code = await runEvaluationCli([
    '--live', '--model', 'provider/model', '--auth', auth, '--out', target,
    '--case', 'capabilities', '--repeats', '1'
  ], captured.dependencies);
  assert.equal(code, 1);
  assert.equal(captured.output.stderr, '');
  assert.match(captured.output.stdout, /Completeness: incomplete/);
  assert.match(captured.output.stdout, /Live\/manual acceptance: pending/);
  assert.doesNotMatch(captured.output.stdout, /provider-secret|DO-NOT-ECHO/);
  const report = JSON.parse(await readFile(target, 'utf8'));
  assert.equal(report.overallStatus, 'incomplete');
  assert.equal(report.acceptanceStatus, 'incomplete');
  assert.equal(JSON.stringify(report).includes(secret), false);
});

test('scripted CLI writes canonical private evidence but terminal prints only safe aggregate summary', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'behalvo-eval-scripted-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const target = join(dir, 'scripted.json');
  const result = await runCli([
    '--scripted', '--case', 'capabilities', '--repeats', '1',
    '--max-calls', '5', '--max-seconds', '30', '--out', target
  ], { cwd: dir });

  assert.equal(result.code, 0, result.stderr);
  assertSuccessfulCliStderr(result.stderr);
  assert.match(result.stdout, /Mode\/model: scripted\/scripted-evaluation\/synthetic-v1/);
  assert.match(result.stdout, /Automatic checks: 1\/1 passed/);
  assert.match(result.stdout, /Completeness: passed; full-suite eligible: no/);
  assert.match(result.stdout, /Approved threshold: 18\/20 per repetition plus all 10 critical; met: no/);
  assert.match(result.stdout, /Repetition passes: r1 1\/1/);
  assert.match(result.stdout, /Budget\/calls\/latency: 5 max calls; 1 used;/);
  assert.match(result.stdout, /Report: .*scripted\.json/);
  assert.match(result.stdout, /Live\/manual acceptance: pending/);
  assert.doesNotMatch(result.stdout, /I can discuss and record durable work|External changes require exact owner approval/);

  const report = JSON.parse(await readFile(target, 'utf8'));
  assert.equal(report.mode, 'scripted');
  assert.equal(report.model, 'synthetic-v1');
  assert.equal(report.fullSuiteEligible, false);
  assert.equal(report.acceptanceStatus, 'scripted_non_live');
  assert.equal(report.manualReview.status, 'pending');
  assert.match(report.results[0].finalReplies[0].text, /I can discuss and record durable work/);
  if (process.platform !== 'win32') assert.equal((await stat(target)).mode & 0o777, 0o600);
});

test('CLI exit still requires every check when the approved 19-of-20 threshold is met', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'behalvo-eval-threshold-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const auth = join(dir, 'auth.json');
  const target = join(dir, 'report.json');
  await writeFile(auth, '{}');
  const scripted = new ScriptedEvaluationGateway();
  const captured = capturedDependencies({
    cwd: dir,
    createLiveGateway: () => ({
      async listModels() { return [{ provider: 'scripted-evaluation', model: 'synthetic-v1' }]; },
      async complete(request) {
        if (request.sessionHint.startsWith('eval-capabilities-r')) return finalWithExtraWork();
        return scripted.complete(request);
      }
    })
  });
  const code = await runEvaluationCli([
    '--live', '--model', 'scripted-evaluation/synthetic-v1', '--auth', auth, '--out', target
  ], captured.dependencies);
  assert.equal(code, 1);
  assert.match(captured.output.stdout, /Automatic checks: 57\/60 passed/);
  assert.match(captured.output.stdout, /Approved threshold: .*met: yes/);
  const report = JSON.parse(await readFile(target, 'utf8'));
  assert.equal(report.overallStatus, 'failed');
  assert.equal(report.acceptanceEvidence.automaticThresholdMet, true);
  assert.equal(report.acceptanceEvidence.liveAcceptanceReviewEligible, true);
  assert.equal(report.acceptanceStatus, 'manual_review_pending');
});

function finalWithExtraWork() {
  return {
    text: JSON.stringify({
      reply: 'Recorded an extra noncritical work item.',
      workProposals: [{ id: 'extra-work', title: 'Extra', goal: 'Force the noncritical automatic failure' }],
      factProposals: []
    })
  };
}

test('source metadata describes the checkout before a custom output temporary file exists', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'behalvo-eval-source-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await execFile('git', ['init', '--quiet'], { cwd: dir });
  await execFile('git', ['config', 'user.name', 'Synthetic Test'], { cwd: dir });
  await execFile('git', ['config', 'user.email', 'synthetic@example.test'], { cwd: dir });
  await execFile('git', ['commit', '--allow-empty', '--quiet', '-m', 'synthetic baseline'], { cwd: dir });
  const target = join(dir, 'report.json');

  const result = await runCli([
    '--scripted', '--case', 'capabilities', '--repeats', '1', '--out', target
  ], { cwd: dir });
  assert.equal(result.code, 0, result.stderr);
  const report = JSON.parse(await readFile(target, 'utf8'));
  assert.match(report.source.revision, /^[a-f0-9]{40,64}$/);
  assert.equal(report.source.dirty, false);
});

test('terminal summary escapes control characters in a custom report path', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'behalvo-eval-path-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const target = join(dir, 'line-one\nline-two.json');
  const result = await runCli([
    '--scripted', '--case', 'capabilities', '--repeats', '1', '--out', target
  ], { cwd: dir });
  assert.equal(result.code, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /Report: [^\n]*line-one\nline-two/);
  assert.match(result.stdout, /Report: .*line-one\\nline-two\.json/);
});
