import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

function runMain(args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['dist/cli/main.js', ...args], { cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

test('CLI main boots from an empty database in offline mode and accepts scripted input', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'behalvo-main-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const result = await runMain(['--offline', '--db', join(dir, 'agent.db')], '/model\n/quit\n');
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Behalvo/);
  assert.match(result.stdout, /offline\/deterministic/);
  assert.doesNotMatch(result.stderr, /Error:/);
});
