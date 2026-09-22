import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { appendFileSync, chmodSync, chownSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync,
  unlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import {
  BrowserSession,
  NativeHostSecretAccess,
  MonitoringRegistry,
  MonitoringService,
  OperationRegistry,
  OperationService,
  Operator,
  OwnerControlSessions,
  PrivateConnectionManager,
  SqliteStore,
  SyntheticSecretProvider,
  startLocalService
} from '../dist/index.js';
import { startOwnerControlServer } from '../dist/control/http-server.js';
import { requestControl } from './owner-control-http-helpers.mjs';
import * as behalvo from '../dist/index.js';

function privateDirectory(t, name = 'profile') {
  const root = mkdtempSync(join(tmpdir(), 'behalvo-private-connection-'));
  chmodSync(root, 0o700);
  const profile = join(root, name);
  mkdirSync(profile, { mode: 0o700 });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, profile };
}

async function secret(provider, purpose) {
  const value = randomBytes(24);
  const metadata = await provider.put({ service: 'visa-scheduling', connectionId: 'connection-a',
    purpose, accountId: 'account-a', value });
  value.fill(0);
  return metadata;
}

function authority(overrides = {}) {
  return {
    assertConnection() {},
    async revokeConnection() {},
    async revokeBrowserEpochs() {},
    async stopAndReleaseMonitors() {},
    async revokeSecretBrokers() {},
    ...overrides
  };
}

function readLines(stream) {
  let buffered = '';
  const lines = [];
  const waiters = [];
  stream.setEncoding('utf8');
  stream.on('data', chunk => {
    buffered += chunk;
    for (let newline = buffered.indexOf('\n'); newline >= 0; newline = buffered.indexOf('\n')) {
      const line = buffered.slice(0, newline); buffered = buffered.slice(newline + 1);
      const waiter = waiters.shift();
      if (waiter) waiter(line); else lines.push(line);
    }
  });
  return () => lines.length > 0 ? Promise.resolve(lines.shift()) : new Promise(resolve => waiters.push(resolve));
}

function startHeldRecovery(registration, gatePath, expectedCustodyId) {
  const moduleUrl = new URL('../dist/index.js', import.meta.url).href;
  const script = `
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    const originalRead = fs.readFileSync;
    let held = false;
    fs.readFileSync = function(path, ...args) {
      const value = originalRead.call(this, path, ...args);
      if (!held && String(path).endsWith('/owner.json')) {
        held = true;
        process.stdout.write('read\\n');
        while (!fs.existsSync(process.argv[2])) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
      return value;
    };
    syncBuiltinESMExports();
    const api = await import(${JSON.stringify(moduleUrl)});
    const manager = new api.PrivateConnectionManager({ secretProvider: new api.SyntheticSecretProvider(), authority: {
      assertConnection() {}, async revokeConnection() {}, async revokeBrowserEpochs() {},
      async stopAndReleaseMonitors() {}, async revokeSecretBrokers() {}
    } });
    try {
      const state = manager.recover(JSON.parse(process.argv[1]), {
        expectedCustodyId: process.argv[3], confirmStaleProcessExited: true
      });
      process.stdout.write(JSON.stringify({ outcome: 'connected', state: state.state, pid: process.pid }) + '\\n');
      setInterval(() => {}, 1000);
    } catch { process.stdout.write(JSON.stringify({ outcome: 'rejected', pid: process.pid }) + '\\n'); }
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, JSON.stringify(registration), gatePath,
    expectedCustodyId], { stdio: ['ignore', 'pipe', 'ignore'] });
  return { child, nextLine: readLines(child.stdout) };
}

function startRecovery(registration, expectedCustodyId) {
  const moduleUrl = new URL('../dist/index.js', import.meta.url).href;
  const script = `
    import * as api from ${JSON.stringify(moduleUrl)};
    const manager = new api.PrivateConnectionManager({ secretProvider: new api.SyntheticSecretProvider(), authority: {
      assertConnection() {}, async revokeConnection() {}, async revokeBrowserEpochs() {},
      async stopAndReleaseMonitors() {}, async revokeSecretBrokers() {}
    } });
    try {
      const state = manager.recover(JSON.parse(process.argv[1]), {
        expectedCustodyId: process.argv[2], confirmStaleProcessExited: true
      });
      process.stdout.write(JSON.stringify({ outcome: 'connected', state: state.state, pid: process.pid }) + '\\n');
      setInterval(() => {}, 1000);
    } catch { process.stdout.write(JSON.stringify({ outcome: 'rejected', pid: process.pid }) + '\\n'); }
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, JSON.stringify(registration),
    expectedCustodyId], { stdio: ['ignore', 'pipe', 'ignore'] });
  return { child, nextLine: readLines(child.stdout) };
}

async function crashRecoveryAt(registration, expectedCustodyId, phase, cut = 'complete') {
  const moduleUrl = new URL('../dist/index.js', import.meta.url).href;
  const script = `
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    const phase = process.argv[3];
    const originals = { writeFileSync: fs.writeFileSync, renameSync: fs.renameSync, unlinkSync: fs.unlinkSync };
    let ownerPublished = false;
    fs.writeFileSync = function(path, data, ...args) {
      const name = String(path).split('/').pop();
      if (phase === 'staging' && name.startsWith('owner-') && name.endsWith('.tmp') && process.argv[4] !== 'complete') {
        const source = String(data); const headerEnd = source.indexOf('\\n') + 1;
        const cut = process.argv[4];
        const length = cut === 'zero' ? 0 : cut === 'partial_header' ? 5
          : cut === 'header' ? headerEnd : headerEnd + 5;
        originals.writeFileSync.call(this, path, source.slice(0, length), ...args);
        process.exit(62);
      }
      const result = originals.writeFileSync.call(this, path, data, ...args);
      if (phase === 'claim' && name.startsWith('recovery') && name.endsWith('.json')) process.exit(61);
      if (phase === 'staging' && name.startsWith('owner-') && name.endsWith('.tmp')) process.exit(62);
      return result;
    };
    fs.renameSync = function(source, target, ...args) {
      const result = originals.renameSync.call(this, source, target, ...args);
      const targetName = String(target).split('/').pop();
      if (phase === 'claim' && targetName.startsWith('recovery-claim-') && targetName.endsWith('.json'))
        process.exit(61);
      if (String(target).endsWith('/owner.json')) {
        ownerPublished = true;
        if (phase === 'publication') process.exit(63);
      }
      return result;
    };
    fs.unlinkSync = function(path, ...args) {
      if (phase === 'claim_cleanup' && ownerPublished && String(path).split('/').pop().startsWith('recovery'))
        process.exit(64);
      return originals.unlinkSync.call(this, path, ...args);
    };
    syncBuiltinESMExports();
    const api = await import(${JSON.stringify(moduleUrl)});
    const manager = new api.PrivateConnectionManager({ secretProvider: new api.SyntheticSecretProvider(), authority: {
      assertConnection() {}, async revokeConnection() {}, async revokeBrowserEpochs() {},
      async stopAndReleaseMonitors() {}, async revokeSecretBrokers() {}
    } });
    manager.recover(JSON.parse(process.argv[1]), {
      expectedCustodyId: process.argv[2], confirmStaleProcessExited: true
    });
  `;
  return new Promise(resolve => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, JSON.stringify(registration),
      expectedCustodyId, phase, cut], { stdio: ['ignore', 'ignore', 'ignore'] });
    child.once('exit', code => resolve(code));
  });
}

async function crashDisconnectAt(registration, phase) {
  const moduleUrl = new URL('../dist/index.js', import.meta.url).href;
  const script = `
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    const phase = process.argv[2];
    const originals = { writeFileSync: fs.writeFileSync, linkSync: fs.linkSync,
      unlinkSync: fs.unlinkSync, rmdirSync: fs.rmdirSync };
    fs.writeFileSync = function(path, data, ...args) {
      const result = originals.writeFileSync.call(this, path, data, ...args);
      const name = String(path).split('/').pop();
      if (phase === 'checkpoint_stage' && name.startsWith('owner-') && name.endsWith('.tmp')) process.exit(71);
      return result;
    };
    fs.linkSync = function(source, target, ...args) {
      const result = originals.linkSync.call(this, source, target, ...args);
      if (phase === 'receipt_link' && String(target).includes('.behalvo-disconnect-')) process.exit(72);
      return result;
    };
    fs.unlinkSync = function(path, ...args) {
      const result = originals.unlinkSync.call(this, path, ...args);
      if (phase === 'owner_unlink' && String(path).endsWith('/owner.json')) process.exit(73);
      return result;
    };
    fs.rmdirSync = function(path, ...args) {
      const result = originals.rmdirSync.call(this, path, ...args);
      if (phase === 'custody_rmdir' && String(path).endsWith('.behalvo-private-custody')) process.exit(74);
      return result;
    };
    syncBuiltinESMExports();
    const api = await import(${JSON.stringify(moduleUrl)});
    const registration = JSON.parse(process.argv[1]);
    const manager = new api.PrivateConnectionManager({ secretProvider: new api.SyntheticSecretProvider(), authority: {
      assertConnection() {}, async revokeConnection() {}, async revokeBrowserEpochs() {},
      async stopAndReleaseMonitors() {}, async revokeSecretBrokers() {}
    } });
    manager.register(registration);
    process.stdout.write(JSON.stringify(api.inspectPrivateProfileCustody(registration.profilePath)) + '\\n');
    await manager.disconnect({ connectionId: registration.id, deletePurposes: [] });
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, JSON.stringify(registration), phase],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('exit', code => {
      if (![71, 72, 73, 74].includes(code)) reject(new Error(`killpoint child failed (${code}): ${stderr}`));
      else resolve({ exitCode: code, inspection: JSON.parse(stdout.trim()) });
    });
  });
}

async function recoverAfterKillpoint(registration, expectedCustodyId) {
  const moduleUrl = new URL('../dist/index.js', import.meta.url).href;
  const script = `
    import fs from 'node:fs';
    import path from 'node:path';
    import { syncBuiltinESMExports } from 'node:module';
    const originals = { openSync: fs.openSync, closeSync: fs.closeSync, fsyncSync: fs.fsyncSync };
    const opened = new Map(); let parentFsyncs = 0;
    fs.openSync = function(file, ...args) {
      const descriptor = originals.openSync.call(this, file, ...args); opened.set(descriptor, String(file));
      return descriptor;
    };
    fs.closeSync = function(descriptor, ...args) {
      opened.delete(descriptor); return originals.closeSync.call(this, descriptor, ...args);
    };
    fs.fsyncSync = function(descriptor, ...args) {
      if (opened.get(descriptor) === path.dirname(JSON.parse(process.argv[1]).profilePath)) parentFsyncs++;
      return originals.fsyncSync.call(this, descriptor, ...args);
    };
    syncBuiltinESMExports();
    const api = await import(${JSON.stringify(moduleUrl)});
    const registration = JSON.parse(process.argv[1]);
    const manager = new api.PrivateConnectionManager({ secretProvider: new api.SyntheticSecretProvider(), authority: {
      assertConnection() {}, async revokeConnection() {}, async revokeBrowserEpochs() {},
      async stopAndReleaseMonitors() {}, async revokeSecretBrokers() {}
    } });
    try {
      let state = manager.recover(registration, {
        expectedCustodyId: process.argv[2], confirmStaleProcessExited: true
      });
      if (state.state !== 'disconnected') state = await manager.disconnect({ connectionId: registration.id,
        deletePurposes: [] });
      process.stdout.write(JSON.stringify({ outcome: state.state, parentFsyncs,
        custodyExists: fs.existsSync(registration.profilePath + '.behalvo-private-custody'),
        receiptExists: fs.existsSync(registration.profilePath + '.behalvo-disconnect-' + registration.id + '-' +
          registration.generation + '.json') }));
    } catch { process.stdout.write(JSON.stringify({ outcome: 'rejected', parentFsyncs })); }
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, JSON.stringify(registration),
      expectedCustodyId], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('exit', code => {
      if (code !== 0) reject(new Error(`recovery child failed (${code}): ${stderr}`));
      else resolve(JSON.parse(stdout));
    });
  });
}

