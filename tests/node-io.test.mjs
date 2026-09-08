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

// A terminal-like stream lets the real readline editor exercise raw-mode cleanup.
function terminal() {
  const input = new PassThrough();
  input.isTTY = true;
  input.isRaw = false;
  input.setRawMode = value => { input.isRaw = value; return input; };
  const output = new PassThrough();
  let text = '';
  output.on('data', chunk => { text += chunk; });
  return { input, output, text: () => text };
}

test('NodeLineIo reads hidden secrets and preserves the following command', async t => {
  const { NodeLineIo } = await api();
  const f = terminal();
  const io = new NodeLineIo(f.input, f.output);
  t.after(() => io.close());
  assert.equal(typeof io.readSecret, 'function');
  const pending = io.readSecret('key> ');
  f.input.write('SYNTHETIC-KEY\n/quit\n');
  assert.equal(await pending, 'SYNTHETIC-KEY');
  assert.equal(await io.readLine(), '/quit');
  assert.doesNotMatch(f.text(), /SYNTHETIC-KEY/);
  io.close();
  assert.equal(f.input.isRaw, false);
});

test('NodeLineIo consumes piped secret input without echo or losing following chat', async t => {
  const { NodeLineIo } = await api();
  const input = new PassThrough(), output = new PassThrough();
  let text = ''; output.on('data', chunk => { text += chunk; });
  const io = new NodeLineIo(input, output); t.after(() => io.close());
  assert.equal(typeof io.readSecret, 'function');
  input.end('SYNTHETIC-KEY\nintended chat\n');
  assert.equal(await io.readSecret(), 'SYNTHETIC-KEY');
  assert.equal(await io.readLine(), 'intended chat');
  assert.equal(await io.readLine(), null);
  assert.doesNotMatch(text, /SYNTHETIC-KEY/);
});

for (const tty of [false, true]) {
  test(`NodeLineIo discards partial cancelled auth input (tty=${tty})`, async t => {
    const { NodeLineIo } = await api();
    const f = terminal(); if (!tty) f.input.isTTY = false;
    const io = new NodeLineIo(f.input, f.output); t.after(() => io.close());
    const controller = new AbortController();
    const auth = io.readLine('code> ', controller.signal);
    f.input.write('SYNTHETIC-OAUTH-CODE');
    controller.abort(new Error('callback completed'));
    await assert.rejects(auth, /callback completed/);
    const next = io.readLine('You > ');
    f.input.write('SYNTHETIC-SUFFIX\nintended chat\n');
    const line = await next;
    assert.equal(line, '');
    assert.equal(await io.readLine(), 'intended chat');
  });
}

test('NodeLineIo cleans up a secret prompt on abort and EOF', async t => {
  const { NodeLineIo } = await api();
  for (const end of ['abort', 'eof']) {
    const f = terminal(); const io = new NodeLineIo(f.input, f.output);
    t.after(() => io.close());
    assert.equal(typeof io.readSecret, 'function');
    const controller = new AbortController();
    const pending = io.readSecret('key> ', controller.signal);
    f.input.write('SYNTHETIC-PARTIAL');
    if (end === 'abort') {
      controller.abort(new Error('cancelled'));
      await assert.rejects(pending, /cancelled/);
      f.input.write('\n');
      assert.equal(await io.readLine(), '');
      io.close();
    } else {
      f.input.end();
      assert.equal(await pending, null);
    }
    assert.equal(f.input.isRaw, false);
    assert.doesNotMatch(f.text(), /SYNTHETIC-PARTIAL/);
  }
});

test('NodeLineIo restores an already-raw terminal on close', async () => {
  const { NodeLineIo } = await api();
  const f = terminal(); f.input.isRaw = true;
  const io = new NodeLineIo(f.input, f.output);
  io.close();
  assert.equal(f.input.isRaw, true);
});

for (const cancelled of [false, true]) {
  test(`NodeLineIo cannot yank authentication text into later chat (cancelled=${cancelled})`, async t => {
    const { NodeLineIo } = await api();
    const f = terminal(); const io = new NodeLineIo(f.input, f.output);
    t.after(() => io.close());
    const controller = new AbortController();
    const auth = io.readSecret('key> ', controller.signal);
    f.input.write('SYNTHETIC-OLD-KEY\x15SYNTHETIC-NEW-KEY');
    if (cancelled) {
      controller.abort(new Error('cancelled'));
      await assert.rejects(auth, /cancelled/);
      f.input.write('\n');
      assert.equal(await io.readLine(), '');
    } else {
      f.input.write('\nqueued chat\npartial chat');
      assert.equal(await auth, 'SYNTHETIC-NEW-KEY');
      assert.equal(await io.readLine(), 'queued chat');
      const partial = io.readLine(); f.input.write('\n');
      assert.equal(await partial, 'partial chat');
    }
    const chat = io.readLine(); f.input.write('\x19\n');
    assert.equal(await chat, '');
  });
}

test('buffered final input without a newline reaches EOF', async t => {
  const { NodeLineIo } = await api();
  const { setImmediate } = await import('node:timers/promises');
  const input = new PassThrough(), output = new PassThrough();
  const io = new NodeLineIo(input, output); t.after(() => io.close());
  input.end('last line'); await setImmediate();
  assert.equal(await io.readLine(), 'last line');
  const result = await Promise.race([
    io.readLine(),
    new Promise(resolve => { const timer = setTimeout(() => resolve('hung after EOF'), 100); t.after(() => clearTimeout(timer)); })
  ]);
  assert.equal(result, null);
});
