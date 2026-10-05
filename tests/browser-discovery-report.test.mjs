import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { SyntheticPortalState } from '../dist/synthetic-portal/state.js';
import { createUsVisaChinaFixtureAuthenticator, createUsVisaChinaContractFixture,
  assessUsVisaChinaReadiness, usVisaChinaDefaultReadiness } from '../dist/adapters/us-visa-china/discovery.js';
import { DISCOVERY_CASES, mapDiscoverySnapshot, buildDiscoveryReport, serializeDiscoveryReport } from './helpers/browser-discovery-report.mjs';
const ids = ['login', 'security_question', 'group_roster', 'booking_review', 'challenge', 'session_expired',
  'forbidden', 'rate_limited', 'terms_changed', 'unknown', 'confirmation', 'ambiguous_submission', 'appointment'];
const metadata = () => ({ workspaceId: 'synthetic-browser-discovery', runId: randomUUID(),
  versions: { adapterId: 'us-visa-china', adapterVersion: 1, playwright: '1.63.0', node: process.versions.node, browser: '153.0.8010.12' },
  provenance: { kind: 'clean_commit', commit: 'a'.repeat(40) } });
function row(caseId) {
  return { caseId, pageState: caseId, provenance: 'fixture_seeded', outcome: 'observed', code: 'none',
    checks: mapDiscoverySnapshot(caseId, new SyntheticPortalState({ scenario: caseId }).inspect()),
    cleanup: 'confirmed', gestureCount: 0, postCount: 0 };
}
const full = () => buildDiscoveryReport({ ...metadata(), cases: ids.map(row) });
test('strict snapshot mapping covers only the fixed field-presence catalog', () => {
  assert.deepEqual(DISCOVERY_CASES.map(item => item.caseId), ids);
  for (const id of ids) assert.deepEqual(Object.values(row(id).checks).filter(value => value !== 'observed'), []);
  assert.deepEqual(Object.keys(row('login').checks), ['page_state']);
  assert.deepEqual(Object.keys(row('group_roster').checks), ['page_state', 'identity_digest', 'subject_digest', 'roster_digest', 'terms_version']);
  assert.deepEqual(Object.keys(row('appointment').checks), ['page_state', 'booking_contract', 'appointment_complete']);
  assert.throws(() => mapDiscoverySnapshot('login', { state: 'challenge' }));
  assert.throws(() => mapDiscoverySnapshot('calendar', new SyntheticPortalState({ scenario: 'calendar_match' }).inspect()));
  const incomplete = new SyntheticPortalState({ scenario: 'appointment' }).inspect(); incomplete.complete = false;
  assert.throws(() => mapDiscoverySnapshot('appointment', incomplete));
});
test('fixed partial catalog and aggregate cannot invent coverage', () => {
  const report = buildDiscoveryReport({ ...metadata(), cases: [row('login')] });
  assert.equal(report.result, 'incomplete'); assert.equal(report.cases.length, 13);
  assert.deepEqual(report.counts, { expected: 13, executed: 1, skipped: 0, missing: 12, rejected: 0 });
  assert.ok(Object.values(report.gaps).every(value => value === 'unobserved'));
  const complete = full(); assert.equal(complete.result, 'passed'); assert.equal(complete.liveRegistration, 'disabled');
  assert.equal(complete.gaps.complete_roster, 'unobserved');
  assert.throws(() => buildDiscoveryReport({ ...metadata(), cases: [row('login'), row('login')] }));
  assert.throws(() => serializeDiscoveryReport({ ...report, result: 'passed' }));
  assert.throws(() => serializeDiscoveryReport({ ...complete, gaps: { ...complete.gaps, live_identity: 'observed' } }));
  assert.equal(serializeDiscoveryReport(complete).at(-1), 10);
});
test('skips, failures, requests and cleanup prevent overall pass', () => {
  for (const kind of ['skipped', 'rejected', 'pending', 'gesture', 'post']) {
    const rows = ids.map(row), first = rows[0];
    if (kind === 'skipped') Object.assign(first, { outcome: 'skipped', code: 'not_enabled', checks: { page_state: 'unobserved' } });
    else Object.assign(first, { outcome: 'rejected', code: kind === 'pending' ? 'cleanup_pending' : kind === 'rejected' ? 'assertion_failed' : 'unexpected_request',
      checks: { page_state: 'rejected' }, cleanup: kind === 'pending' ? 'pending' : 'confirmed', gestureCount: kind === 'gesture' ? 1 : 0, postCount: kind === 'post' ? 1 : 0 });
    const report = buildDiscoveryReport({ ...metadata(), cases: rows });
    assert.equal(report.result, kind === 'skipped' ? 'incomplete' : 'failed');
  }
  const report = full(); report.cases[0].postCount = 1; assert.throws(() => serializeDiscoveryReport(report));
});
test('sensitive canaries, accessors, nested extras and oversized values never leak', () => {
  const canary = `SENSITIVE_${randomBytes(32).toString('hex')}`;
  let accessed = false;
  const getter = { state: 'login', get password() { accessed = true; return canary; } };
  for (const input of [{ state: 'login', password: canary }, getter,
    { ...new SyntheticPortalState({ scenario: 'appointment' }).inspect(), booking: { password: canary } }]) {
    assert.throws(() => mapDiscoverySnapshot(input.state, input), error => !String(error).includes(canary));
  }
  assert.equal(accessed, false);
  const source = new SyntheticPortalState({ scenario: 'group_roster' }).inspect(); source.termsVersion = 'private-canary';
  assert.equal(JSON.stringify(mapDiscoverySnapshot('group_roster', source)).includes('private-canary'), false);
  for (const extra of [{ raw: canary }, { raw: 'x'.repeat(65537) }, { toJSON() { accessed = true; return {}; } }])
    assert.throws(() => serializeDiscoveryReport({ ...full(), ...extra }), error => !String(error).includes(canary));
  assert.equal(accessed, false); assert.ok(serializeDiscoveryReport(full()).length <= 65536);
});
test('synthetic report cannot become an authenticated fixture or readiness authority', () => {
  const report = full();
  const authenticator = createUsVisaChinaFixtureAuthenticator({ key: randomBytes(32), ownerId: 'synthetic-owner', installationGeneration: 'synthetic-install', sessionDigest: 'a'.repeat(64) });
  assert.throws(() => createUsVisaChinaContractFixture({ report, authenticator }));
  assert.throws(() => assessUsVisaChinaReadiness({ fixture: report, authenticator, now: new Date().toISOString(), privateConnection: true, activeGrant: true }));
  assert.equal(usVisaChinaDefaultReadiness().liveRegistration, 'disabled');
});