function startPartialStageWriter(registration, stage, cut, gatePath = '') {
  const moduleUrl = new URL('../dist/index.js', import.meta.url).href;
  const script = `
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    const originalWrite = fs.writeFileSync;
    const [registration, stage, cut, gatePath] = [JSON.parse(process.argv[1]), ...process.argv.slice(2)];
    fs.writeFileSync = function(path, data, ...args) {
      const name = String(path).split('/').pop();
      const matches = stage === 'checkpoint' ? name.startsWith('owner-') && name.endsWith('.tmp')
        : name.includes('.behalvo-disconnect-') && name.endsWith('.tmp');
      if (!matches) return originalWrite.call(this, path, data, ...args);
      const source = String(data);
      const headerEnd = stage === 'checkpoint' ? source.indexOf('\\n') + 1 : source.indexOf(',"deletePurposes"');
      const length = cut === 'zero' ? 0 : cut === 'partial_header' ? 5
        : cut === 'header' ? headerEnd : headerEnd + 5;
      originalWrite.call(this, path, source.slice(0, length), ...args);
      fs.writeSync(1, JSON.stringify({ stagePath: String(path), length }) + '\\n');
      if (gatePath) while (!fs.existsSync(gatePath)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      process.exit(75);
    };
    syncBuiltinESMExports();
    const api = await import(${JSON.stringify(moduleUrl)});
    const manager = new api.PrivateConnectionManager({ secretProvider: new api.SyntheticSecretProvider(), authority: {
      assertConnection() {}, async revokeConnection() {}, async revokeBrowserEpochs() {},
      async stopAndReleaseMonitors() {}, async revokeSecretBrokers() {}
    } });
    manager.register(registration);
    fs.writeSync(1, JSON.stringify(api.inspectPrivateProfileCustody(registration.profilePath)) + '\\n');
    await manager.disconnect({ connectionId: registration.id, deletePurposes: [] });
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script,
    JSON.stringify(registration), stage, cut, gatePath], { stdio: ['ignore', 'pipe', 'pipe'] });
  const nextLine = readLines(child.stdout);
  const exited = new Promise(resolve => child.once('exit', resolve));
  return { child, nextLine, exited };
}

for (const stage of ['checkpoint', 'receipt']) {
  for (const cut of ['zero', 'partial_header', 'header', 'partial_body']) {
    test(`abrupt ${stage} ${cut} write recovers from canonical state across repeated restarts`, async t => {
      const { profile } = privateDirectory(t);
      const registration = { id: 'connection-a', service: 'visa-scheduling', accountId: 'account-a', generation: 1,
        profileId: 'profile-a', profilePath: profile, mode: 'synthetic', dedicated: true,
        fullDiskEncryptionAcknowledged: false, secretReferences: [] };
      const writer = startPartialStageWriter(registration, stage, cut);
      t.after(() => writer.child.kill());
      const inspection = JSON.parse(await writer.nextLine());
      const partial = JSON.parse(await writer.nextLine());
      assert.equal(await writer.exited, 75);
      assert.equal(lstatSync(partial.stagePath).size, partial.length);
      const canonical = readFileSync(join(`${profile}.behalvo-private-custody`, 'owner.json'), 'utf8');
      assert.equal(JSON.parse(canonical.split('\n')[0]).custodyId, inspection.custodyId);
      for (let restart = 0; restart < 2; restart++) {
        const result = await recoverAfterKillpoint(registration, inspection.custodyId);
        assert.equal(result.outcome, 'disconnected', `${stage}/${cut}/restart ${restart}`);
        assert.equal(result.custodyExists, false);
        assert.equal(result.receiptExists, true);
        assert.ok(result.parentFsyncs > 0);
      }
      assert.equal(existsSync(partial.stagePath), false);
      const receipt = JSON.parse(readFileSync(`${profile}.behalvo-disconnect-connection-a-1.json`, 'utf8'));
      assert.equal(receipt.custodyId, inspection.custodyId);
      assert.equal(receipt.registrationDigest, JSON.parse(canonical.split('\n')[0]).registrationDigest);
      assert.deepEqual(receipt.deletedPurposes, []);
    });
  }

  test(`live ${stage} writer keeps its partial stage when stale recovery is requested`, async t => {
    const { root, profile } = privateDirectory(t);
    const gate = join(root, 'release-writer');
    const registration = { id: 'connection-a', service: 'visa-scheduling', accountId: 'account-a', generation: 1,
      profileId: 'profile-a', profilePath: profile, mode: 'synthetic', dedicated: true,
      fullDiskEncryptionAcknowledged: false, secretReferences: [] };
    const writer = startPartialStageWriter(registration, stage, 'partial_body', gate);
    t.after(() => writer.child.kill());
    const inspection = JSON.parse(await writer.nextLine());
    const { stagePath } = JSON.parse(await writer.nextLine());
    const before = readFileSync(stagePath);
    assert.equal((await recoverAfterKillpoint(registration, inspection.custodyId)).outcome, 'rejected');
    assert.deepEqual(readFileSync(stagePath), before);
    assert.equal(behalvo.inspectPrivateProfileCustody(profile).pid, writer.child.pid);
    writeFileSync(gate, 'release');
    assert.equal(await writer.exited, 75);
  });

  for (const corruption of ['foreign', 'custody', 'registration', 'symlink', 'hardlink', 'mode', 'uid', 'unexpected']) {
    test(`interrupted ${stage} recovery preserves ${corruption} staging artifacts`, async t => {
      if (corruption === 'uid' && process.geteuid?.() !== 0) return t.skip('changing file UID requires root');
      const { root, profile } = privateDirectory(t);
      const registration = { id: 'connection-a', service: 'visa-scheduling', accountId: 'account-a', generation: 1,
        profileId: 'profile-a', profilePath: profile, mode: 'synthetic', dedicated: true,
        fullDiskEncryptionAcknowledged: false, secretReferences: [] };
      const writer = startPartialStageWriter(registration, stage, 'zero');
      t.after(() => writer.child.kill());
      const inspection = JSON.parse(await writer.nextLine());
      const { stagePath } = JSON.parse(await writer.nextLine());
      assert.equal(await writer.exited, 75);
      let preservedPath = stagePath;
      const foreign = join(root, 'unrelated-private-file');
      writeFileSync(foreign, 'foreign-owned-data', { mode: 0o600 });
      if (corruption === 'foreign') writeFileSync(stagePath, '{"foreign":true}\n');
      if (corruption === 'custody' || corruption === 'registration') {
        const header = JSON.parse(readFileSync(join(`${profile}.behalvo-private-custody`, 'owner.json'), 'utf8').split('\n')[0]);
        if (corruption === 'custody') header.custodyId = 'Z'.repeat(43);
        if (corruption === 'registration') header.registrationDigest = '0'.repeat(64);
        const value = stage === 'checkpoint' ? header : { version: 1, custodyId: header.custodyId,
          registrationDigest: header.registrationDigest, profileDevice: header.profileDevice,
          profileInode: header.profileInode, deletePurposes: [], deletedPurposes: [] };
        writeFileSync(stagePath, JSON.stringify(value) + '\n');
      }
      if (corruption === 'symlink') { unlinkSync(stagePath); symlinkSync(foreign, stagePath); }
      if (corruption === 'hardlink') { unlinkSync(stagePath); linkSync(foreign, stagePath); }
      if (corruption === 'mode') chmodSync(stagePath, 0o644);
      if (corruption === 'uid') {
        try { chownSync(stagePath, 1, 1); }
        catch (error) {
          if (['EINVAL', 'EPERM', 'ENOTSUP'].includes(error.code))
            return t.skip('filesystem does not permit a foreign-UID fixture');
          throw error;
        }
      }
      if (corruption === 'unexpected') {
        preservedPath = join(`${profile}.behalvo-private-custody`, 'owner-unrecognized.tmp');
        writeFileSync(preservedPath, '', { mode: 0o600 });
      }
      const before = lstatSync(preservedPath);
      for (let restart = 0; restart < 2; restart++)
        assert.equal((await recoverAfterKillpoint(registration, inspection.custodyId)).outcome, 'rejected');
      assert.equal(lstatSync(preservedPath).ino, before.ino);
      assert.equal(readFileSync(foreign, 'utf8'), 'foreign-owned-data');
      assert.ok(existsSync(join(`${profile}.behalvo-private-custody`, 'owner.json')));
    });
  }

  test(`live elected recovery claimant excludes removal of an interrupted ${stage} stage`, async t => {
    const { root, profile } = privateDirectory(t);
    const gate = join(root, 'release-claim');
    const registration = { id: 'connection-a', service: 'visa-scheduling', accountId: 'account-a', generation: 1,
      profileId: 'profile-a', profilePath: profile, mode: 'synthetic', dedicated: true,
      fullDiskEncryptionAcknowledged: false, secretReferences: [] };
    const writer = startPartialStageWriter(registration, stage, 'partial_body');
    t.after(() => writer.child.kill());
    const inspection = JSON.parse(await writer.nextLine());
    const { stagePath } = JSON.parse(await writer.nextLine());
    assert.equal(await writer.exited, 75);
    const before = readFileSync(stagePath);
    const moduleUrl = new URL('../dist/index.js', import.meta.url).href;
    const script = `
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      const originalLink = fs.linkSync;
      fs.linkSync = function(source, target, ...args) {
        const result = originalLink.call(this, source, target, ...args);
        if (String(target).includes('/recovery-election-')) {
          fs.writeSync(1, 'elected\\n');
          while (!fs.existsSync(process.argv[3])) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
        }
        return result;
      };
      syncBuiltinESMExports();
      const api = await import(${JSON.stringify(moduleUrl)});
      const registration = JSON.parse(process.argv[1]);
      const manager = new api.PrivateConnectionManager({ secretProvider: new api.SyntheticSecretProvider(), authority: {
        assertConnection() {}, async revokeConnection() {}, async revokeBrowserEpochs() {},
        async stopAndReleaseMonitors() {}, async revokeSecretBrokers() {}
      } });
      manager.recover(registration, { expectedCustodyId: process.argv[2], confirmStaleProcessExited: true });
      await manager.disconnect({ connectionId: registration.id, deletePurposes: [] });
      fs.writeSync(1, 'disconnected\\n');
    `;
    const claimant = spawn(process.execPath, ['--input-type=module', '-e', script, JSON.stringify(registration),
      inspection.custodyId, gate], { stdio: ['ignore', 'pipe', 'pipe'] });
    t.after(() => claimant.kill());
    const nextLine = readLines(claimant.stdout);
    const exited = new Promise(resolve => claimant.once('exit', resolve));
    assert.equal(await nextLine(), 'elected');
    assert.equal((await recoverAfterKillpoint(registration, inspection.custodyId)).outcome, 'rejected');
    assert.deepEqual(readFileSync(stagePath), before);
    assert.equal(behalvo.inspectPrivateProfileCustody(profile).pid, inspection.pid);
    writeFileSync(gate, 'release');
    assert.equal(await nextLine(), 'disconnected');
    assert.equal(await exited, 0);
    assert.equal(existsSync(stagePath), false);
    assert.equal(existsSync(`${profile}.behalvo-private-custody`), false);
  });
}

async function runDisconnectPersistenceFault(profile, phase, failureMode, retry = true) {
  const moduleUrl = new URL('../dist/index.js', import.meta.url).href;
  const script = `
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    const phase = process.argv[2];
    const failureMode = process.argv[3];
    const originals = { appendFileSync: fs.appendFileSync, writeFileSync: fs.writeFileSync,
      unlinkSync: fs.unlinkSync };
    let attempts = 0;
    let injected = false;
    function matches(path, data) {
      if (phase === 'receipt') return String(path).includes('.behalvo-disconnect-');
      try {
        const lines = String(data).trimEnd().split('\\n');
        return JSON.parse(lines[lines.length - 1]).type === phase;
      } catch { return false; }
    }
    for (const method of ['appendFileSync', 'writeFileSync']) {
      fs[method] = function(path, data, ...args) {
        if (matches(path, data)) {
          attempts++;
          if (!injected) {
            injected = true;
            if (failureMode === 'partial') {
              const source = typeof data === 'string' ? data : data.toString('utf8');
              originals[method].call(this, path, source.slice(0, Math.max(1, Math.floor(source.length / 2))), ...args);
            } else if (failureMode === 'after') originals[method].call(this, path, data, ...args);
            const error = new Error('injected persistence failure'); error.code = 'EIO'; throw error;
          }
        }
        return originals[method].call(this, path, data, ...args);
      };
    }
    fs.unlinkSync = function(path, ...args) {
      if (phase === 'release' && String(path).endsWith('/owner.json')) {
        attempts++;
        if (!injected) {
          injected = true;
          const error = new Error('injected release failure'); error.code = 'EIO'; throw error;
        }
      }
      return originals.unlinkSync.call(this, path, ...args);
    };
    syncBuiltinESMExports();
    const api = await import(${JSON.stringify(moduleUrl)});
    const provider = new api.SyntheticSecretProvider();
    const registration = JSON.parse(process.argv[1]);
    let deletePurposes = [];
    if (phase === 'secret.deleted') {
      const value = new Uint8Array([11, 22, 33, 44]);
      registration.secretReferences = [await provider.put({ service: registration.service,
        connectionId: registration.id, purpose: 'password', accountId: registration.accountId, value })];
      value.fill(0); deletePurposes = ['password'];
    }
    const calls = { connection: 0, browser: 0, broker: 0, monitors: 0 };
    const manager = new api.PrivateConnectionManager({ secretProvider: provider, authority: {
      assertConnection() {}, async revokeConnection() { calls.connection++; },
      async revokeBrowserEpochs() { calls.browser++; }, async revokeSecretBrokers() { calls.broker++; },
      async stopAndReleaseMonitors() { calls.monitors++; }
    } });
    manager.register(registration);
    let firstFailed = false;
    try { await manager.disconnect({ connectionId: registration.id, deletePurposes }); }
    catch { firstFailed = true; }
    const firstState = manager.list()[0].state;
    const firstCustody = api.inspectPrivateProfileCustody(registration.profilePath) !== null;
    if (process.argv[4] === 'stop') {
      fs.writeSync(1, JSON.stringify({ attempts, firstFailed, firstState, firstCustody, registration,
        inspection: api.inspectPrivateProfileCustody(registration.profilePath), calls }));
      process.exit(0);
    }
    let secondOutcome = 'failed';
    try {
      secondOutcome = (await manager.disconnect({ connectionId: registration.id, deletePurposes })).state;
    } catch {}
    process.stdout.write(JSON.stringify({ attempts, firstFailed, firstState, firstCustody, secondOutcome,
      secondState: manager.list()[0].state,
      custodyAfter: api.inspectPrivateProfileCustody(registration.profilePath) !== null,
      receiptAfter: fs.existsSync(registration.profilePath + '.behalvo-disconnect-' + registration.id + '-' +
        registration.generation + '.json'), calls }));
  `;
  const registration = { id: 'connection-a', service: 'visa-scheduling', accountId: 'account-a', generation: 1,
    profileId: 'profile-a', profilePath: profile, mode: 'synthetic', dedicated: true,
    fullDiskEncryptionAcknowledged: false, secretReferences: [] };
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, JSON.stringify(registration), phase,
      failureMode, retry ? 'retry' : 'stop'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('exit', code => {
      if (code !== 0) reject(new Error(`fault subprocess failed (${code}): ${stderr}`));
      else resolve(JSON.parse(stdout));
    });
  });
}

async function leaveStaleCustody(registration, exitCode = 23) {
  const moduleUrl = new URL('../dist/index.js', import.meta.url).href;
  const script = `
    import * as api from ${JSON.stringify(moduleUrl)};
    const manager = new api.PrivateConnectionManager({ secretProvider: new api.SyntheticSecretProvider(), authority: {
      assertConnection() {}, async revokeConnection() {}, async revokeBrowserEpochs() { process.exit(${exitCode}); },
      async stopAndReleaseMonitors() {}, async revokeSecretBrokers() {}
    } });
    const registration = JSON.parse(process.argv[1]);
    manager.register(registration);
    process.stdout.write(JSON.stringify(api.inspectPrivateProfileCustody(registration.profilePath)) + '\\n');
    await manager.disconnect({ connectionId: registration.id, deletePurposes: [] });
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, JSON.stringify(registration)],
    { stdio: ['ignore', 'pipe', 'ignore'] });
  let output = '';
  child.stdout.setEncoding('utf8'); child.stdout.on('data', chunk => { output += chunk; });
  const actualExitCode = await new Promise(resolve => child.once('exit', code => resolve(code)));
  assert.equal(actualExitCode, exitCode);
  return JSON.parse(output.trim());
}

