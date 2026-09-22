import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserEpochRegistry, BrowserSession, SyntheticPortalState } from '../dist/index.js';

function matchingPortal(options = {}) {
  const portal = new SyntheticPortalState({ scenario: 'calendar_match', ...options });
  portal.gesture({ kind: 'calendar.next_page' });
  return portal;
}

test('restart before a gesture or after durable intent does not mutate provider state', () => {
  const before = matchingPortal();
  const slot = before.inspect().candidates[0];
  let restarted = SyntheticPortalState.restore(before.exportDurableState());
  assert.equal(restarted.mutationCount, 0);
  restarted.recordDurableIntent('intent-1', slot.id);
  restarted = SyntheticPortalState.restore(restarted.exportDurableState());
  assert.equal(restarted.mutationCount, 0);
  assert.equal(restarted.inspect().state, 'calendar');
  assert.throws(() => SyntheticPortalState.restore({ ...restarted.exportDurableState(), unexpected: true }),
    /invalid synthetic portal state/i);
});

test('restart after provider mutation, ambiguity, or confirmation never permits a second booking', () => {
  for (const ambiguousSubmission of [false, true]) {
    let portal = matchingPortal({ ambiguousSubmission });
    const slot = portal.inspect().candidates[0];
    portal.recordDurableIntent('intent-1', slot.id);
    portal.gesture({ kind: 'slot.select', slotId: slot.id });
    portal.gesture({ kind: 'booking.submit', slotId: slot.id, intentId: 'intent-1' });
    portal = SyntheticPortalState.restore(portal.exportDurableState());
    assert.equal(portal.mutationCount, 1);
    assert.equal(portal.authoritativeReadback().state, 'appointment');
    assert.throws(() => portal.gesture({ kind: 'booking.submit', slotId: slot.id, intentId: 'intent-1' }),
      /booking is already present/i);
    assert.equal(portal.mutationCount, 1);
  }
});

test('handoff during an awaited gesture invalidates its authorization before any click', async () => {
  let continueTransport;
  let clicks = 0;
  const transport = {
    async inspect() { throw new Error('inspect must not run'); },
    gesture(request, authorize) { return new Promise((resolve, reject) => {
      continueTransport = async () => {
        try {
          const finalCheck = await authorize(); finalCheck();
          clicks++;
          resolve({ protocolVersion: 1, kind: 'result', requestId: request.requestId,
            profileId: request.profileId, connectionGeneration: request.connectionGeneration,
            epoch: request.epoch, serviceGeneration: request.serviceGeneration, origin: request.origin,
            tabId: request.tabId, sequence: request.sequence, pageState: 'calendar',
            snapshot: { state: 'calendar', page: 1, hasNext: false, candidates: [] } });
        } catch (error) { reject(error); }
      };
    }); }, async revoke() {},
    async close() {}
  };
  const session = new BrowserSession({ profileId: 'profile-crash', connectionGeneration: 1,
    serviceGeneration: 'service-crash', allowedOrigin: 'http://127.0.0.1:43117', tabId: 4,
    identityDigest: 'a'.repeat(64), subjectDigest: 'b'.repeat(64), termsVersion: 'terms-1',
    transport, registry: new BrowserEpochRegistry(), persistence: {
      async pauseForHuman() {}, async releaseWorker() {}, async recoverHandoff() {},
      async resumePreflight() { throw new Error('resume must not run'); }
    } });
  const controller = new AbortController();
  const pending = session.gesture({ kind: 'calendar.next_page' }, 'calendar', {
    serviceGeneration: 'service-crash', deadline: Date.now() + 10_000, signal: controller.signal,
    async assertCurrent() {}
  });
  await new Promise(resolve => setImmediate(resolve));
  await session.transferToHuman('challenge');
  await continueTransport();
  await assert.rejects(pending);
  assert.equal(clicks, 0);
});

test('handoff fences an awaited gesture immediately while the durable pause is still committing', async () => {
  let continueTransport;
  let finishPause;
  let clicks = 0;
  const pauseCommitted = new Promise(resolve => { finishPause = resolve; });
  const session = new BrowserSession({ profileId: 'profile-pending-handoff', connectionGeneration: 1,
    serviceGeneration: 'service-crash', allowedOrigin: 'http://127.0.0.1:43117', tabId: 5,
    identityDigest: 'a'.repeat(64), subjectDigest: 'b'.repeat(64), termsVersion: 'terms-1',
    registry: new BrowserEpochRegistry(), transport: {
      async inspect() { throw new Error('inspect must not run'); },
      gesture(_request, authorize) { return new Promise((resolve, reject) => {
        continueTransport = async () => {
          try { const finalCheck = await authorize(); finalCheck(); clicks++; resolve(undefined); } catch (error) { reject(error); }
        };
      }); },
      async revoke() {},
      async close() {}
    }, persistence: {
      async pauseForHuman() { await pauseCommitted; }, async releaseWorker() {}, async recoverHandoff() {},
      async resumePreflight() { throw new Error('resume must not run'); }
    } });
  const controller = new AbortController();
  const pending = session.gesture({ kind: 'calendar.next_page' }, 'calendar', {
    serviceGeneration: 'service-crash', deadline: Date.now() + 10_000, signal: controller.signal,
    async assertCurrent() {}
  });
  await new Promise(resolve => setImmediate(resolve));
  const handoff = session.transferToHuman('challenge');
  await new Promise(resolve => setImmediate(resolve));
  await continueTransport();
  await assert.rejects(pending, /browser session is not current/i);
  assert.equal(clicks, 0);
  finishPause();
  await handoff;
});
