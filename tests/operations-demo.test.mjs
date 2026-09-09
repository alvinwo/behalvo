import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

test('operations demo verifies different domains with one durable runtime', () => {
  const result = JSON.parse(execFileSync(process.execPath, ['dist/operations-demo.js'], { encoding: 'utf8' }));
  assert.equal(result.mode, 'synthetic-operations');
  assert.equal(result.realExternalEffects, 0);
  assert.ok(result.verifiedOperations >= 2);
  assert.equal(result.unknownBlocked, true);
  assert.equal(result.replayMatches, true);
});