test('private connection requires dedicated local custody and full-disk-encryption acknowledgement in live mode', async t => {
  const { root, profile } = privateDirectory(t);
  const provider = new SyntheticSecretProvider();
  const manager = new PrivateConnectionManager({ secretProvider: provider, platform: 'darwin', authority: authority() });

  assert.throws(() => manager.register({ id: 'connection-a', service: 'visa-scheduling', accountId: 'account-a',
    generation: 1, profileId: 'profile-a', profilePath: profile, mode: 'live', dedicated: true,
    fullDiskEncryptionAcknowledged: false, secretReferences: [] }), /Private connection operation failed\./);

  const cloud = join(root, 'Dropbox');
  mkdirSync(cloud, { mode: 0o700 });
  assert.throws(() => manager.register({ id: 'connection-a', service: 'visa-scheduling', accountId: 'account-a',
    generation: 1, profileId: 'profile-a', profilePath: cloud, mode: 'live', dedicated: true,
    fullDiskEncryptionAcknowledged: true, secretReferences: [] }), /Private connection operation failed\./);

  const brandedCloud = join(root, 'OneDrive - Example Org');
  mkdirSync(brandedCloud, { mode: 0o700 });
  assert.throws(() => manager.register({ id: 'connection-a', service: 'visa-scheduling', accountId: 'account-a',
    generation: 1, profileId: 'profile-a', profilePath: brandedCloud, mode: 'live', dedicated: true,
    fullDiskEncryptionAcknowledged: true, secretReferences: [] }), /Private connection operation failed\./);

  const cloudDocs = join(root, 'Library', 'Mobile Documents', 'com~apple~CloudDocs', 'profile');
  mkdirSync(cloudDocs, { recursive: true, mode: 0o700 });
  for (const path of [join(root, 'Library'), join(root, 'Library', 'Mobile Documents'),
    join(root, 'Library', 'Mobile Documents', 'com~apple~CloudDocs')]) chmodSync(path, 0o700);
  assert.throws(() => manager.register({ id: 'connection-a', service: 'visa-scheduling', accountId: 'account-a',
    generation: 1, profileId: 'profile-a', profilePath: cloudDocs, mode: 'live', dedicated: true,
    fullDiskEncryptionAcknowledged: true, secretReferences: [] }), /Private connection operation failed\./);

  const boxSync = join(root, 'Box Sync', 'profile');
  mkdirSync(boxSync, { recursive: true, mode: 0o700 });
  chmodSync(join(root, 'Box Sync'), 0o700);
  assert.throws(() => manager.register({ id: 'connection-a', service: 'visa-scheduling', accountId: 'account-a',
    generation: 1, profileId: 'profile-a', profilePath: boxSync, mode: 'live', dedicated: true,
    fullDiskEncryptionAcknowledged: true, secretReferences: [] }), /Private connection operation failed\./);

  const alias = join(root, 'alias');
  symlinkSync(profile, alias);
  assert.throws(() => manager.register({ id: 'connection-a', service: 'visa-scheduling', accountId: 'account-a',
    generation: 1, profileId: 'profile-a', profilePath: alias, mode: 'live', dedicated: true,
    fullDiskEncryptionAcknowledged: true, secretReferences: [] }), /Private connection operation failed\./);

  const repository = join(root, 'repository');
  mkdirSync(repository, { mode: 0o700 });
  mkdirSync(join(repository, '.git'), { mode: 0o700 });
  const trackedProfile = join(repository, 'profile');
  mkdirSync(trackedProfile, { mode: 0o700 });
  assert.throws(() => manager.register({ id: 'connection-a', service: 'visa-scheduling', accountId: 'account-a',
    generation: 1, profileId: 'profile-a', profilePath: trackedProfile, mode: 'live', dedicated: true,
    fullDiskEncryptionAcknowledged: true, secretReferences: [] }), /Private connection operation failed\./);

  const unsafeParent = join(root, 'unsafe-parent');
  mkdirSync(unsafeParent, { mode: 0o755 });
  const privatelyModeledLeaf = join(unsafeParent, 'profile');
  mkdirSync(privatelyModeledLeaf, { mode: 0o700 });
  assert.throws(() => manager.register({ id: 'connection-a', service: 'visa-scheduling', accountId: 'account-a',
    generation: 1, profileId: 'profile-a', profilePath: privatelyModeledLeaf, mode: 'live', dedicated: true,
    fullDiskEncryptionAcknowledged: true, secretReferences: [] }), /Private connection operation failed\./);

  writeFileSync(join(profile, 'SingletonLock'), 'chrome-owner');
  assert.throws(() => manager.register({ id: 'connection-a', service: 'visa-scheduling', accountId: 'account-a',
    generation: 1, profileId: 'profile-a', profilePath: profile, mode: 'live', dedicated: true,
    fullDiskEncryptionAcknowledged: true, secretReferences: [] }), /Private connection operation failed\./);
});

