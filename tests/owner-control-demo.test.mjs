import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runOwnerControlDemo } from '../dist/control-demo.js';

const EXPECTED_RESULT = {
  mode: 'local-owner-control',
  realModelCalls: 0,
  realExternalEffects: 0,
  authenticatedDecisions: 2,
  rejectedApprovalReplays: 1,
  verifiedSyntheticActions: 1,
  cancelledActions: 1,
  journalReplaysMatch: true
};

async function withFetchInterceptor(interceptor, operation) {
  const nativeFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => interceptor(nativeFetch, input, init);
  try {
    return await operation();
  } finally {
    globalThis.fetch = nativeFetch;
  }
}

test('owner-control demo uses production HTTP then executes only the approved synthetic action', async () => {
  assert.deepEqual(await runOwnerControlDemo(), EXPECTED_RESULT);
});

test('owner-control demo rejects a non-successful logout response', async () => {
  await assert.rejects(withFetchInterceptor(
    (nativeFetch, input, init) => {
      if (String(input).endsWith('/api/session/logout')) {
        return Promise.resolve(new Response(
          JSON.stringify({ error: 'internal_error' }),
          { status: 500, headers: { 'Content-Type': 'application/json' } }
        ));
      }
      return nativeFetch(input, init);
    },
    runOwnerControlDemo
  ), /logout failed/i);
});

test('owner-control demo rejects a logout response that did not revoke the session', async () => {
  await assert.rejects(withFetchInterceptor(
    (nativeFetch, input, init) => {
      if (String(input).endsWith('/api/session/logout')) {
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      return nativeFetch(input, init);
    },
    runOwnerControlDemo
  ), /session remained active/i);
});

test('control demo entrypoint prints its exact summary from a spaced copied dist', () => {
  const directory = mkdtempSync(join(tmpdir(), 'behalvo spaced control demo '));
  try {
    cpSync('dist', join(directory, 'dist'), { recursive: true });
    const output = execFileSync(process.execPath, [join(directory, 'dist/control-demo.js')], {
      encoding: 'utf8'
    });
    assert.deepEqual(JSON.parse(output), EXPECTED_RESULT);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('control demo executable exits nonzero on rebuild or reopen replay mismatch', () => {
  const directory = mkdtempSync(join(tmpdir(), 'behalvo replay mismatch '));
  try {
    const copiedDist = join(directory, 'dist');
    cpSync('dist', copiedDist, { recursive: true });
    const demoPath = join(copiedDist, 'control-demo.js');
    const source = readFileSync(demoPath, 'utf8');
    const originalImport = "from 'node:util';";
    assert.ok(source.includes(originalImport));
    writeFileSync(
      demoPath,
      source.replace(originalImport, "from './replay-mismatch-fixture.mjs';")
    );
    const fixturePath = join(copiedDist, 'replay-mismatch-fixture.mjs');
    for (const [name, fixture] of [
      ['rebuild', 'export function isDeepStrictEqual() { return false; }\n'],
      ['reopen', 'let calls = 0; export function isDeepStrictEqual() { calls += 1; return calls === 1; }\n']
    ]) {
      writeFileSync(fixturePath, fixture);
      const result = spawnSync(process.execPath, [demoPath], { encoding: 'utf8' });
      assert.equal(result.error, undefined, name);
      assert.equal(result.signal, null, name);
      assert.equal(result.status, 1, name);
      assert.equal(result.stdout, '', name);
      assert.equal(
        result.stderr.replace(
          /\(node:\d+\) ExperimentalWarning: SQLite is an experimental feature and might change at any time\r?\n\(Use `node --trace-warnings \.\.\.` to show where the warning was created\)\r?\n/g,
          ''
        ),
        'Owner control demo failed.\n',
        name
      );
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
