import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  KeychainSecretProvider,
  NativeKeychainHelperTransport
} from '../dist/index.js';
import { secretReferenceFor } from '../dist/secrets/types.js';

const scope = Object.freeze({
  service: 'visa-scheduling', connectionId: 'connection-a', purpose: 'security-answer', accountId: 'account-a'
});

function executableHelper(t, source) {
  const directory = mkdtempSync(join(tmpdir(), 'behalvo-keychain-helper-'));
  const path = join(directory, 'fixture.mjs');
  writeFileSync(path, `#!${process.execPath}\n${source}\n`, { mode: 0o700 });
  chmodSync(path, 0o700);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return path;
}

test('Keychain provider binds every operation to exact scope and a stable helper identity', async () => {
  let identity = 'signed-helper-v1';
  const calls = [];
  let stored;
  const transport = {
    async identity() { return identity; },
    async invoke(request, secret) {
      calls.push({ request: structuredClone(request), secret: secret && Buffer.from(secret) });
      if (request.operation === 'put') {
        stored = Buffer.from(secret);
        return { version: 1, status: 'ok' };
      }
      if (request.operation === 'with_secret') return { version: 1, status: 'ok', secret: Buffer.from(stored) };
      if (request.operation === 'delete') { stored?.fill(0); stored = undefined; return { version: 1, status: 'ok' }; }
      return { version: 1, status: 'ok', items: [] };
    }
  };
  const provider = new KeychainSecretProvider({ transport, expectedHelperIdentity: identity });
  const source = randomBytes(40);
  const expected = Buffer.from(source);
  const metadata = await provider.put({ ...scope, value: source });
  source.fill(0);
  assert.equal(JSON.stringify(calls[0].request).includes(expected.toString('hex')), false);
  assert.deepEqual(calls[0].secret, expected);

  let borrowed;
  await provider.withSecret({ ...scope, reference: metadata.reference }, bytes => {
    borrowed = bytes;
    assert.deepEqual(bytes, expected);
  });
  assert.ok(borrowed.every(byte => byte === 0));

  identity = 'changed-helper';
  await assert.rejects(provider.delete({ ...scope, reference: metadata.reference }),
    /Secret storage operation failed\./);
  expected.fill(0);
  calls[0].secret.fill(0);
});