test('every Chrome Singleton directory entry blocks profile registration without following it', async t => {
  const inputFor = profilePath => ({ id: 'connection-a', service: 'visa-scheduling', accountId: 'account-a',
    generation: 1, profileId: 'profile-a', profilePath, mode: 'synthetic', dedicated: true,
    fullDiskEncryptionAcknowledged: false, secretReferences: [] });
  for (const marker of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    const { profile } = privateDirectory(t, `dangling-${marker}`);
    symlinkSync('missing-chrome-owner', join(profile, marker));
    const manager = new PrivateConnectionManager({ secretProvider: new SyntheticSecretProvider(),
      authority: authority() });
    assert.throws(() => manager.register(inputFor(profile)), /Private connection operation failed\./,
      `${marker} dangling symlink must be treated as an existing ownership marker`);
  }

  const { root, profile: linkedProfile } = privateDirectory(t, 'linked-marker');
  const target = join(root, 'chrome-owner');
  writeFileSync(target, 'owner');
  symlinkSync(target, join(linkedProfile, 'SingletonCookie'));
  assert.throws(() => new PrivateConnectionManager({ secretProvider: new SyntheticSecretProvider(),
    authority: authority() }).register(inputFor(linkedProfile)), /Private connection operation failed\./);

});

test('a Chrome Singleton socket entry blocks profile registration', async t => {
  const { profile: socketProfile } = privateDirectory(t, 'socket-marker');
  const socketPath = join(socketProfile, 'SingletonSocket');
  const server = createServer();
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject); server.listen(socketPath, resolve);
    });
  } catch (error) {
    if (error?.code === 'EPERM') { t.skip('filesystem does not permit a Unix-domain socket fixture'); return; }
    throw error;
  }
  t.after(() => server.close());
  const input = { id: 'connection-a', service: 'visa-scheduling', accountId: 'account-a', generation: 1,
    profileId: 'profile-a', profilePath: socketProfile, mode: 'synthetic', dedicated: true,
    fullDiskEncryptionAcknowledged: false, secretReferences: [] };
  assert.throws(() => new PrivateConnectionManager({ secretProvider: new SyntheticSecretProvider(),
    authority: authority() }).register(input), /Private connection operation failed\./);
  await new Promise(resolve => server.close(resolve));
  if (existsSync(socketPath)) unlinkSync(socketPath);
});

test('disconnect revokes authority before monitors, deletes selected secrets, and only offers profile removal', async t => {
  const { profile } = privateDirectory(t);
  const provider = new SyntheticSecretProvider();
  const password = await secret(provider, 'password');
  const answer = await secret(provider, 'security-answer');
  const order = [];
  const manager = new PrivateConnectionManager({ secretProvider: provider, authority: authority({
    revokeConnection: async connection => { order.push(`connection:${connection.id}`); },
    revokeBrowserEpochs: async connection => { order.push(`browser:${connection.profileId}`); },
    revokeSecretBrokers: async connection => { order.push(`broker:${connection.id}`); },
    stopAndReleaseMonitors: async connection => { order.push(`monitors:${connection.id}`); }
  }) });
  manager.register({ id: 'connection-a', service: 'visa-scheduling', accountId: 'account-a', generation: 1,
    profileId: 'profile-a', profilePath: profile, mode: 'synthetic', dedicated: true,
    fullDiskEncryptionAcknowledged: false, secretReferences: [password, answer] });

  assert.deepEqual(manager.list(), [{ id: 'connection-a', service: 'visa-scheduling', generation: 1,
    profileId: 'profile-a', mode: 'synthetic', state: 'connected', secretPurposes: ['password', 'security-answer'] }]);
  await assert.rejects(manager.disconnect({ connectionId: 'connection-a', deletePurposes: ['unknown-purpose'] }),
    /Private connection operation failed\./);
  assert.equal(manager.list()[0].state, 'connected');
  const result = await manager.disconnect({ connectionId: 'connection-a', deletePurposes: ['password'] });
  assert.deepEqual(order, ['connection:connection-a', 'browser:profile-a', 'broker:connection-a',
    'monitors:connection-a']);
  assert.deepEqual(result, { connectionId: 'connection-a', state: 'disconnected', profileRemovalOffered: true,
    profilePath: profile, deletedPurposes: ['password'] });
  assert.deepEqual(await manager.disconnect({ connectionId: 'connection-a', deletePurposes: ['password'] }), result,
    'a repeated request after a lost acknowledgement must return the completed receipt');
  assert.equal(existsSync(profile), true, 'disconnect must not recursively remove the profile');
  assert.deepEqual((await provider.list({ service: 'visa-scheduling', connectionId: 'connection-a',
    accountId: 'account-a' })).map(item => item.purpose), ['security-answer']);
  await assert.rejects(manager.disconnect({ connectionId: 'connection-a', deletePurposes: [], extra: true }),
    /Private connection operation failed\./);
});

