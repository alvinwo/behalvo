import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import {
  acquireSyntheticProfileLease,
  inspectPrivateProfileCustody,
  PrivateConnectionManager,
  recoverSyntheticProfileLease,
  SyntheticSecretProvider
} from '../dist/index.js';

function privateProfile(t, name = 'profile') {
  const root = mkdtempSync(join(tmpdir(), 'behalvo-profile-lease-'));
  chmodSync(root, 0o700);
  const profile = join(root, name);
  mkdirSync(profile, { mode: 0o700 });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, profile };
}

const leaseInput = profile => ({
  installationId: 'installation-a',
  profileId: 'profile-a',
  profilePath: profile
});

test('synthetic profile lease reuses exclusive custody and preserves the profile on release', t => {
  const { profile } = privateProfile(t);
  const lease = acquireSyntheticProfileLease(leaseInput(profile));
  const inspection = inspectPrivateProfileCustody(profile);
  assert.ok(inspection);
  assert.equal(inspection.custodyId, lease.custodyId);
  assert.equal(lease.profilePath, profile);
  assert.equal(typeof lease.profileDevice, 'string');
  assert.equal(typeof lease.profileInode, 'string');
  assert.throws(() => acquireSyntheticProfileLease(leaseInput(profile)), /profile lease/i);
  lease.release();
  assert.equal(inspectPrivateProfileCustody(profile), null);
  assert.doesNotThrow(() => readFileSync(join(profile, '.keep'), 'utf8'), 'profile contents are caller-owned');
});

test('synthetic profile lease refuses Chrome Singleton markers and refuses release while Chrome appears open', t => {
  const { profile } = privateProfile(t);
  const marker = join(profile, 'SingletonLock');
  writeFileSync(marker, 'synthetic');
  assert.throws(() => acquireSyntheticProfileLease(leaseInput(profile)), /profile lease/i);
  rmSync(marker);

  const lease = acquireSyntheticProfileLease(leaseInput(profile));
  writeFileSync(join(profile, '.keep'), 'retained');
  writeFileSync(marker, 'synthetic');
  assert.throws(() => lease.release(), /profile lease/i);
  assert.ok(inspectPrivateProfileCustody(profile));
  rmSync(marker);
  lease.release();
  assert.equal(readFileSync(join(profile, '.keep'), 'utf8'), 'retained');
});

async function leaveLeaseInDeadProcess(profile) {
  const moduleUrl = new URL('../dist/index.js', import.meta.url).href;
  const script = `
    import { acquireSyntheticProfileLease } from ${JSON.stringify(moduleUrl)};
    const lease = acquireSyntheticProfileLease(JSON.parse(process.argv[1]));
    process.stdout.write(JSON.stringify({ custodyId: lease.custodyId }) + '\\n');
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, JSON.stringify(leaseInput(profile))],
    { stdio: ['ignore', 'pipe', 'inherit'] });
  let output = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => { output += chunk; });
  const code = await new Promise(resolve => child.once('exit', resolve));
  assert.equal(code, 0);
  return JSON.parse(output.trim());
}

test('synthetic profile lease explicitly recovers one dead owner with empty history', async t => {
  const { profile } = privateProfile(t);
  const stale = await leaveLeaseInDeadProcess(profile);
  const recovered = recoverSyntheticProfileLease(leaseInput(profile), {
    expectedCustodyId: stale.custodyId,
    confirmPreviousRunExited: true
  });
  assert.equal(recovered.custodyId, stale.custodyId);
  recovered.release();
  assert.equal(inspectPrivateProfileCustody(profile), null);
});

test('synthetic profile recovery rejects custody carrying disconnect history', async t => {
  const { profile } = privateProfile(t);
  const stale = await leaveLeaseInDeadProcess(profile);
  appendFileSync(join(`${profile}.behalvo-private-custody`, 'owner.json'),
    JSON.stringify({ type: 'disconnect.started', deletePurposes: [] }) + '\n');
  assert.throws(() => recoverSyntheticProfileLease(leaseInput(profile), {
    expectedCustodyId: stale.custodyId,
    confirmPreviousRunExited: true
  }), /profile lease/i);
});

test('synthetic profile recovery cannot consume a private-connection custody record', async t => {
  const { profile } = privateProfile(t);
  const moduleUrl = new URL('../dist/index.js', import.meta.url).href;
  const registration = {
    id: 'connection-a',
    service: 'visa-scheduling',
    accountId: 'account-a',
    generation: 1,
    profileId: 'profile-a',
    profilePath: profile,
    mode: 'synthetic',
    dedicated: true,
    fullDiskEncryptionAcknowledged: false,
    secretReferences: []
  };
  const script = `
    import { PrivateConnectionManager, SyntheticSecretProvider, inspectPrivateProfileCustody } from
      ${JSON.stringify(moduleUrl)};
    const manager = new PrivateConnectionManager({
      secretProvider: new SyntheticSecretProvider(),
      authority: {
        assertConnection() {},
        async revokeConnection() {},
        async revokeBrowserEpochs() {},
        async stopAndReleaseMonitors() {},
        async revokeSecretBrokers() {}
      }
    });
    const registration = JSON.parse(process.argv[1]);
    manager.register(registration);
    process.stdout.write(JSON.stringify(inspectPrivateProfileCustody(registration.profilePath)) + '\\n');
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, JSON.stringify(registration)],
    { stdio: ['ignore', 'pipe', 'inherit'] });
  let output = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => { output += chunk; });
  const code = await new Promise(resolve => child.once('exit', resolve));
  assert.equal(code, 0);
  const stale = JSON.parse(output.trim());
  assert.throws(() => recoverSyntheticProfileLease(leaseInput(profile), {
    expectedCustodyId: stale.custodyId,
    confirmPreviousRunExited: true
  }), /profile lease/i);

  // Keep imports above exercised in the parent build as well; no manager is created here.
  assert.equal(typeof PrivateConnectionManager, 'function');
  assert.equal(typeof SyntheticSecretProvider, 'function');
});