test('Keychain provider fails closed on malformed output, timeout, and cancellation', async () => {
  const fixed = { async identity() { return 'helper'; } };
  const reference = secretReferenceFor(scope);
  const malformed = new KeychainSecretProvider({ expectedHelperIdentity: 'helper',
    transport: { ...fixed, async invoke() { return { version: 1, status: 'ok', secret: randomBytes(8), extra: true }; } } });
  await assert.rejects(malformed.withSecret({ ...scope, reference }, () => {}),
    /Secret storage operation failed\./);

  const held = new KeychainSecretProvider({ expectedHelperIdentity: 'helper', timeoutMs: 10,
    transport: { ...fixed, async invoke() { return new Promise(() => {}); } } });
  await assert.rejects(held.list({ service: scope.service, connectionId: scope.connectionId,
    accountId: scope.accountId }), /Secret storage operation failed\./);

  const controller = new AbortController();
  const cancelled = new KeychainSecretProvider({ expectedHelperIdentity: 'helper', timeoutMs: 1_000,
    transport: { ...fixed, async invoke() { return new Promise(() => {}); } } });
  const started = Date.now();
  const pending = cancelled.list({ service: scope.service, connectionId: scope.connectionId,
    accountId: scope.accountId }, { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, /Secret storage operation failed\./);
  assert.ok(Date.now() - started < 100, 'external cancellation must settle a non-cooperative helper promptly');
});

test('Keychain provider validates exact operation responses and detects identity replacement after invoke', async () => {
  const value = randomBytes(16);
  for (const extraOperation of ['put', 'delete']) {
    const transport = {
      async identity() { return 'helper'; },
      async invoke(request) {
        if (request.operation === extraOperation) return { version: 1, status: 'ok', extra: true };
        return { version: 1, status: 'ok' };
      }
    };
    const provider = new KeychainSecretProvider({ transport, expectedHelperIdentity: 'helper' });
    if (extraOperation === 'put') await assert.rejects(provider.put({ ...scope, value }),
      /Secret storage operation failed\./);
    else await assert.rejects(provider.delete({ ...scope, reference: secretReferenceFor(scope) }),
      /Secret storage operation failed\./);
  }

  let identityReads = 0;
  const replaced = new KeychainSecretProvider({ expectedHelperIdentity: 'helper-before', transport: {
    async identity() { identityReads++; return identityReads === 1 ? 'helper-before' : 'helper-after'; },
    async invoke() { return { version: 1, status: 'ok', items: [] }; }
  } });
  await assert.rejects(replaced.list({ service: scope.service, connectionId: scope.connectionId,
    accountId: scope.accountId }), /Secret storage operation failed\./);

  let returnedSecret;
  identityReads = 0;
  const replacedDuringRead = new KeychainSecretProvider({ expectedHelperIdentity: 'helper-before', transport: {
    async identity() { identityReads++; return identityReads === 1 ? 'helper-before' : 'helper-after'; },
    async invoke() { returnedSecret = randomBytes(20); return { version: 1, status: 'ok', secret: returnedSecret }; }
  } });
  await assert.rejects(replacedDuringRead.withSecret({ ...scope, reference: secretReferenceFor(scope) }, () => {}),
    /Secret storage operation failed\./);
  assert.ok(returnedSecret.every(byte => byte === 0), 'rejected helper secret output must be zeroed');
  value.fill(0);
});

test('native helper metadata stdout supports list without carrying secret output', async () => {
  const metadata = { ...scope, reference: secretReferenceFor(scope), provider: 'keychain',
    createdAt: '2026-09-21T12:00:00.000Z' };
  const transport = new NativeKeychainHelperTransport({
    executablePath: '/opt/behalvo/keychain-helper', platform: 'darwin',
    identityReader: async () => 'signed-helper-v1',
    launcher: async () => ({ exitCode: 0,
      stdout: Buffer.from(JSON.stringify({ version: 1, status: 'ok', items: [metadata] })),
      secretOutput: Buffer.alloc(0) })
  });
  const provider = new KeychainSecretProvider({ transport, expectedHelperIdentity: 'signed-helper-v1' });
  assert.deepEqual(await provider.list({ service: scope.service, connectionId: scope.connectionId,
    accountId: scope.accountId }), [metadata]);
});

test('keychain timeout covers helper identity lookup and rejects unexpected secret-channel output', async () => {
  const value = randomBytes(24);
  const stalledIdentity = new KeychainSecretProvider({
    expectedHelperIdentity: 'helper', timeoutMs: 15,
    transport: {
      async identity() { return new Promise(() => {}); },
      async invoke() { throw new Error('unreachable'); }
    }
  });
  await assert.rejects(stalledIdentity.put({ ...scope, value }), /Secret storage operation failed\./);

  for (const operation of ['put', 'delete', 'list']) {
    const transport = new NativeKeychainHelperTransport({
      executablePath: '/opt/behalvo/keychain-helper', platform: 'darwin',
      identityReader: async () => 'signed-helper-v1',
      launcher: async () => ({ exitCode: 0,
        stdout: Buffer.from(operation === 'list'
          ? '{"version":1,"status":"ok","items":[]}'
          : '{"version":1,"status":"ok"}'),
        secretOutput: randomBytes(8) })
    });
    const provider = new KeychainSecretProvider({ transport, expectedHelperIdentity: 'signed-helper-v1' });
    if (operation === 'put')
      await assert.rejects(provider.put({ ...scope, value }), /Secret storage operation failed\./);
    else if (operation === 'delete')
      await assert.rejects(provider.delete({ ...scope, reference: secretReferenceFor(scope) }),
        /Secret storage operation failed\./);
    else
      await assert.rejects(provider.list({ service: scope.service, connectionId: scope.connectionId,
        accountId: scope.accountId }), /Secret storage operation failed\./);
  }
  value.fill(0);
});

test('native helper transport keeps secret values out of argv environment and stdout', async () => {
  const value = randomBytes(24);
  const marker = value.toString('base64url');
  const launches = [];
  const transport = new NativeKeychainHelperTransport({
    executablePath: '/opt/behalvo/keychain-helper',
    platform: 'darwin',
    identityReader: async () => 'signed-helper-v1',
    launcher: async launch => {
      launches.push({ ...launch, stdin: Buffer.from(launch.stdin) });
      return { exitCode: 0,
        stdout: Buffer.from('{"version":1,"status":"ok"}', 'utf8'),
        secretOutput: Buffer.alloc(0) };
    }
  });
  const provider = new KeychainSecretProvider({ transport, expectedHelperIdentity: 'signed-helper-v1' });
  await provider.put({ ...scope, value });

  const call = launches[0];
  assert.deepEqual(call.args, ['--behalvo-keychain-helper-v1']);
  assert.equal(JSON.stringify(call.args).includes(marker), false);
  assert.equal(JSON.stringify(call.env).includes(marker), false);
  assert.equal(call.stdout, undefined);
  assert.ok(Buffer.from(call.stdin).includes(value));
  const metadataLength = call.stdin.readUInt32LE(0);
  const metadata = JSON.parse(call.stdin.subarray(4, 4 + metadataLength).toString('utf8'));
  assert.deepEqual(Object.keys(metadata).sort(), [
    'accountId', 'connectionId', 'createdAt', 'operation', 'purpose', 'reference', 'service', 'version'
  ]);
  value.fill(0);
  call.stdin.fill(0);
});

test('final identity cancellation blocks callback entry and zeroes returned helper bytes', async () => {
  const controller = new AbortController();
  const returned = randomBytes(24);
  let identities = 0;
  let called = false;
  const provider = new KeychainSecretProvider({ expectedHelperIdentity: 'helper', transport: {
    async identity() {
      identities++;
      if (identities === 2) controller.abort();
      return 'helper';
    },
    async invoke() { return { version: 1, status: 'ok', secret: returned }; }
  } });
  await assert.rejects(provider.withSecret({ ...scope, reference: secretReferenceFor(scope) }, () => {
    called = true;
  }, { signal: controller.signal }), /Secret storage operation failed\./);
  assert.equal(called, false);
  assert.ok(returned.every(byte => byte === 0));
});

test('a helper result arriving after cancellation is zeroed without callback entry', async () => {
  const controller = new AbortController();
  const returned = randomBytes(24);
  let resolveInvoke;
  let entered;
  const invoked = new Promise(resolve => { entered = resolve; });
  let called = false;
  const provider = new KeychainSecretProvider({ expectedHelperIdentity: 'helper', transport: {
    async identity() { return 'helper'; },
    async invoke() {
      entered();
      return new Promise(resolve => { resolveInvoke = resolve; });
    }
  } });
  const pending = provider.withSecret({ ...scope, reference: secretReferenceFor(scope) }, () => {
    called = true;
  }, { signal: controller.signal });
  await invoked;
  controller.abort();
  await assert.rejects(pending, /Secret storage operation failed\./);
  resolveInvoke({ version: 1, status: 'ok', secret: returned });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(called, false);
  assert.ok(returned.every(byte => byte === 0));
});

test('every rejected helper secret output is zeroed', async () => {
  for (const failure of ['identity-throw', 'identity-timeout', 'oversize']) {
    const returned = randomBytes(failure === 'oversize' ? 16_385 : 24);
    let identities = 0;
    const provider = new KeychainSecretProvider({ expectedHelperIdentity: 'helper', timeoutMs: 15, transport: {
      async identity() {
        identities++;
        if (identities === 2 && failure === 'identity-throw') throw new Error('raw identity error');
        if (identities === 2 && failure === 'identity-timeout') return new Promise(() => {});
        return 'helper';
      },
      async invoke() { return { version: 1, status: 'ok', secret: returned }; }
    } });
    await assert.rejects(provider.withSecret({ ...scope, reference: secretReferenceFor(scope) }, () => {}),
      /Secret storage operation failed\./);
    assert.ok(returned.every(byte => byte === 0), `${failure} output must be zeroed`);
  }
});

test('Keychain list rejects foreign, duplicate, and unbounded metadata', async () => {
  const requested = { ...scope, reference: secretReferenceFor(scope), provider: 'keychain',
    createdAt: '2026-09-21T12:00:00.000Z' };
  const foreignScopes = [
    { ...scope, service: 'foreign-service' },
    { ...scope, connectionId: 'foreign-connection' },
    { ...scope, accountId: 'foreign-account' },
    { ...scope, purpose: 'password' }
  ];
  const cases = [
    ...foreignScopes.map(item => [{ ...item, reference: secretReferenceFor(item), provider: 'keychain',
      createdAt: requested.createdAt }]),
    [requested, requested],
    Array.from({ length: 257 }, (_, index) => {
      const item = { ...scope, purpose: `purpose-${index}` };
      return { ...item, reference: secretReferenceFor(item), provider: 'keychain', createdAt: requested.createdAt };
    })
  ];
  for (const items of cases) {
    const provider = new KeychainSecretProvider({ expectedHelperIdentity: 'helper', transport: {
      async identity() { return 'helper'; },
      async invoke() { return { version: 1, status: 'ok', items }; }
    } });
    await assert.rejects(provider.list({ service: scope.service, connectionId: scope.connectionId,
      accountId: scope.accountId, purpose: scope.purpose }), /Secret storage operation failed\./);
  }

  const native = new NativeKeychainHelperTransport({ executablePath: '/opt/behalvo/keychain-helper',
    platform: 'darwin', identityReader: async () => 'helper', launcher: async () => ({ exitCode: 0,
      stdout: Buffer.from(JSON.stringify({ version: 1, status: 'ok', items: cases[0] })),
      secretOutput: Buffer.alloc(0) }) });
  const throughNative = new KeychainSecretProvider({ transport: native, expectedHelperIdentity: 'helper' });
  await assert.rejects(throughNative.list({ service: scope.service, connectionId: scope.connectionId,
    accountId: scope.accountId, purpose: scope.purpose }), /Secret storage operation failed\./);
});

test('real helper early exit and stdin EPIPE reject safely without terminating the process', async () => {
  const moduleUrl = new URL('../dist/secrets/keychain.js', import.meta.url).href;
  const script = `
    import { KeychainSecretProvider, NativeKeychainHelperTransport } from ${JSON.stringify(moduleUrl)};
    const transport = new NativeKeychainHelperTransport({ executablePath: '/usr/bin/true', platform: 'darwin',
      identityReader: async () => 'fixture' });
    const provider = new KeychainSecretProvider({ transport, expectedHelperIdentity: 'fixture', timeoutMs: 1000 });
    try {
      await provider.put({ service: 'visa-scheduling', connectionId: 'connection-a', purpose: 'password',
        accountId: 'account-a', value: new Uint8Array(16 * 1024) });
      process.stdout.write('unexpected-success');
    } catch (error) { process.stdout.write(String(error.message)); }
  `;
  const result = await new Promise(resolve => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('exit', code => resolve({ code, stdout, stderr }));
  });
  assert.deepEqual(result, { code: 0, stdout: 'Secret storage operation failed.', stderr: '' });
});

