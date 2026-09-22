import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserSession, BrowserEpochRegistry } from '../dist/index.js';

function response(request, snapshot = { state: 'calendar', page: 1, hasNext: false, candidates: [] }) {
  return { protocolVersion: 1, kind: 'result', requestId: request.requestId,
    profileId: request.profileId, connectionGeneration: request.connectionGeneration,
    epoch: request.epoch, serviceGeneration: request.serviceGeneration, origin: request.origin,
    tabId: request.tabId, sequence: request.sequence, pageState: snapshot.state, snapshot };
}

function fixture(overrides = {}) {
  const calls = [];
  const persistence = {
    async pauseForHuman(value) { calls.push(['pause', value.reason]); },
    async releaseWorker() { calls.push(['release']); },
    async recoverHandoff() { calls.push(['recover']); },
    async resumePreflight() { calls.push(['preflight']); return {
      profileId: 'profile-a', connectionGeneration: 2, identityDigest: 'a'.repeat(64),
      subjectDigest: 'b'.repeat(64), termsVersion: 'terms-1', appointmentAbsent: true
    }; }
  };
  const transport = {
    async inspect(request) { calls.push(['inspect', request.sequence]); return response(request); },
    async gesture(request, authorize) { calls.push(['transport-await', request.sequence]);
      const finalCheck = await authorize(); finalCheck(); calls.push(['mutate', request.command.kind]); return response(request); },
    async revoke() { calls.push(['revoke']); },
    async close() { calls.push(['close']); }
  };
  const session = new BrowserSession({ profileId: 'profile-a', connectionGeneration: 2,
    serviceGeneration: 'service-a', allowedOrigin: 'http://127.0.0.1:43117', tabId: 9,
    identityDigest: 'a'.repeat(64), subjectDigest: 'b'.repeat(64), termsVersion: 'terms-1',
    transport, persistence, registry: new BrowserEpochRegistry(), ...overrides });
  return { session, calls, transport, persistence };
}

function fence(calls) {
  const controller = new AbortController();
  return { serviceGeneration: 'service-a', deadline: Date.now() + 10_000, signal: controller.signal,
    async assertCurrent() { calls.push(['fence']); } };
}

test('session rechecks the trusted fence after awaits and immediately before a gesture', async () => {
  const f = fixture();
  await f.session.inspect('calendar', fence(f.calls));
  await f.session.gesture({ kind: 'calendar.next_page' }, 'calendar', fence(f.calls));
  const mutate = f.calls.findIndex(item => item[0] === 'mutate');
  assert.equal(f.calls[mutate - 1][0], 'fence');
  assert.ok(f.calls.filter(item => item[0] === 'fence').length >= 5);
  await f.session.shutdown();
});

test('final gesture guard rejects cancellation that occurs after authorization', async () => {
  const controller = new AbortController(); let clicks = 0;
  const f = fixture({ transport: {
    async inspect() { throw new Error('inspect must not run'); },
    async gesture(request, authorize) {
      const finalCheck = await authorize();
      controller.abort();
      finalCheck();
      clicks++;
      return response(request);
    },
    async revoke() {}, async close() {}
  } });
  const gesture = f.session.gesture({ kind: 'calendar.next_page' }, 'calendar', {
    serviceGeneration: 'service-a', deadline: Date.now() + 10_000, signal: controller.signal,
    async assertCurrent() {}
  });
  await assert.rejects(gesture, /stopped|cancellation|deadline/i);
  assert.equal(clicks, 0);
  await f.session.shutdown();
});

test('handoff durably pauses before invalidating ownership and rejects a late response', async () => {
  let resolveInspect;
  const f = fixture({ transport: {
    inspect(request) { return new Promise(resolve => { resolveInspect = () => resolve(response(request)); }); },
    async gesture() { throw new Error('gesture must not run'); }, async revoke() {}, async close() {}
  } });
  const pending = f.session.inspect('calendar', fence(f.calls));
  await new Promise(resolve => setImmediate(resolve));
  await f.session.transferToHuman('challenge');
  resolveInspect();
  await assert.rejects(pending, /browser session is not current/i);
  assert.deepEqual(f.calls.slice(0, 2), [['fence'], ['pause', 'challenge']]);
  assert.ok(f.calls.some(item => item[0] === 'release'));
});