test('disconnect retries only incomplete authority and deletion phases without restoring authority', async t => {
  const { profile } = privateDirectory(t);
  const stored = new SyntheticSecretProvider();
  const password = await secret(stored, 'password');
  const answer = await secret(stored, 'security-answer');
  const deleteCalls = [];
  let failAnswer = true;
  const provider = {
    put: stored.put.bind(stored), withSecret: stored.withSecret.bind(stored), list: stored.list.bind(stored),
    async delete(reference) {
      deleteCalls.push(reference.purpose);
      if (reference.purpose === 'security-answer' && failAnswer) {
        failAnswer = false;
        throw new Error('synthetic transient');
      }
      await stored.delete(reference);
    }
  };
  const calls = { connection: 0, browser: 0, broker: 0, monitors: 0 };
  const manager = new PrivateConnectionManager({ secretProvider: provider, authority: authority({
    async revokeConnection() { calls.connection++; }, async revokeBrowserEpochs() { calls.browser++; },
    async revokeSecretBrokers() { calls.broker++; }, async stopAndReleaseMonitors() { calls.monitors++; }
  }) });
  manager.register({ id: 'connection-a', service: 'visa-scheduling', accountId: 'account-a', generation: 1,
    profileId: 'profile-a', profilePath: profile, mode: 'synthetic', dedicated: true,
    fullDiskEncryptionAcknowledged: false, secretReferences: [password, answer] });

  const request = { connectionId: 'connection-a', deletePurposes: ['password', 'security-answer'] };
  await assert.rejects(manager.disconnect(request), /Private connection operation failed\./);
  assert.equal(manager.list()[0].state, 'disconnect_failed');
  const result = await manager.disconnect(request);
  assert.equal(result.state, 'disconnected');
  assert.deepEqual(calls, { connection: 1, browser: 1, broker: 1, monitors: 1 });
  assert.deepEqual(deleteCalls, ['password', 'security-answer', 'security-answer']);
  assert.deepEqual(await stored.list({ service: 'visa-scheduling', connectionId: 'connection-a',
    accountId: 'account-a' }), []);
});

test('disconnect retries every checkpoint and publishes no success before receipt and custody release', async t => {
  const cases = [
    ...['disconnect.started', 'connection.revoked', 'browser.revoked', 'brokers.revoked', 'monitors.stopped',
      'secret.deleted', 'disconnect.completed', 'receipt', 'release'].map(phase => [phase, 'before']),
    ['disconnect.completed', 'partial'], ['disconnect.completed', 'after'],
    ['receipt', 'partial'], ['receipt', 'after']
  ];
  for (const [phase, failureMode] of cases) {
    const { profile } = privateDirectory(t, `${phase.replace('.', '-')}-${failureMode}`);
    const result = await runDisconnectPersistenceFault(profile, phase, failureMode);
    assert.equal(result.firstFailed, true, `${phase}/${failureMode} must reject the uncheckpointed attempt`);
    assert.equal(result.firstState, 'disconnect_failed');
    assert.equal(result.firstCustody, true, `${phase}/${failureMode} must retain custody after failure`);
    assert.equal(result.attempts, 2, `${phase}/${failureMode} must durably retry the failed write`);
    assert.equal(result.secondOutcome, 'disconnected');
    assert.equal(result.secondState, 'disconnected');
    assert.equal(result.receiptAfter, true, `${phase}/${failureMode} cannot report success without a receipt`);
    assert.equal(result.custodyAfter, false, `${phase}/${failureMode} must release custody only after receipt`);
    const effect = { 'connection.revoked': 'connection', 'browser.revoked': 'browser',
      'brokers.revoked': 'broker', 'monitors.stopped': 'monitors' }[phase];
    if (effect) assert.equal(result.calls[effect], 2, `${phase} effect must reconcile before its retry checkpoint`);
  }
});

test('restart resumes every failed checkpoint without returning an unreceipted success', async t => {
  for (const phase of ['disconnect.started', 'connection.revoked', 'browser.revoked', 'brokers.revoked',
    'monitors.stopped', 'secret.deleted', 'disconnect.completed', 'receipt', 'release']) {
    const { profile } = privateDirectory(t, `restart-${phase.replace('.', '-')}`);
    const failed = await runDisconnectPersistenceFault(profile, phase, 'before', false);
    assert.equal(failed.firstFailed, true, `${phase} fixture must leave failed live-process state`);
    assert.equal(failed.firstCustody, true);
    const restarted = new PrivateConnectionManager({ secretProvider: new SyntheticSecretProvider(),
      authority: authority() });
    const recovered = restarted.recover(failed.registration, { expectedCustodyId: failed.inspection.custodyId,
      confirmStaleProcessExited: true });
    if (recovered.state !== 'disconnected') {
      assert.equal((await restarted.disconnect({ connectionId: failed.registration.id,
        deletePurposes: phase === 'secret.deleted' ? ['password'] : [] })).state, 'disconnected');
    }
    assert.equal(restarted.list()[0].state, 'disconnected');
    assert.equal(behalvo.inspectPrivateProfileCustody(profile), null);
    assert.equal(existsSync(`${profile}.behalvo-disconnect-connection-a-1.json`), true);
  }
});

test('abrupt disconnect finalization boundaries converge from exact custody and receipt evidence', async t => {
  const expectedExit = { checkpoint_stage: 71, receipt_link: 72, owner_unlink: 73, custody_rmdir: 74 };
  for (const phase of Object.keys(expectedExit)) {
    const { profile } = privateDirectory(t, `kill-${phase}`);
    const registration = { id: 'connection-a', service: 'visa-scheduling', accountId: 'account-a', generation: 1,
      profileId: 'profile-a', profilePath: profile, mode: 'synthetic', dedicated: true,
      fullDiskEncryptionAcknowledged: false, secretReferences: [] };
    const crashed = await crashDisconnectAt(registration, phase);
    assert.equal(crashed.exitCode, expectedExit[phase]);
    const recovered = await recoverAfterKillpoint(registration, crashed.inspection.custodyId);
    assert.equal(recovered.outcome, 'disconnected', `${phase} must be restart-replayable`);
    assert.equal(recovered.custodyExists, false, `${phase} must durably release custody`);
    assert.equal(recovered.receiptExists, true, `${phase} must retain the exact receipt`);
    if (phase === 'custody_rmdir') assert.ok(recovered.parentFsyncs >= 1,
      'restart after rmdir must durably sync the already-removed custody directory');
    assert.deepEqual(readdirSync(dirname(profile)).filter(name =>
      name.startsWith(`${profile.split('/').pop()}.behalvo-disconnect-`) && name.includes('.tmp')), [],
    `${phase} must leave no receipt staging name`);
  }
});

test('same-process retry completes release after parent-directory fsync uncertainty', async t => {
  const { profile } = privateDirectory(t, 'release-fsync');
  const moduleUrl = new URL('../dist/index.js', import.meta.url).href;
  const script = `
    import fs from 'node:fs';
    import path from 'node:path';
    import { syncBuiltinESMExports } from 'node:module';
    const originals = { openSync: fs.openSync, closeSync: fs.closeSync, fsyncSync: fs.fsyncSync,
      rmdirSync: fs.rmdirSync };
    const opened = new Map(); let removed = false; let failed = false;
    fs.openSync = function(file, ...args) {
      const descriptor = originals.openSync.call(this, file, ...args); opened.set(descriptor, String(file));
      return descriptor;
    };
    fs.closeSync = function(descriptor, ...args) {
      opened.delete(descriptor); return originals.closeSync.call(this, descriptor, ...args);
    };
    fs.rmdirSync = function(directory, ...args) {
      const result = originals.rmdirSync.call(this, directory, ...args);
      if (String(directory).endsWith('.behalvo-private-custody')) removed = true;
      return result;
    };
    fs.fsyncSync = function(descriptor, ...args) {
      if (removed && !failed && opened.get(descriptor) === path.dirname(JSON.parse(process.argv[1]).profilePath)) {
        failed = true; const error = new Error('injected parent fsync uncertainty'); error.code = 'EIO'; throw error;
      }
      return originals.fsyncSync.call(this, descriptor, ...args);
    };
    syncBuiltinESMExports();
    const api = await import(${JSON.stringify(moduleUrl)});
    const registration = JSON.parse(process.argv[1]);
    const manager = new api.PrivateConnectionManager({ secretProvider: new api.SyntheticSecretProvider(), authority: {
      assertConnection() {}, async revokeConnection() {}, async revokeBrowserEpochs() {},
      async stopAndReleaseMonitors() {}, async revokeSecretBrokers() {}
    } });
    manager.register(registration);
    const request = { connectionId: registration.id, deletePurposes: [] };
    const results = [];
    try { await manager.disconnect(request); results.push('success'); } catch { results.push('failure'); }
    try { results.push((await manager.disconnect(request)).state); } catch { results.push('failure'); }
    process.stdout.write(JSON.stringify({ results, state: manager.list()[0].state,
      custodyExists: fs.existsSync(registration.profilePath + '.behalvo-private-custody'),
      receiptExists: fs.existsSync(registration.profilePath + '.behalvo-disconnect-' + registration.id + '-' +
        registration.generation + '.json') }));
  `;
  const registration = { id: 'connection-a', service: 'visa-scheduling', accountId: 'account-a', generation: 1,
    profileId: 'profile-a', profilePath: profile, mode: 'synthetic', dedicated: true,
    fullDiskEncryptionAcknowledged: false, secretReferences: [] };
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, JSON.stringify(registration)],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('exit', code => code === 0 ? resolve(JSON.parse(stdout)) : reject(new Error(stderr)));
  });
  assert.deepEqual(result.results, ['failure', 'disconnected']);
  assert.equal(result.state, 'disconnected');
  assert.equal(result.custodyExists, false);
  assert.equal(result.receiptExists, true);
});

test('disconnect reconciles an ambiguous successful deletion before retrying it', async t => {
  const { profile } = privateDirectory(t);
  const stored = new SyntheticSecretProvider();
  const password = await secret(stored, 'password');
  let deleteCalls = 0;
  const provider = {
    put: stored.put.bind(stored), withSecret: stored.withSecret.bind(stored), list: stored.list.bind(stored),
    async delete(reference) {
      deleteCalls++;
      await stored.delete(reference);
      if (deleteCalls === 1) throw new Error('lost delete acknowledgement');
    }
  };
  const manager = new PrivateConnectionManager({ secretProvider: provider, authority: authority() });
  manager.register({ id: 'connection-a', service: 'visa-scheduling', accountId: 'account-a', generation: 1,
    profileId: 'profile-a', profilePath: profile, mode: 'synthetic', dedicated: true,
    fullDiskEncryptionAcknowledged: false, secretReferences: [password] });
  const request = { connectionId: 'connection-a', deletePurposes: ['password'] };
  assert.equal((await manager.disconnect(request)).state, 'disconnected');
  assert.equal(deleteCalls, 1, 'confirmed absence must not replay the deletion');
});

