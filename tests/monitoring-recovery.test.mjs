import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, webcrypto } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import vm from 'node:vm';
import { NativeMessageReader, NativeMessagingTransport, SqliteStore, reduce, writeNativeMessage } from '../dist/index.js';
import { createSyntheticMonitoringComposition } from '../dist/service/synthetic-monitoring.js';
import { createNativeRequestBoundary } from '../extension/dist/background.js';

const workspaceId = 'resume-recovery', ownerId = 'owner', at = '2026-09-23T12:00:00.000Z';

function compiledCalendar(binding) {
  const dataset = { behalvoPageState: 'calendar', behalvoContractVersion: '1', behalvoLocation: 'Beijing',
    behalvoTimeZone: 'Asia/Shanghai', behalvoStartDate: '2026-12-15', behalvoEndDate: '2027-01-31',
    behalvoIdentityDigest: binding.identityDigest, behalvoSubjectDigest: binding.subjectDigest,
    behalvoRosterDigest: binding.rosterDigest, behalvoTermsDigest: binding.termsDigest,
    behalvoTermsVersion: 'terms-1', behalvoAppointmentAbsent: 'true', behalvoPage: '1', behalvoHasNext: 'false' };
  const manifest = JSON.parse(readFileSync(new URL('../extension/manifest.json', import.meta.url), 'utf8'));
  const source = readFileSync(new URL(`../extension/${manifest.content_scripts[0].js[0]}`, import.meta.url), 'utf8');
  let listener;
  new vm.Script(source).runInContext(vm.createContext({ TextEncoder, structuredClone, performance, crypto: webcrypto,
    location: { origin: binding.allowedOrigin }, document: {
      querySelector(selector) { return selector === '[data-behalvo-page-state]' ? { dataset } : null; },
      querySelectorAll() { return []; }
    }, chrome: { runtime: { id: 'a'.repeat(32), onMessage: { addListener(value) { listener = value; } } } } }));
  return createNativeRequestBoundary((tabId, message) => new Promise(resolve => {
    assert.equal(tabId, 7);
    listener(message, { id: 'a'.repeat(32) }, resolve);
  }));
}

function recoveryFixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'monitor-resume-recovery-'));
  const path = join(directory, 'store.db'), key = randomBytes(32);
  let store = new SqliteStore(path, { encryptionKey: key, serviceQueue: { upgradeExisting: true } });
  store.createWorkspace(workspaceId, ownerId);
  let boundary;
  const messages = [], connections = [], compositions = [];
  t.after(async () => {
    for (const composition of compositions) await composition.session.shutdown();
    for (const connection of connections) await connection.close();
    store.close(); rmSync(directory, { recursive: true, force: true });
  });
  return {
    get store() { return store; }, messages,
    reopen() { store.close(); store = new SqliteStore(path, { encryptionKey: key, serviceQueue: { upgradeExisting: false } }); },
    activateCandidate(candidate) {
      return connections.at(-1).transport.inspect({ protocolVersion: 1, kind: 'recognize', requestId: 'crash-preflight',
        profileId: candidate.profileId, connectionGeneration: candidate.connectionGeneration, epoch: candidate.epoch,
        serviceGeneration: candidate.serviceGeneration, origin: candidate.allowedOrigin, tabId: candidate.tabId, sequence: 1 });
    },
    async start(generation, dropActivationAck = false) {
      const composition = await createSyntheticMonitoringComposition({ store, workspaceId, ownerId,
        serviceGeneration: generation, clock: () => at, options: { fixtureId: 'visa-beijing-group-v1',
          async createBrowserTransport({ binding }) {
            boundary ??= compiledCalendar(binding);
            const input = new PassThrough(), output = new PassThrough();
            const reader = new NativeMessageReader(output);
            const transport = new NativeMessagingTransport(input, output, undefined, 50);
            const pump = (async () => {
              for (;;) {
                const message = await reader.read();
                if (!message) return;
                messages.push(structuredClone(message));
                const response = await boundary(message);
                if (dropActivationAck && message.kind === 'session.activate') continue;
                await writeNativeMessage(input, response);
              }
            })();
            void pump.catch(() => {});
            connections.push({ transport, async close() { await transport.close(); output.end(); input.end(); await pump; } });
            return { tabId: 7, transport };
          } } });
      compositions.push(composition);
      return composition;
    },
    async armAndPause(composition) {
      composition.setup('setup');
      const proposal = composition.propose('proposal', 'grant');
      const armed = composition.arm('arm', proposal.grant.id, proposal.grant.digest, proposal.grant.revision);
      const paused = composition.service.pauseMonitor({ ownerId, monitorId: armed.monitor.id,
        digest: armed.grant.digest, revision: armed.grant.revision, controlRevision: 0, reason: 'owner_paused',
        binding: { ...composition.session.epoch, tabId: 7 } });
      await composition.session.transferToHuman('owner_paused');
      composition.service.settleMonitorHandoff({ monitorId: paused.id, handoffId: paused.control.handoff.id,
        state: 'confirmed' });
      return armed;
    },
    admit(armed, generation, recoverHandoff, requestId) {
      const monitor = store.state(workspaceId).monitors[armed.monitor.id];
      return store.admitMonitorResumeJob({ workspaceId, source: 'owner:service', requestId, ownerId,
        instanceId: generation, serviceGeneration: generation,
        installationGeneration: armed.grant.installationGeneration, at,
        envelope: { kind: 'monitor', purpose: 'resume', monitorId: monitor.id, grantId: armed.grant.id,
          digest: armed.grant.digest, revision: armed.grant.revision, controlRevision: monitor.control.revision,
          recoverHandoff } }).job;
    },
    async run(composition, generation) {
      const job = store.claimServiceJob(workspaceId, generation, at);
      await composition.service.runJob(job, { serviceGeneration: generation, deadline: Date.now() + 10_000,
        signal: new AbortController().signal, async assertCurrent() {}, assertSettlementCurrent() {} });
      return store.serviceJob(workspaceId, job.id);
    }
  };
}