test('handoff releases a non-settling browser continuation immediately after the durable pause', async () => {
  const f = fixture({ transport: {
    async inspect() { return new Promise(() => {}); },
    async gesture() { throw new Error('gesture must not run'); }, async revoke() {}, async close() {}
  } });
  const pending = f.session.inspect('calendar', fence(f.calls));
  await new Promise(resolve => setImmediate(resolve));
  await f.session.transferToHuman('challenge');
  const outcome = await Promise.race([
    pending.then(() => 'resolved', () => 'rejected'),
    new Promise(resolve => setTimeout(() => resolve('timeout'), 50))
  ]);
  assert.equal(outcome, 'rejected');
  assert.ok(f.calls.some(item => item[0] === 'release'));
});

test('resume creates a fresh epoch only after exact identity subject and terms preflight', async () => {
  const f = fixture();
  const first = f.session.epoch;
  await f.session.transferToHuman('challenge');
  const resumed = await f.session.resume();
  assert.notEqual(resumed.epoch, first.epoch);
  assert.equal(resumed.profileId, 'profile-a');
  assert.equal(f.calls.at(-1)[0], 'preflight');
  await f.session.shutdown();

  const bad = fixture({ persistence: { ...f.persistence, async resumePreflight() { return {
    profileId: 'profile-a', connectionGeneration: 2, identityDigest: 'x'.repeat(64),
    subjectDigest: 'b'.repeat(64), termsVersion: 'terms-1', appointmentAbsent: true
  }; } } });
  await bad.session.transferToHuman('identity_check');
  await assert.rejects(bad.session.resume(), /resume preflight/i);
});

test('one registry grants only one exclusive browser epoch per profile', async () => {
  const registry = new BrowserEpochRegistry();
  const first = fixture({ registry });
  assert.throws(() => fixture({ registry }), /already owned/i);
  await first.session.shutdown();
  const second = fixture({ registry });
  await second.session.shutdown();
});

test('an operation from an invalidated epoch cannot regain authorization after resume', async () => {
  let authorize;
  const f = fixture({ transport: {
    async inspect() { throw new Error('inspect must not run'); },
    gesture(request, value) { return new Promise((resolve, reject) => {
      authorize = async () => {
        try {
          const finalCheck = await value();
          if (typeof finalCheck === 'function') finalCheck();
          resolve(response(request));
        } catch (error) { reject(error); throw error; }
      };
    }); },
    async revoke() {}, async close() {}
  } });
  const pending = f.session.gesture({ kind: 'calendar.next_page' }, 'calendar', fence(f.calls));
  void pending.catch(() => {});
  await new Promise(resolve => setImmediate(resolve));
  await f.session.transferToHuman('challenge');
  await f.session.resume();
  await assert.rejects(authorize(), /browser session is not current/i);
  await assert.rejects(pending, /browser session is not current/i);
  await f.session.shutdown();
});

test('an operation held in its first fence cannot enter a later resumed epoch', async () => {
  let releaseFence;
  let inspections = 0;
  const f = fixture({ transport: {
    async inspect(request) { inspections++; return response(request); },
    async gesture() { throw new Error('gesture must not run'); }, async revoke() {}, async close() {}
  } });
  const controller = new AbortController();
  let firstFence = true;
  const pending = f.session.inspect('calendar', { serviceGeneration: 'service-a',
    deadline: Date.now() + 10_000, signal: controller.signal,
    assertCurrent() {
      if (!firstFence) return Promise.resolve();
      firstFence = false;
      return new Promise(resolve => { releaseFence = resolve; });
    } });
  await new Promise(resolve => setImmediate(resolve));
  await f.session.transferToHuman('challenge');
  await f.session.resume();
  releaseFence();
  await assert.rejects(pending, /browser session is not current/i);
  assert.equal(inspections, 0);
  await f.session.shutdown();
});