test('disconnect retries a transient first revocation and then drains remaining phases', async t => {
  const { profile } = privateDirectory(t);
  let revocations = 0;
  const manager = new PrivateConnectionManager({ secretProvider: new SyntheticSecretProvider(), authority: authority({
    async revokeConnection() { if (++revocations === 1) throw new Error('transient'); }
  }) });
  manager.register({ id: 'connection-a', service: 'visa-scheduling', accountId: 'account-a', generation: 1,
    profileId: 'profile-a', profilePath: profile, mode: 'synthetic', dedicated: true,
    fullDiskEncryptionAcknowledged: false, secretReferences: [] });
  const request = { connectionId: 'connection-a', deletePurposes: [] };
  await assert.rejects(manager.disconnect(request), /Private connection operation failed\./);
  assert.equal(manager.list()[0].state, 'disconnect_failed');
  assert.equal((await manager.disconnect(request)).state, 'disconnected');
  assert.equal(revocations, 2);
});

test('identical concurrent disconnect requests share one cleanup attempt', async t => {
  const { profile } = privateDirectory(t);
  let release;
  let revocations = 0;
  const held = new Promise(resolve => { release = resolve; });
  const manager = new PrivateConnectionManager({ secretProvider: new SyntheticSecretProvider(), authority: authority({
    async revokeConnection() { revocations++; await held; }
  }) });
  manager.register({ id: 'connection-a', service: 'visa-scheduling', accountId: 'account-a', generation: 1,
    profileId: 'profile-a', profilePath: profile, mode: 'synthetic', dedicated: true,
    fullDiskEncryptionAcknowledged: false, secretReferences: [] });
  const request = { connectionId: 'connection-a', deletePurposes: [] };
  const first = manager.disconnect(request);
  const second = manager.disconnect(request);
  release();
  assert.deepEqual(await first, await second);
  assert.equal(revocations, 1);
});

test('one profile has one owner across managers until disconnect releases it', t => {
  const { profile } = privateDirectory(t);
  const first = new PrivateConnectionManager({ secretProvider: new SyntheticSecretProvider(), authority: authority() });
  const second = new PrivateConnectionManager({ secretProvider: new SyntheticSecretProvider(), authority: authority() });
  const input = { id: 'connection-a', service: 'visa-scheduling', accountId: 'account-a', generation: 1,
    profileId: 'profile-a', profilePath: profile, mode: 'synthetic', dedicated: true,
    fullDiskEncryptionAcknowledged: false, secretReferences: [] };
  first.register(input);
  assert.throws(() => second.register({ ...input, id: 'connection-b' }), /Private connection operation failed\./);

  rmSync(profile, { recursive: true });
  mkdirSync(profile, { mode: 0o700 });
  assert.throws(() => second.register({ ...input, id: 'connection-c' }), /Private connection operation failed\./);
});

test('profile custody excludes a second service process', async t => {
  const { profile } = privateDirectory(t);
  const first = new PrivateConnectionManager({ secretProvider: new SyntheticSecretProvider(), authority: authority() });
  first.register({ id: 'connection-a', service: 'visa-scheduling', accountId: 'account-a', generation: 1,
    profileId: 'profile-a', profilePath: profile, mode: 'synthetic', dedicated: true,
    fullDiskEncryptionAcknowledged: false, secretReferences: [] });
  const moduleUrl = new URL('../dist/index.js', import.meta.url).href;
  const script = `
    import { PrivateConnectionManager, SyntheticSecretProvider } from ${JSON.stringify(moduleUrl)};
    const manager = new PrivateConnectionManager({ secretProvider: new SyntheticSecretProvider(), authority: {
      assertConnection() {}, async revokeConnection() {}, async revokeBrowserEpochs() {},
      async stopAndReleaseMonitors() {}, async revokeSecretBrokers() {}
    } });
    manager.register(JSON.parse(process.argv[1]));
  `;
  const input = JSON.stringify({ id: 'connection-b', service: 'visa-scheduling', accountId: 'account-b', generation: 1,
    profileId: 'profile-b', profilePath: profile, mode: 'synthetic', dedicated: true,
    fullDiskEncryptionAcknowledged: false, secretReferences: [] });
  const exitCode = await new Promise(resolve => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, input],
      { stdio: ['ignore', 'ignore', 'ignore'] });
    child.once('exit', code => resolve(code));
  });
  assert.notEqual(exitCode, 0, 'a second process must not acquire the same profile');
});

test('only one delayed subprocess can recover the same stale profile custody', async t => {
  for (let iteration = 0; iteration < 3; iteration++) {
    const { root, profile } = privateDirectory(t, `profile-${iteration}`);
    const registration = { id: 'connection-a', service: 'visa-scheduling', accountId: 'account-a', generation: 1,
      profileId: 'profile-a', profilePath: profile, mode: 'synthetic', dedicated: true,
      fullDiskEncryptionAcknowledged: false, secretReferences: [] };
    const inspection = await leaveStaleCustody(registration, 40 + iteration);
    const firstGate = join(root, 'release-first');
    const secondGate = join(root, 'release-second');
    const first = startHeldRecovery(registration, firstGate, inspection.custodyId);
    const second = startHeldRecovery(registration, secondGate, inspection.custodyId);
    t.after(() => { first.child.kill(); second.child.kill(); });
    assert.equal(await first.nextLine(), 'read');
    assert.equal(await second.nextLine(), 'read');

    writeFileSync(firstGate, 'release');
    const winner = JSON.parse(await first.nextLine());
    assert.equal(winner.outcome, 'connected');
    assert.equal(behalvo.inspectPrivateProfileCustody(profile).pid, winner.pid);

    writeFileSync(secondGate, 'release');
    const loser = JSON.parse(await second.nextLine());
    assert.equal(loser.outcome, 'rejected', 'the delayed stale snapshot must not steal live custody');
    assert.equal(behalvo.inspectPrivateProfileCustody(profile).pid, winner.pid,
      'the winner custody must remain intact');
    process.kill(winner.pid, 0);
    first.child.kill(); second.child.kill();
  }
});

test('a crashed recovery claim is reclaimed by exactly one later subprocess', async t => {
  const exitByPhase = { claim: 61, staging: 62, publication: 63, claim_cleanup: 64 };
  for (const [phase, expectedExit] of Object.entries(exitByPhase)) {
    for (let iteration = 0; iteration < 2; iteration++) {
      const { profile } = privateDirectory(t, `${phase}-${iteration}`);
      const registration = { id: 'connection-a', service: 'visa-scheduling', accountId: 'account-a', generation: 1,
        profileId: 'profile-a', profilePath: profile, mode: 'synthetic', dedicated: true,
        fullDiskEncryptionAcknowledged: false, secretReferences: [] };
      const inspection = await leaveStaleCustody(registration, 80 + iteration);
      assert.equal(await crashRecoveryAt(registration, inspection.custodyId, phase), expectedExit);

      const first = startRecovery(registration, inspection.custodyId);
      const second = startRecovery(registration, inspection.custodyId);
      t.after(() => { first.child.kill(); second.child.kill(); });
      const outcomes = [JSON.parse(await first.nextLine()), JSON.parse(await second.nextLine())];
      const winners = outcomes.filter(item => item.outcome === 'connected');
      const losers = outcomes.filter(item => item.outcome === 'rejected');
      const custodyPath = `${profile}.behalvo-private-custody`;
      const artifacts = readdirSync(custodyPath);
      assert.equal(winners.length, 1, `${phase}/${iteration} must elect exactly one replacement owner: ` +
        JSON.stringify({ outcomes, artifacts: artifacts.map(name => ({ name,
          contents: readFileSync(join(custodyPath, name), 'utf8') })) }));
      assert.equal(losers.length, 1, `${phase}/${iteration} must reject the competing claimant`);
      assert.equal(behalvo.inspectPrivateProfileCustody(profile).pid, winners[0].pid);
      first.child.kill(); second.child.kill();
    }
  }
});

for (const cut of ['zero', 'partial_header', 'header', 'partial_body']) {
  test(`partial ${cut} owner staging during recovery retains one replacement owner`, async t => {
    const { profile } = privateDirectory(t);
    const registration = { id: 'connection-a', service: 'visa-scheduling', accountId: 'account-a', generation: 1,
      profileId: 'profile-a', profilePath: profile, mode: 'synthetic', dedicated: true,
      fullDiskEncryptionAcknowledged: false, secretReferences: [] };
    const inspection = await leaveStaleCustody(registration);
    // The stale owner committed started/revoked events before exiting.
    for (let interruption = 0; interruption < 2; interruption++)
      assert.equal(await crashRecoveryAt(registration, inspection.custodyId, 'staging', cut), 62);
    const first = startRecovery(registration, inspection.custodyId);
    const second = startRecovery(registration, inspection.custodyId);
    t.after(() => { first.child.kill(); second.child.kill(); });
    const outcomes = [JSON.parse(await first.nextLine()), JSON.parse(await second.nextLine())];
    assert.equal(outcomes.filter(item => item.outcome === 'connected').length, 1);
    assert.equal(outcomes.filter(item => item.outcome === 'rejected').length, 1);
    const winner = outcomes.find(item => item.outcome === 'connected');
    assert.equal(winner.state, 'disconnect_failed');
    assert.equal(behalvo.inspectPrivateProfileCustody(profile).pid, winner.pid);
    const events = readFileSync(join(`${profile}.behalvo-private-custody`, 'owner.json'), 'utf8')
      .trimEnd().split('\n').slice(1).map(line => JSON.parse(line));
    assert.deepEqual(events, [{ type: 'disconnect.started', deletePurposes: [] }, { type: 'connection.revoked' }],
      'only committed canonical progress survives recovery');
    assert.deepEqual(readdirSync(`${profile}.behalvo-private-custody`), ['owner.json']);
    process.kill(winner.pid, 0);
  });
}

