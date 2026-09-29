import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { inspectPrivateProfileCustody } from '../dist/index.js';

const cases = ['SIGINT', 'SIGTERM'].flatMap(signal =>
  ['enrollment', 'inspected'].map(phase => [signal, phase]));
cases.push([null, 'failure']);
for (const [signal, phase] of cases) {
  test(`review R8: ${signal ?? 'non-signal failure'} during ${phase} drains CLI and retains custody for still-open synthetic Chrome`,
    { skip: process.platform === 'win32', timeout: 12_000 }, async t => {
      const root = mkdtempSync(join(tmpdir(), 'behalvo-signals-'));
      mkdirSync(join(root, 'profile'), { mode: 0o700 });
      const chromePath = join(root, 'chrome');
      writeFileSync(chromePath, `#!${process.execPath}\n` +
        `import { writeFileSync } from 'node:fs';\n` +
        `process.on('SIGTERM', () => {});\n` +
        `writeFileSync(${JSON.stringify(join(root, 'chrome-ready'))}, 'ready');\n` +
        `setInterval(() => {}, 1000);\n`, { mode: 0o700 });
      const child = spawn(process.execPath, ['tests/fixtures/chrome-signal-runner.mjs', root, phase, chromePath],
        { stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      child.stdout.on('data', chunk => { output += chunk; });
      child.stderr.on('data', chunk => { output += chunk; });
      const exited = new Promise(resolve => child.once('exit', (code, received) => resolve({ code, signal: received })));
      t.after(() => {
        child.kill('SIGKILL');
        if (existsSync(join(root, 'chrome-pid'))) {
          try { process.kill(Number(readFileSync(join(root, 'chrome-pid'), 'utf8')), 'SIGKILL'); } catch {}
        }
        rmSync(root, { recursive: true, force: true });
      });
      const deadline = Date.now() + 3000;
      while (!existsSync(join(root, 'coordinator-ready')) || !existsSync(join(root, 'chrome-ready'))) {
        if (Date.now() >= deadline) assert.fail(`fixture did not become ready: ${output}`);
        await delay(10);
      }
      if (signal) child.kill(signal);
      let timer;
      const observed = await Promise.race([exited, new Promise(resolve => {
        timer = setTimeout(() => resolve({ timeout: true }), 7500);
      })]).finally(() => clearTimeout(timer));
      assert.deepEqual(observed, { code: 1, signal: null });
      const result = JSON.parse(readFileSync(join(root, 'result.json'), 'utf8'));
      assert.equal(result.keyCleared, true);
      assert.ok(result.events.includes('service.shutdown'));
      assert.ok(result.events.includes('rendezvous.close'));
      assert.ok(result.events.includes('portal.close'));
      assert.ok(inspectPrivateProfileCustody(join(root, 'profile')));
      assert.match(output, /Chrome bridge cleanup pending\./);
      assert.doesNotMatch(output, /42,42,42|synthetic-document/);
    });
}
