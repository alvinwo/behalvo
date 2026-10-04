import test from 'node:test';
import assert from 'node:assert/strict';
const module = await import('../dist/cli/playwright-main.js').catch(() => ({}));
async function run(argv, result, throws = false) {
  assert.equal(typeof module.runPlaywrightCli, 'function', 'P1 CLI must exist');
  let out = '', err = '', calls = 0;
  const code = await module.runPlaywrightCli(argv, { writeStdout: s => { out += s; }, writeStderr: s => { err += s; },
    diagnostic: async () => { calls++; if (throws) throw Error('CANARY'); return result; } });
  return { code, out, err, calls };
}
test('CLI rejects arbitrary browser options before any diagnostic', async () => {
  for (const args of [[], ['diagnostic', '--url', 'https://example.invalid'], ['diagnostic', '--profile', '/tmp/profile'], ['run']]) {
    const r = await run(args); assert.notEqual(r.code, 0); assert.equal(r.calls, 0);
  }
});
test('CLI success requires validated cleanup and prints only approved fields', async () => {
  const r = await run(['diagnostic'], { ok: true, snapshot: { state: 'login' }, cleanup: 'confirmed',
    playwrightVersion: '1.63.0', browserVersion: '154.0.8037.93', secret: 'CANARY' });
  assert.equal(r.code, 0); assert.match(r.out, /login/); assert.equal(r.out.includes('CANARY'), false);
});
test('CLI missing dependency gives explicit installation instruction', async () => {
  const r = await run(['diagnostic'], { ok: false, code: 'browser_missing', cleanup: 'confirmed' });
  assert.notEqual(r.code, 0); assert.match(r.err, /playwright install chromium/);
});
test('CLI suppresses upstream errors and rejects forged success or raw version output', async () => {
  for (const result of [{ ok: true, cleanup: 'pending', browserVersion: 'CANARY' },
    { ok: true, cleanup: 'confirmed', snapshot: { state: 'login' }, browserVersion: 'CANARY', playwrightVersion: '1.63.0' }, undefined]) {
    const r = await run(['diagnostic'], result, result === undefined); assert.notEqual(r.code, 0);
    assert.equal((r.out + r.err).includes('CANARY'), false);
  }
});
test('piped cleanup-pending output delivers the failure and receipt before forced exit', async () => {
  const { spawnSync } = await import('node:child_process');
  const script = `
    import { runPlaywrightCli } from './dist/cli/playwright-main.js';
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = (...args) => { setTimeout(() => original(...args), 100); return false; };
    const code = await runPlaywrightCli(['diagnostic'], { diagnostic: async () => ({
      ok: false, code: 'cleanup_pending', cleanup: 'pending', receiptPath: '/private/tmp/behalvo-playwright-ABC123/receipt.json'
    }) });
    process.exit(code);
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 5000 });
  assert.equal(child.status, 3); assert.match(child.stderr, /cleanup is unconfirmed/);
  assert.match(child.stderr, /\/private\/tmp\/behalvo-playwright-ABC123\/receipt.json/);
});