async function assertExplicitRecovery(f, composition, armed, candidate) {
  assert.throws(() => f.admit(armed, 'service-b', false, 'unsafe-resume'), error => error.code === 'conflict');
  const messageCount = f.messages.length;
  f.admit(armed, 'service-b', true, 'recover-resume');
  assert.equal((await f.run(composition, 'service-b')).status, 'finished');
  const exchanged = f.messages.slice(messageCount);
  assert.equal(exchanged[0].kind, 'session.revoke');
  assert.equal(exchanged[0].epoch, candidate.epoch);
  assert.equal(exchanged[0].serviceGeneration, candidate.serviceGeneration);
  assert.equal(exchanged[0].profileId, candidate.profileId);
  assert.equal(exchanged[0].connectionGeneration, candidate.connectionGeneration);
  assert.equal(exchanged[0].tabId, candidate.tabId);
  assert.equal(exchanged[0].origin, candidate.allowedOrigin);
  assert.equal(exchanged[1].kind, 'session.activate');
  assert.notEqual(exchanged[1].epoch, candidate.epoch);
  assert.deepEqual(exchanged.slice(2).map(message => message.kind), ['recognize', 'inspect']);
  const current = f.store.state(workspaceId).monitors[armed.monitor.id];
  assert.equal(current.status, 'active');
  assert.equal(current.control.handoff, null);
  assert.equal(current.control.resume, null);
}

test('lost activation acknowledgement preserves candidate retirement through framed composition restart', async t => {
  const f = recoveryFixture(t), first = await f.start('service-a', true);
  const armed = await f.armAndPause(first);
  f.admit(armed, 'service-a', false, 'resume-lost-ack');
  assert.equal((await f.run(first, 'service-a')).status, 'stopped');
  const activation = f.messages.find(message => message.kind === 'session.activate');
  assert.ok(activation, 'Candidate activation reached compiled background/content');
  const candidate = { profileId: activation.profileId, connectionGeneration: activation.connectionGeneration,
    epoch: activation.epoch, serviceGeneration: activation.serviceGeneration,
    allowedOrigin: activation.origin, tabId: activation.tabId };
  const monitor = f.store.state(workspaceId).monitors[armed.monitor.id];
  assert.equal(monitor.control.handoff.state, 'failed');
  assert.deepEqual(monitor.control.handoff.binding, candidate);
  assert.equal(monitor.control.resume, null);
  await first.session.shutdown(); f.reopen();
  const count = f.messages.length, second = await f.start('service-b');
  assert.deepEqual(f.store.rebuild(workspaceId), f.store.state(workspaceId));
  assert.equal(f.messages.length, count, 'Reconstruction/replay performs no browser I/O');
  await assertExplicitRecovery(f, second, armed, candidate);
});

test('interrupted persisted resume candidate becomes exact retirement handoff before a fresh epoch', async t => {
  const f = recoveryFixture(t), first = await f.start('service-a');
  const armed = await f.armAndPause(first);
  const admitted = f.admit(armed, 'service-a', false, 'resume-crash');
  const running = f.store.claimServiceJob(workspaceId, 'service-a', at);
  const candidate = { ...first.session.epoch, epoch: 'b'.repeat(64), tabId: 7 };
  f.store.recordMonitorResumeStarted(workspaceId, running.claim, candidate, at);
  assert.equal((await f.activateCandidate(candidate)).kind, 'result');
  await first.session.shutdown(); f.reopen();
  const count = f.messages.length;
  // Match service startup: composition is reconstructed before interrupted-job repair.
  const second = await f.start('service-b');
  assert.deepEqual(f.store.inspectInterruptedServiceJobs(workspaceId, at), { repaired: 1, interrupted: 0 });
  const monitor = f.store.state(workspaceId).monitors[armed.monitor.id];
  assert.equal(monitor.status, 'paused');
  assert.equal(monitor.control.handoff.state, 'failed');
  assert.deepEqual(monitor.control.handoff.binding, candidate);
  assert.equal(monitor.control.resume, null);
  assert.equal(f.store.serviceJob(workspaceId, admitted.id).status, 'interrupted');
  assert.deepEqual(f.store.rebuild(workspaceId), f.store.state(workspaceId));
  assert.equal(f.messages.length, count, 'Reconstruction/recovery/replay performs no browser I/O');
  await assertExplicitRecovery(f, second, armed, candidate);
});

test('interrupted resume reducer cannot erase a candidate without exact retirement handoff', async t => {
  const f = recoveryFixture(t), first = await f.start('service-a');
  const armed = await f.armAndPause(first);
  f.admit(armed, 'service-a', false, 'resume-raw-interrupt');
  const running = f.store.claimServiceJob(workspaceId, 'service-a', at);
  f.store.recordMonitorResumeStarted(workspaceId, running.claim, { ...first.session.epoch,
    epoch: 'c'.repeat(64), tabId: 7 }, at);
  const before = f.store.state(workspaceId);
  assert.throws(() => reduce(before, { type: 'monitor.resume_finished', data: { id: armed.monitor.id,
    jobId: running.id, outcome: 'interrupted', reason: 'process_interrupted', evidence: null,
    nextDueAt: null, finishedAt: at } }, before.version + 1), /candidate|retirement|handoff/i);
});