for (const mismatch of ['claimId', 'sourceDigest', 'sourceStateIdentity', 'sourceDirectoryIdentity', 'custodyId', 'registrationDigest']) {
  test(`partial recovery stage rejects mismatched ${mismatch} provenance`, async t => {
    const { profile } = privateDirectory(t);
    const registration = { id: 'connection-a', service: 'visa-scheduling', accountId: 'account-a', generation: 1,
      profileId: 'profile-a', profilePath: profile, mode: 'synthetic', dedicated: true,
      fullDiskEncryptionAcknowledged: false, secretReferences: [] };
    const inspection = await leaveStaleCustody(registration);
    assert.equal(await crashRecoveryAt(registration, inspection.custodyId, 'staging', 'zero'), 62);
    const custodyPath = `${profile}.behalvo-private-custody`;
    const claimPath = join(custodyPath, readdirSync(custodyPath).find(name => name.startsWith('recovery-claim-')));
    const stagePath = join(custodyPath, readdirSync(custodyPath).find(name => name.startsWith('owner-')));
    const claim = JSON.parse(readFileSync(claimPath, 'utf8'));
    claim[mismatch] = mismatch.endsWith('Identity') ? '0:0' : mismatch.endsWith('Digest')
      ? '0'.repeat(64) : 'Z'.repeat(43);
    writeFileSync(claimPath, JSON.stringify(claim) + '\n');
    const before = lstatSync(stagePath);
    for (let restart = 0; restart < 2; restart++)
      assert.equal((await recoverAfterKillpoint(registration, inspection.custodyId)).outcome, 'rejected');
    assert.equal(lstatSync(stagePath).ino, before.ino);
    assert.equal(lstatSync(stagePath).size, 0);
  });
}

for (const cut of ['zero', 'partial_header', 'partial_body']) {
  test(`legacy random checkpoint ${cut} needs a complete exact ownership header`, async t => {
    const { profile } = privateDirectory(t);
    const registration = { id: 'connection-a', service: 'visa-scheduling', accountId: 'account-a', generation: 1,
      profileId: 'profile-a', profilePath: profile, mode: 'synthetic', dedicated: true,
      fullDiskEncryptionAcknowledged: false, secretReferences: [] };
    const writer = startPartialStageWriter(registration, 'checkpoint', cut);
    t.after(() => writer.child.kill());
    const inspection = JSON.parse(await writer.nextLine());
    const { stagePath } = JSON.parse(await writer.nextLine());
    assert.equal(await writer.exited, 75);
    const legacyPath = join(`${profile}.behalvo-private-custody`, `owner-${'A'.repeat(43)}.tmp`);
    renameSync(stagePath, legacyPath);
    const before = readFileSync(legacyPath);
    const result = await recoverAfterKillpoint(registration, inspection.custodyId);
    assert.equal(result.outcome, cut === 'partial_body' ? 'disconnected' : 'rejected');
    if (cut !== 'partial_body') assert.deepEqual(readFileSync(legacyPath), before);
    else assert.equal(existsSync(legacyPath), false);
  });
}

test('stale recovery never removes an unowned custody staging artifact', async t => {
  const { profile } = privateDirectory(t, 'foreign-stage');
  const registration = { id: 'connection-a', service: 'visa-scheduling', accountId: 'account-a', generation: 1,
    profileId: 'profile-a', profilePath: profile, mode: 'synthetic', dedicated: true,
    fullDiskEncryptionAcknowledged: false, secretReferences: [] };
  const inspection = await leaveStaleCustody(registration, 91);
  const foreign = join(`${profile}.behalvo-private-custody`, `owner-${'A'.repeat(43)}.tmp`);
  writeFileSync(foreign, '{"foreign":true}\n', { mode: 0o600 });
  const restarted = new PrivateConnectionManager({ secretProvider: new SyntheticSecretProvider(),
    authority: authority() });
  assert.throws(() => restarted.recover(registration, { expectedCustodyId: inspection.custodyId,
    confirmStaleProcessExited: true }), /Private connection operation failed\./);
  assert.equal(readFileSync(foreign, 'utf8'), '{"foreign":true}\n');
});

test('checkpoint exclusive-create failure preserves a preexisting fixed staging file', async t => {
  const { profile } = privateDirectory(t);
  let revocations = 0;
  const manager = new PrivateConnectionManager({ secretProvider: new SyntheticSecretProvider(), authority: authority({
    async revokeConnection() { revocations++; }
  }) });
  manager.register({ id: 'connection-a', service: 'visa-scheduling', accountId: 'account-a', generation: 1,
    profileId: 'profile-a', profilePath: profile, mode: 'synthetic', dedicated: true,
    fullDiskEncryptionAcknowledged: false, secretReferences: [] });
  const { custodyId } = behalvo.inspectPrivateProfileCustody(profile);
  const stagePath = join(`${profile}.behalvo-private-custody`, `owner-${custodyId}.tmp`);
  writeFileSync(stagePath, '{"foreign":true}\n', { mode: 0o600 });
  const before = lstatSync(stagePath);
  await assert.rejects(manager.disconnect({ connectionId: 'connection-a', deletePurposes: [] }),
    /Private connection operation failed\./);
  assert.equal(readFileSync(stagePath, 'utf8'), '{"foreign":true}\n');
  assert.equal(lstatSync(stagePath).ino, before.ino);
  assert.equal(revocations, 0);
});

test('explicit stale-custody recovery resumes journaled disconnect phases after process death', async t => {
  const { profile } = privateDirectory(t);
  const registration = { id: 'connection-a', service: 'visa-scheduling', accountId: 'account-a', generation: 1,
    profileId: 'profile-a', profilePath: profile, mode: 'synthetic', dedicated: true,
    fullDiskEncryptionAcknowledged: false, secretReferences: [] };
  const inspection = await leaveStaleCustody(registration);
  assert.equal(typeof inspection.custodyId, 'string');

  const calls = { connection: 0, browser: 0, broker: 0, monitors: 0 };
  const restarted = new PrivateConnectionManager({ secretProvider: new SyntheticSecretProvider(), authority: authority({
    async revokeConnection() { calls.connection++; }, async revokeBrowserEpochs() { calls.browser++; },
    async revokeSecretBrokers() { calls.broker++; }, async stopAndReleaseMonitors() { calls.monitors++; }
  }) });
  restarted.recover(registration, { expectedCustodyId: inspection.custodyId, confirmStaleProcessExited: true });
  assert.equal((await restarted.disconnect({ connectionId: 'connection-a', deletePurposes: [] })).state, 'disconnected');
  assert.deepEqual(calls, { connection: 0, browser: 1, broker: 1, monitors: 1 });
  assert.equal(behalvo.inspectPrivateProfileCustody(profile), null);
});

test('recovery finalizes a completed cleanup checkpoint before replaying its receipt', async t => {
  const { profile } = privateDirectory(t);
  const registration = { id: 'connection-a', service: 'visa-scheduling', accountId: 'account-a', generation: 1,
    profileId: 'profile-a', profilePath: profile, mode: 'synthetic', dedicated: true,
    fullDiskEncryptionAcknowledged: false, secretReferences: [] };
  const inspection = await leaveStaleCustody(registration, 25);
  const journal = `${profile}.behalvo-private-custody/owner.json`;
  for (const type of ['browser.revoked', 'brokers.revoked', 'monitors.stopped', 'disconnect.completed']) {
    appendFileSync(journal, `${JSON.stringify({ type })}\n`, { encoding: 'utf8', flush: true });
  }

  const restarted = new PrivateConnectionManager({ secretProvider: new SyntheticSecretProvider(),
    authority: authority() });
  assert.equal(restarted.recover(registration, { expectedCustodyId: inspection.custodyId,
    confirmStaleProcessExited: true }).state, 'disconnected');
  assert.equal(behalvo.inspectPrivateProfileCustody(profile), null,
    'a completed recovered journal must not retain profile custody');
  const replay = new PrivateConnectionManager({ secretProvider: new SyntheticSecretProvider(),
    authority: authority() });
  assert.equal(replay.recover(registration, { expectedCustodyId: inspection.custodyId,
    confirmStaleProcessExited: true }).state, 'disconnected');
});

test('stale-custody recovery rejects duplicate cleanup checkpoints', async t => {
  const { profile } = privateDirectory(t);
  const registration = { id: 'connection-a', service: 'visa-scheduling', accountId: 'account-a', generation: 1,
    profileId: 'profile-a', profilePath: profile, mode: 'synthetic', dedicated: true,
    fullDiskEncryptionAcknowledged: false, secretReferences: [] };
  const inspection = await leaveStaleCustody(registration, 26);
  appendFileSync(`${profile}.behalvo-private-custody/owner.json`,
    `${JSON.stringify({ type: 'connection.revoked' })}\n`, { encoding: 'utf8', flush: true });
  const restarted = new PrivateConnectionManager({ secretProvider: new SyntheticSecretProvider(),
    authority: authority() });
  assert.throws(() => restarted.recover(registration, { expectedCustodyId: inspection.custodyId,
    confirmStaleProcessExited: true }), /Private connection operation failed\./);
});

