import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { api } from './helpers.mjs';

test('NodeLineIo aborts an OAuth prompt without consuming the next REPL line', async () => {
  const { NodeLineIo } = await api();
  const input = new PassThrough();
  const output = new PassThrough();
  const io = new NodeLineIo(input, output);
  const controller = new AbortController();
  const pending = io.readLine('code> ', controller.signal);
  controller.abort(new Error('oauth callback completed'));
  await assert.rejects(pending, /oauth callback completed|abort/i);
  input.write('/quit\n');
  assert.equal(await io.readLine('You > '), '/quit');
  io.close();
});
