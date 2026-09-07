import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { api } from './helpers.mjs';

test('MVP demo proves restart plus a new thread uses durable work while raw history remains available', async t => {
  const { runMvpDemo } = await api();
  const dir = await mkdtemp(join(tmpdir(), 'behalvo-mvp-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const result = await runMvpDemo(join(dir, 'agent.db'));
  assert.equal(result.firstReply, 'I will track your Maui preparation.');
  assert.equal(result.secondReply, 'Your Maui preparation is still open and departs on 2026-09-12.');
  assert.equal(result.workPhase, 'open');
  assert.deepEqual(result.workThreadIds.sort(), ['thread-after-restart', 'thread-before-restart']);
  assert.equal(result.departureDate, '2026-09-12');
  assert.equal(result.rawOwnerMessage, 'I am going to Maui on September 12.');
  assert.equal(result.actionCount, 0);
  assert.ok(result.journalCount >= 8);
});