test('restart replays a completed disconnect receipt after its acknowledgement is lost', async t => {
  const { profile } = privateDirectory(t);
  const registration = { id: 'connection-a', service: 'visa-scheduling', accountId: 'account-a', generation: 1,
    profileId: 'profile-a', profilePath: profile, mode: 'synthetic', dedicated: true,
    fullDiskEncryptionAcknowledged: false, secretReferences: [] };
  const moduleUrl = new URL('../dist/index.js', import.meta.url).href;
  const script = `
    import * as api from ${JSON.stringify(moduleUrl)};
    const manager = new api.PrivateConnectionManager({ secretProvider: new api.SyntheticSecretProvider(), authority: {
      assertConnection() {}, async revokeConnection() {}, async revokeBrowserEpochs() {},
      async stopAndReleaseMonitors() {}, async revokeSecretBrokers() {}
    } });
    const registration = JSON.parse(process.argv[1]);
    manager.register(registration);
    process.stdout.write(JSON.stringify(api.inspectPrivateProfileCustody(registration.profilePath)) + '\\n');
    await manager.disconnect({ connectionId: registration.id, deletePurposes: [] });
    process.exit(24);
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, JSON.stringify(registration)],
    { stdio: ['ignore', 'pipe', 'ignore'] });
  let output = '';
  child.stdout.setEncoding('utf8'); child.stdout.on('data', chunk => { output += chunk; });
  const exitCode = await new Promise(resolve => child.once('exit', code => resolve(code)));
  assert.equal(exitCode, 24);
  const inspection = JSON.parse(output.trim());

  const restarted = new PrivateConnectionManager({ secretProvider: new SyntheticSecretProvider(),
    authority: authority() });
  assert.equal(restarted.recover(registration, { expectedCustodyId: inspection.custodyId,
    confirmStaleProcessExited: true }).state, 'disconnected');
  assert.deepEqual(await restarted.disconnect({ connectionId: 'connection-a', deletePurposes: [] }), {
    connectionId: 'connection-a', state: 'disconnected', profileRemovalOffered: true,
    profilePath: profile, deletedPurposes: []
  });
});

test('local service disconnect revokes durable, browser, and retained-secret broker authority', async t => {
  const { root, profile } = privateDirectory(t);
  const dbPath = join(root, 'service.db');
  const initial = new SqliteStore(dbPath, { serviceQueue: { upgradeExisting: true } });
  initial.createWorkspace('workspace', 'owner');
  new OperationService(initial, new OperationRegistry()).registerConnection({ workspaceId: 'workspace', ownerId: 'owner',
    connection: { id: 'connection-a', provider: 'visa-scheduling', subject: 'subject-a', label: 'Private' } });
  const now = new Date().toISOString();
  new Operator(initial, () => now).createWork('workspace', 'owner', {
    id: 'work', title: 'Private monitor', goal: 'Stop on disconnect', threadId: 'thread'
  });
  const monitoringRegistry = new MonitoringRegistry();
  monitoringRegistry.register({ id: 'visa.observe', version: 1, validateScope(value) { return value; },
    coverageSufficient() { return true; }, selectCommand() { return undefined; } });
  const monitoring = new MonitoringService(initial, monitoringRegistry, {
    workspaceId: 'workspace', ownerId: 'owner', installationGeneration: 'installation-a', clock: () => now
  });
  const grant = monitoring.proposeGrant({ id: 'grant-a', workspaceId: 'workspace', ownerId: 'owner',
    adapter: 'visa.observe', adapterVersion: 1, connectionId: 'connection-a', connectionGeneration: 1,
    browserProfileId: 'profile-a', subjectDigest: 'c'.repeat(64), scope: { kind: 'synthetic' }, maximumEffects: 1,
    expiresAt: new Date(Date.now() + 86_400_000).toISOString() });
  monitoring.activateGrant({ ownerId: 'owner', grantId: grant.id, digest: grant.digest, revision: grant.revision });
  monitoring.configureMonitor({ ownerId: 'owner', id: 'monitor-a', grantId: grant.id, workId: 'work', nextDueAt: now,
    maxObservationAgeMs: 60_000, intervalMs: 60_000, jitterMs: 5_000, requestBudget: 3,
    requestWindowMs: 300_000, backoffBaseMs: 60_000, backoffMaxMs: 600_000 });
  initial.close();

  const provider = new SyntheticSecretProvider();
  const password = await secret(provider, 'password');
  const broker = new NativeHostSecretAccess(provider, [password], { connectionGeneration: 1 });
  let browserRevokes = 0;
  const browser = new BrowserSession({ profileId: 'profile-a', connectionGeneration: 1,
    serviceGeneration: 'service-generation', allowedOrigin: 'http://127.0.0.1:43117', tabId: 1,
    identityDigest: 'a'.repeat(64), subjectDigest: 'b'.repeat(64), termsVersion: 'terms-v1',
    transport: {
      async inspect() { throw new Error('unused'); }, async gesture() { throw new Error('unused'); },
      async revoke() { browserRevokes++; }, async close() {}
    },
    persistence: {
      async pauseForHuman() {}, async releaseWorker() {}, async recoverHandoff() {},
      async resumePreflight(epoch) { return { profileId: epoch.profileId,
        connectionGeneration: epoch.connectionGeneration, identityDigest: 'a'.repeat(64),
        subjectDigest: 'b'.repeat(64), termsVersion: 'terms-v1', appointmentAbsent: true }; }
    }
  });
  const manager = new PrivateConnectionManager({ secretProvider: provider });
  const bootstrapDirectory = join(root, 'bootstrap');
  mkdirSync(bootstrapDirectory, { mode: 0o700 });
  const service = await startLocalService({ dbPath, bootstrapDirectory, workspaceId: 'workspace', ownerId: 'owner',
    assets: { html: '<!doctype html>', javascript: "'use strict';", css: '' }, upgradeStorage: false,
    browserSessions: [browser], privateConnections: manager, privateSecretBrokers: [broker] });
  t.after(async () => { await service.shutdown(); });
  manager.register({ id: 'connection-a', service: 'visa-scheduling', accountId: 'account-a', generation: 1,
    profileId: 'profile-a', profilePath: profile, mode: 'synthetic', dedicated: true,
    fullDiskEncryptionAcknowledged: false, secretReferences: [password] });

  await manager.disconnect({ connectionId: 'connection-a', deletePurposes: [] });
  assert.equal(browserRevokes, 1);
  await assert.rejects(broker.withSecret({ ...password }, () => {}), /Secret storage operation failed\./);
  await assert.rejects(browser.inspect('login', { serviceGeneration: 'service-generation',
    deadline: Date.now() + 1_000, signal: new AbortController().signal, async assertCurrent() {} }),
  /Browser session is not current\./);
  await service.shutdown();
  const reopened = new SqliteStore(dbPath, { serviceQueue: { upgradeExisting: false } });
  assert.equal(reopened.state('workspace').connections['connection-a'].status, 'revoked');
  assert.equal(reopened.state('workspace').monitoredActionGrants['grant-a'].status, 'revoked');
  assert.equal(reopened.state('workspace').monitors['monitor-a'].status, 'stopped');
  reopened.close();
});

test('authenticated control API returns metadata only and exposes explicit disconnect choices', async t => {
  const { root } = privateDirectory(t, 'unused-profile');
  const sessions = new OwnerControlSessions({ workspaceId: 'workspace', ownerId: 'owner' });
  let disconnectCalls = 0;
  const connection = { id: 'connection-a', service: 'visa-scheduling', generation: 1,
    profileId: 'profile-a', mode: 'synthetic', state: 'connected', secretPurposes: ['password'] };
  const status = { lifecycle: 'running', databaseMode: 'plaintext', model: { configured: false, selection: null },
    queue: { queued: 0, running: 0, finished: 0, stopped: 0, interrupted: 0,
      oldestQueuedAt: null, activeJobId: null },
    runtime: { accepting: true, faulted: false, activeJobId: null, activeStartedAt: null,
      lastSchedulerPollAt: null, nextDueAt: null }, unresolvedActionIds: [], unresolvedActions: [],
    connections: [connection], limits: { foreground: true, awakeOnly: true, supervised: false } };
  const serviceControl = {
    status() { return status; },
    async disconnectConnection(_principal, connectionId, input) {
      disconnectCalls++;
      assert.equal(connectionId, 'connection-a');
      assert.deepEqual(input, { deletePurposes: ['password'] });
      return { connectionId, state: 'disconnected', profileRemovalOffered: true,
        profilePath: '/private/profile', deletedPurposes: ['password'] };
    }
  };
  const app = { sessions, serviceControl, service: { close() {} }, close() {} };
  const server = await startOwnerControlServer({ app, bootstrapDirectory: join(root, 'bootstrap'),
    assets: { html: '<!doctype html>', javascript: "'use strict';", css: '' } });
  t.after(server.close);
  const bootstrap = JSON.parse(readFileSync(server.bootstrapPath, 'utf8'));
  const paired = await requestControl(server.origin, 'POST', '/api/session/bootstrap', bootstrap.token, {});
  const token = paired.body.token;

  assert.equal((await requestControl(server.origin, 'POST', '/api/connections/connection-a/disconnect', undefined,
    { deletePurposes: ['password'] })).status, 401);
  assert.equal(disconnectCalls, 0);
  const projected = await requestControl(server.origin, 'GET', '/api/service', token);
  assert.deepEqual(projected.body.connections, [connection]);
  assert.equal(JSON.stringify(projected.body).includes('account-a'), false);
  assert.equal(JSON.stringify(projected.body).includes('secret_'), false);

  const disconnected = await requestControl(server.origin, 'POST', '/api/connections/connection-a/disconnect', token,
    { deletePurposes: ['password'] });
  assert.equal(disconnected.status, 200);
  assert.equal(disconnected.body.profileRemovalOffered, true);
  assert.equal(disconnectCalls, 1);
  assert.equal((await requestControl(server.origin, 'POST', '/api/connections/connection-a/disconnect', token,
    { deletePurposes: ['password'], unexpected: true })).status, 400);
  assert.equal(disconnectCalls, 1);
});