test('failed durable pause faults the epoch until explicit recovery and never releases its worker', async () => {
  const f = fixture({ persistence: {
    async pauseForHuman() { f.calls.push(['pause-failed']); throw new Error('synthetic storage failure'); },
    async releaseWorker() { f.calls.push(['release']); },
    async recoverHandoff() { f.calls.push(['recover']); },
    async resumePreflight() { return { profileId: 'profile-a', connectionGeneration: 2,
      identityDigest: 'a'.repeat(64), subjectDigest: 'b'.repeat(64), termsVersion: 'terms-1',
      appointmentAbsent: true }; }
  } });
  await assert.rejects(f.session.transferToHuman('challenge'), /storage failure/);
  await assert.rejects(f.session.gesture({ kind: 'calendar.next_page' }, 'calendar', fence(f.calls)),
    /faulted|not current/i);
  await assert.rejects(f.session.resume(), /recover/i);
  assert.equal(f.calls.some(item => item[0] === 'release'), false);
  await f.session.recoverHandoff();
  await f.session.resume();
  await f.session.shutdown();
});

test('commit-then-reject pause ambiguity stays faulted without releasing or retrying the worker', async () => {
  let durablePaused = false;
  const f = fixture({ persistence: {
    async pauseForHuman() { durablePaused = true; throw new Error('lost pause acknowledgement'); },
    async releaseWorker() { f.calls.push(['release']); },
    async recoverHandoff() { assert.equal(durablePaused, true); f.calls.push(['recover']); },
    async resumePreflight() { return { profileId: 'profile-a', connectionGeneration: 2,
      identityDigest: 'a'.repeat(64), subjectDigest: 'b'.repeat(64), termsVersion: 'terms-1',
      appointmentAbsent: true }; }
  } });
  await assert.rejects(f.session.transferToHuman('challenge'), /lost pause acknowledgement/);
  await assert.rejects(f.session.inspect('calendar', fence(f.calls)), /not current/i);
  assert.equal(f.calls.some(item => item[0] === 'release'), false);
  await f.session.recoverHandoff();
  await f.session.resume();
  await f.session.shutdown();
});

test('shutdown during resume preflight permanently cancels reacquisition and releases the profile', async () => {
  let finishPreflight;
  const registry = new BrowserEpochRegistry();
  const f = fixture({ registry, persistence: {
    async pauseForHuman() {}, async releaseWorker() {}, async recoverHandoff() {},
    resumePreflight() { return new Promise(resolve => { finishPreflight = resolve; }); }
  } });
  await f.session.transferToHuman('challenge');
  const resuming = f.session.resume();
  void resuming.catch(() => {});
  await new Promise(resolve => setImmediate(resolve));
  await f.session.shutdown();
  finishPreflight({ profileId: 'profile-a', connectionGeneration: 2, identityDigest: 'a'.repeat(64),
    subjectDigest: 'b'.repeat(64), termsVersion: 'terms-1', appointmentAbsent: true });
  await assert.rejects(resuming, /closed|not current/i);
  const replacement = fixture({ registry });
  await replacement.session.shutdown();
});

test('resume is single-flight and cannot overlap a handoff release', async () => {
  let finishPreflight;
  let preflights = 0;
  const f = fixture({ persistence: {
    async pauseForHuman() {}, async releaseWorker() {}, async recoverHandoff() {},
    resumePreflight() { preflights++; return new Promise(resolve => { finishPreflight = resolve; }); }
  } });
  await f.session.transferToHuman('challenge');
  const first = f.session.resume();
  void first.catch(() => {});
  await new Promise(resolve => setImmediate(resolve));
  const second = f.session.resume();
  void second.catch(() => {});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(preflights, 1);
  await assert.rejects(second, /in progress/i);
  finishPreflight({ profileId: 'profile-a', connectionGeneration: 2, identityDigest: 'a'.repeat(64),
    subjectDigest: 'b'.repeat(64), termsVersion: 'terms-1', appointmentAbsent: true });
  await first;
  await f.session.shutdown();

  let finishRelease;
  const releasing = fixture({ persistence: {
    async pauseForHuman() {}, releaseWorker() { return new Promise(resolve => { finishRelease = resolve; }); },
    async recoverHandoff() {}, async resumePreflight() { throw new Error('preflight must not run'); }
  } });
  const handoff = releasing.session.transferToHuman('challenge');
  await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(releasing.session.resume(), /handoff|in progress/i);
  finishRelease();
  await handoff;
  await releasing.session.shutdown();
});