import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, symlinkSync, chmodSync, statSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { captureDiscoverySource, discoveryProvenance, createDiscoveryReportRun, persistDiscoveryReport } from './helpers/browser-discovery-report-io.mjs';
function repository(t) {
  const root = mkdtempSync(join(tmpdir(), 'discovery-repo-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  git('init', '-q'); writeFileSync(join(root, '.gitignore'), 'data/\n'); writeFileSync(join(root, 'source.txt'), 'original\n');
  git('add', '.'); git('-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.test', 'commit', '-qm', 'fixture');
  return { root, git };
}
test('source provenance distinguishes clean, staged, unstaged, untracked and changed evidence', async t => {
  const { root, git } = repository(t); const clean = await captureDiscoverySource(root);
  assert.equal(clean.dirty, false); assert.deepEqual(discoveryProvenance(clean, clean), { kind: 'clean_commit', commit: clean.head });
  writeFileSync(join(root, 'source.txt'), 'modified\n'); const dirty = await captureDiscoverySource(root); assert.equal(dirty.dirty, true);
  git('add', 'source.txt'); const staged = await captureDiscoverySource(root); assert.equal(staged.dirty, true);
  writeFileSync(join(root, 'new.txt'), 'new\n'); const untracked = await captureDiscoverySource(root);
  assert.notEqual(untracked.fingerprint, staged.fingerprint);
  const changed = discoveryProvenance(clean, untracked); assert.equal(changed.changedDuringRun, true);
  const report = buildDiscoveryReport({ ...metadata(), provenance: changed, cases: ids.map(row) }); assert.equal(report.result, 'failed');
  assert.equal(discoveryProvenance(dirty, dirty).kind, 'dirty_tree');
  assert.equal(buildDiscoveryReport({ ...metadata(), provenance: discoveryProvenance(dirty, dirty), cases: ids.map(row) }).result, 'passed');
  assert.equal(JSON.stringify(untracked).includes('source.txt'), false);
});
test('private scoped report publication is exclusive and rejects forged handles', t => {
  const { root } = repository(t), run = createDiscoveryReportRun(root);
  const report = buildDiscoveryReport({ ...metadata(), workspaceId: run.workspaceId, runId: run.runId, cases: ids.map(row) });
  const file = persistDiscoveryReport(run, report); assert.equal(file, join(run.runDirectory, 'report.json'));
  assert.equal(statSync(file).mode & 0o777, 0o600); assert.equal(statSync(run.runDirectory).mode & 0o777, 0o700);
  assert.equal(readFileSync(file, 'utf8'), serializeDiscoveryReport(report).toString());
  assert.throws(() => persistDiscoveryReport(run, report));
  assert.throws(() => persistDiscoveryReport({ ...run, runDirectory: '/private/tmp' }, report));
  assert.throws(() => persistDiscoveryReport(run, { ...report, runId: randomUUID() }));
  assert.deepEqual(readdirSync(run.runDirectory), ['report.json']);
});
test('symlinks, unsafe directory modes, and changed directory identity cannot redirect publication', t => {
  const { root } = repository(t);
  symlinkSync(tmpdir(), join(root, 'data')); assert.throws(() => createDiscoveryReportRun(root)); rmSync(join(root, 'data'));
  mkdirSync(join(root, 'data'), { mode: 0o777 }); chmodSync(join(root, 'data'), 0o777);
  assert.throws(() => createDiscoveryReportRun(root)); chmodSync(join(root, 'data'), 0o700);
  const run = createDiscoveryReportRun(root), report = buildDiscoveryReport({ ...metadata(), runId: run.runId, cases: ids.map(row) });
  rmSync(run.runDirectory, { recursive: true }); mkdirSync(run.runDirectory, { mode: 0o700 });
  assert.throws(() => persistDiscoveryReport(run, report));
  const other = createDiscoveryReportRun(root); symlinkSync(join(root, 'source.txt'), join(other.runDirectory, 'report.json'));
  assert.throws(() => persistDiscoveryReport(other, { ...report, runId: other.runId })); assert.equal(readFileSync(join(root, 'source.txt'), 'utf8'), 'original\n');
});
test('invalid report persistence leaves no temporary file and uses fixed errors', t => {
  const { root } = repository(t), run = createDiscoveryReportRun(root);
  const canary = 'PRIVATE-CANARY';
  assert.throws(() => persistDiscoveryReport(run, { ...full(), raw: canary }), error => !String(error).includes(canary));
  assert.deepEqual(readdirSync(run.runDirectory), []);
});
test('write and publication failures keep unrelated files and return fixed errors', t => {
  const { root } = repository(t);
  for (const operation of ['write', 'publish']) {
    const run = createDiscoveryReportRun(root), report = buildDiscoveryReport({ ...metadata(), runId: run.runId, cases: ids.map(row) });
    writeFileSync(join(run.runDirectory, 'unrelated'), 'keep');
    assert.throws(() => persistDiscoveryReport(run, report, { [operation]() { throw new Error('SENSITIVE-IO-FAILURE'); } }),
      error => !String(error).includes('SENSITIVE'));
    assert.deepEqual(readdirSync(run.runDirectory), ['unrelated']);
  }
});
