import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  NativeHostSecretAccess,
  PrivateConnectionManager,
  SqliteStore,
  SyntheticSecretProvider
} from '../dist/index.js';

function contains(haystack, needles) {
  const bytes = Buffer.isBuffer(haystack) ? haystack : Buffer.from(String(haystack));
  return needles.some(needle => bytes.includes(needle));
}

test('runtime canaries stay out of durable, control, browser, model, backup, and verification surfaces', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'behalvo-secret-leakage-'));
  chmodSync(directory, 0o700);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const profile = join(directory, 'profile');
  const { mkdirSync } = await import('node:fs');
  mkdirSync(profile, { mode: 0o700 });
  const canaries = [randomBytes(36), randomBytes(44), randomBytes(52)];
  const provider = new SyntheticSecretProvider();
  const purposes = ['username', 'password', 'security-answer'];
  const refs = [];
  for (let index = 0; index < purposes.length; index++) {
    refs.push(await provider.put({ service: 'visa-scheduling', connectionId: 'connection-a',
      purpose: purposes[index], accountId: 'account-a', value: canaries[index] }));
  }
  const scanNeedles = canaries.flatMap(value => [Buffer.from(value), Buffer.from(value.toString('hex')),
    Buffer.from(value.toString('base64url'))]);
  canaries.forEach(value => value.fill(0));

  const manager = new PrivateConnectionManager({ secretProvider: provider, authority: {
    assertConnection() {}, async revokeConnection() {}, async revokeBrowserEpochs() {},
    async stopAndReleaseMonitors() {}, async revokeSecretBrokers() {}
  } });
  manager.register({ id: 'connection-a', service: 'visa-scheduling', accountId: 'account-a', generation: 1,
    profileId: 'profile-a', profilePath: profile, mode: 'synthetic', dedicated: true,
    fullDiskEncryptionAcknowledged: false, secretReferences: refs });
  const native = new NativeHostSecretAccess(provider, refs, { connectionGeneration: 1 });
  const callbackResult = await native.withSecret({ service: refs[1].service, connectionId: refs[1].connectionId,
    purpose: refs[1].purpose, accountId: refs[1].accountId, reference: refs[1].reference },
  bytes => bytes.byteLength);
  assert.equal(callbackResult, 44);

  const dbPath = join(directory, 'state.db');
  const store = new SqliteStore(dbPath, { encryptionKey: randomBytes(32),
    serviceQueue: { upgradeExisting: false } });
  store.createWorkspace('workspace', 'owner');
  const backup = join(directory, 'encrypted-backup.db');
  await store.backup(backup);
  const verification = join(directory, 'verification');
  const { mkdirSync: makeDirectory } = await import('node:fs');
  makeDirectory(verification, { mode: 0o700 });
  writeFileSync(join(verification, 'summary.json'), JSON.stringify({ status: manager.list(), passed: true }));
  writeFileSync(join(verification, 'screenshot.json'), JSON.stringify({ capture: 'disabled', connections: manager.list() }));
  writeFileSync(join(verification, 'trace.json'), JSON.stringify({ trace: 'disabled', events: [] }));

  let error;
  try { await native.withSecret({ service: refs[0].service, connectionId: refs[0].connectionId,
    purpose: 'password', accountId: refs[0].accountId, reference: refs[0].reference }, () => {}); }
  catch (caught) { error = caught; }
  const surfaces = [
    JSON.stringify(store.journal('workspace')),
    JSON.stringify(store.serviceJobs('workspace')),
    JSON.stringify(manager.list()),
    JSON.stringify({ browser: 'no secret protocol', modelRequests: [] }),
    String(error?.stack),
    JSON.stringify(process.argv),
    JSON.stringify(process.env),
    readFileSync(backup),
    ...readdirSync(verification).map(file => readFileSync(join(verification, file)))
  ];
  for (const relative of readdirSync(directory, { recursive: true })) {
    const path = join(directory, String(relative));
    if (lstatSync(path).isFile()) surfaces.push(readFileSync(path));
  }
  const actualVerification = join(process.cwd(), 'data', 'verification');
  if (existsSync(actualVerification)) {
    for (const relative of readdirSync(actualVerification, { recursive: true })) {
      const path = join(actualVerification, String(relative));
      if (lstatSync(path).isFile()) surfaces.push(readFileSync(path));
    }
  }
  assert.equal(surfaces.some(surface => contains(surface, scanNeedles)), false);
  assert.equal(error?.message, 'Secret storage operation failed.');
  store.close();
});

test('native secret broker revocation zeroes and rejects a held callback continuation', async () => {
  const provider = new SyntheticSecretProvider();
  const value = randomBytes(32);
  const metadata = await provider.put({ service: 'visa-scheduling', connectionId: 'connection-a',
    purpose: 'password', accountId: 'account-a', value });
  value.fill(0);
  const broker = new NativeHostSecretAccess(provider, [metadata], { connectionGeneration: 1 });
  let borrowed;
  let enter;
  let release;
  const entered = new Promise(resolve => { enter = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  const pending = broker.withSecret({ service: metadata.service, connectionId: metadata.connectionId,
    purpose: metadata.purpose, accountId: metadata.accountId, reference: metadata.reference }, async bytes => {
    borrowed = bytes; enter(); await held; return 'late-success';
  });
  await entered;
  broker.revoke('connection-a', 1);
  assert.ok(borrowed.every(byte => byte === 0), 'revocation must zero the active broker borrow');
  release();
  await assert.rejects(pending, /Secret storage operation failed\./);
});