test('native helper clears an assembled fd3 secret when metadata stdout overflows afterward', async t => {
  const secret = randomBytes(33);
  const helper = executableHelper(t, `
    import fs from 'node:fs';
    fs.writeSync(3, Buffer.from('${secret.toString('hex')}', 'hex'));
    fs.closeSync(3);
    setTimeout(() => process.stdout.write('x'.repeat(65_537)), 20);
  `);
  const originalConcat = Buffer.concat;
  let aggregate;
  Buffer.concat = function(chunks, totalLength) {
    const result = originalConcat.call(this, chunks, totalLength);
    if (totalLength === secret.byteLength && result.equals(secret)) aggregate = result;
    return result;
  };
  try {
    const transport = new NativeKeychainHelperTransport({ executablePath: helper, platform: 'darwin',
      identityReader: async () => 'fixture' });
    const provider = new KeychainSecretProvider({ transport, expectedHelperIdentity: 'fixture', timeoutMs: 1_000 });
    await assert.rejects(provider.withSecret({ ...scope, reference: secretReferenceFor(scope) }, () => {}),
      /Secret storage operation failed\./);
    assert.ok(aggregate, 'the real fd3 stream must have assembled the fixture secret before stdout failed');
    assert.ok(aggregate.every(byte => byte === 0), 'the unreturned fd3 aggregate must be zeroed');
  } finally { Buffer.concat = originalConcat; secret.fill(0); }
});

