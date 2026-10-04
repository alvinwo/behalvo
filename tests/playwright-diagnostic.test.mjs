import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { browserFixture, origin } from './helpers/playwright-fixture.mjs';
const module = await import('../dist/browser/playwright-diagnostic.js').catch(() => ({}));
function fixture(t, options = {}) {
  assert.equal(typeof module.runPlaywrightDiagnostic, 'function', 'diagnostic coordinator must exist');
  const f = browserFixture(); t.after(f.dispose); let portals = 0, closes = 0;
  const controller = new AbortController();
  const dependencies = { environment: {}, loadChromium: async () => f.chromium, setupTimeoutMs: 50, shutdownTimeoutMs: 60,
    startPortal: async () => { portals++; return { origin, close: async () => { closes++; } }; }, ...options };
  return { f, dependencies, controller, counts: () => ({ portals, closes }), run: async () => {
    const result = await module.runPlaywrightDiagnostic({ signal: controller.signal }, dependencies);
    if (result.receiptPath) t.after(() => rmSync(dirname(result.receiptPath), { recursive: true, force: true }));
    return result;
  } };
}
test('diagnostic validates login via BrowserSession and cleans all owned resources', async t => {
  const f = fixture(t); const result = await f.run();
  assert.equal(result.ok, true); assert.equal(result.snapshot.state, 'login'); assert.equal(result.cleanup, 'confirmed');
  assert.equal(f.f.reads(), 2); assert.deepEqual(f.counts(), { portals: 1, closes: 1 }); assert.equal(existsSync(f.f.profile), false);
});
test('diagnostic cancels a pending real session read, rejects late snapshot and closes portal', async t => {
  const f = fixture(t); f.f.readHook = () => new Promise(() => {}); const run = f.run();
  await new Promise(r => setImmediate(r)); f.controller.abort(); const result = await run;
  assert.equal(result.ok, false); assert.equal(result.code, 'cancelled'); assert.equal(f.counts().closes, 1);
});
test('diagnostic makes portal startup failure safe without launching browser', async t => {
  const f = fixture(t, { startPortal: async () => { throw Error('CANARY portal port occupied'); } });
  const result = await f.run(); assert.equal(result.ok, false); assert.equal(result.code, 'portal_failed');
  assert.equal(f.f.counts().launches, 0); assert.equal(JSON.stringify(result).includes('CANARY'), false);
});
test('diagnostic bounds hung portal cleanup and retains only fixed receipt fields', async t => {
  const f = fixture(t, { startPortal: async () => ({ origin, close: () => new Promise(() => {}) }) });
  const result = await f.run(); assert.equal(result.ok, false); assert.equal(result.cleanup, 'pending');
  assert.equal(existsSync(result.receiptPath), true);
  const receipt = JSON.parse(readFileSync(result.receiptPath, 'utf8'));
  assert.equal(receipt.cleanup, 'pending'); assert.deepEqual(Object.keys(receipt).sort(),
    ['browserPid', 'cleanup', 'code', 'phase', 'profilePath', 'runId', 'schemaVersion'].sort());
  assert.equal(JSON.stringify(receipt).includes('CANARY'), false);
});
test('diagnostic closes a late portal and never launches after cancellation', async t => {
  let resolve, closed = 0;
  const f = fixture(t, { startPortal: () => new Promise(r => { resolve = r; }) });
  const run = f.run(); await new Promise(r => setImmediate(r)); f.controller.abort();
  const result = await run; assert.equal(result.ok, false); assert.equal(result.cleanup, 'pending');
  resolve({ origin, close: async () => { closed++; } }); await new Promise(r => setImmediate(r));
  assert.equal(closed, 1); assert.equal(f.f.counts().launches, 0);
});
test('upstream exception and endpoint canaries never enter result or receipt', async t => {
  const f = fixture(t); f.f.launchHook = async () => { throw Error('CANARY-EXCEPTION ws://127.0.0.1/CANARY-ENDPOINT'); };
  const result = await f.run(); assert.equal(result.ok, false); assert.equal(result.cleanup, 'pending');
  assert.equal(JSON.stringify(result).includes('CANARY'), false);
  assert.equal(readFileSync(result.receiptPath, 'utf8').includes('CANARY'), false);
});
test('browser stderr and exception canaries never reach CLI output or private receipt', async t => {
  const { PassThrough } = await import('node:stream');
  const { runPlaywrightCli } = await import('../dist/cli/playwright-main.js');
  const f = fixture(t); f.f.proc.stderr = new PassThrough(); let output = '', stderrOutput = '';
  const previousWrite = process.stderr.write;
  process.stderr.write = function(chunk) { stderrOutput += chunk.toString(); return true; };
  t.after(() => { process.stderr.write = previousWrite; });
  f.f.readHook = async () => { f.f.proc.stderr.write('CANARY-BROWSER-STDERR'); throw Error('CANARY-EXCEPTION'); };
  let result;
  const code = await runPlaywrightCli(['diagnostic'], { diagnostic: async () => { result = await f.run(); return result; },
    writeStdout: value => { output += value; }, writeStderr: value => { output += value; } });
  assert.notEqual(code, 0); assert.equal((output + stderrOutput).includes('CANARY'), false);
  assert.equal(readFileSync(result.receiptPath, 'utf8').includes('CANARY'), false);
  process.stderr.write = previousWrite;
});