test('native helper clears assembled metadata when fd3 overflows afterward', async t => {
  const metadata = Buffer.from('{"version":1,"status":"ok"}', 'utf8');
  const helper = executableHelper(t, `
    import fs from 'node:fs';
    fs.writeSync(1, Buffer.from('${metadata.toString('hex')}', 'hex'));
    fs.closeSync(1);
    setTimeout(() => fs.writeSync(3, Buffer.alloc(16_385, 7)), 20);
  `);
  const originalConcat = Buffer.concat;
  let aggregate;
  Buffer.concat = function(chunks, totalLength) {
    const result = originalConcat.call(this, chunks, totalLength);
    if (totalLength === metadata.byteLength && result.equals(metadata)) aggregate = result;
    return result;
  };
  try {
    const transport = new NativeKeychainHelperTransport({ executablePath: helper, platform: 'darwin',
      identityReader: async () => 'fixture' });
    const provider = new KeychainSecretProvider({ transport, expectedHelperIdentity: 'fixture', timeoutMs: 1_000 });
    await assert.rejects(provider.withSecret({ ...scope, reference: secretReferenceFor(scope) }, () => {}),
      /Secret storage operation failed\./);
    assert.ok(aggregate, 'the metadata stream must assemble before fd3 fails');
    assert.ok(aggregate.every(byte => byte === 0), 'the unreturned metadata aggregate must be zeroed');
  } finally { Buffer.concat = originalConcat; metadata.fill(0); }
});

test('native helper clears an assembled late fd3 result after cancellation', async t => {
  const secret = randomBytes(35);
  const metadata = Buffer.from('{"version":1,"status":"ok"}', 'utf8');
  const helper = executableHelper(t, `
    import fs from 'node:fs';
    fs.writeSync(1, Buffer.from('${metadata.toString('hex')}', 'hex')); fs.closeSync(1);
    fs.writeSync(3, Buffer.from('${secret.toString('hex')}', 'hex')); fs.closeSync(3);
    setInterval(() => {}, 1000);
  `);
  const originalConcat = Buffer.concat;
  let aggregate;
  let notifyAssembled;
  const assembled = new Promise(resolve => { notifyAssembled = resolve; });
  Buffer.concat = function(chunks, totalLength) {
    const result = originalConcat.call(this, chunks, totalLength);
    if (totalLength === secret.byteLength && result.equals(secret)) { aggregate = result; notifyAssembled(); }
    return result;
  };
  const controller = new AbortController();
  try {
    const transport = new NativeKeychainHelperTransport({ executablePath: helper, platform: 'darwin',
      identityReader: async () => 'fixture' });
    const provider = new KeychainSecretProvider({ transport, expectedHelperIdentity: 'fixture', timeoutMs: 1_000 });
    const pending = provider.withSecret({ ...scope, reference: secretReferenceFor(scope) }, () => {},
      { signal: controller.signal });
    await assembled;
    controller.abort();
    await assert.rejects(pending, /Secret storage operation failed\./);
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(aggregate.every(byte => byte === 0), 'the completed fd3 aggregate must be zeroed after cancellation');
  } finally { Buffer.concat = originalConcat; secret.fill(0); metadata.fill(0); controller.abort(); }
});
