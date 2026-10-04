import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { BrowserSession, BrowserEpochRegistry } from '../dist/browser/session.js';
const adapter = await import('../dist/browser/playwright-transport.js').catch(() => ({}));
const origin = 'http://127.0.0.1:43117';
const binding = { profileId: 'p1-test', connectionGeneration: 1, serviceGeneration: 'p1-service' };
const request = (overrides = {}) => ({ protocolVersion: 1, requestId: 'request-1', ...binding,
  epoch: 'a'.repeat(64), origin, tabId: 1, sequence: 1, kind: 'recognize', ...overrides });
class Page extends EventEmitter {
  address = origin + '/'; state = 'login'; count = 1; reads = 0; closed = false;
  frame = {}; browser = new EventEmitter(); contextEvents = new EventEmitter();
  constructor() { super(); this.browser.isConnected = () => true; this.contextEvents.browser = () => this.browser; }
  url() { return this.address; } isClosed() { return this.closed; }
  mainFrame() { return this.frame; } context() { return this.contextEvents; }
  locator(selector) { assert.equal(selector, 'main[data-behalvo-page-state]'); return {
    count: async () => this.count,
    getAttribute: async key => { assert.equal(key, 'data-behalvo-page-state'); this.reads++; return this.pending ? this.pending : this.state; }
  }; }
}
function fixture(options = {}) {
  assert.equal(typeof adapter.PlaywrightReadOnlyTransport, 'function', 'read-only transport must exist');
  const page = new Page(); const controller = new AbortController(); let closes = 0;
  const transport = new adapter.PlaywrightReadOnlyTransport({ page, ...binding, signal: controller.signal,
    close: async () => { closes++; }, ...options });
  return { page, controller, transport, closes: () => closes };
}
test('P1 reads actual login snapshot through existing BrowserSession', async () => {
  const f = fixture(); let released = 0;
  const session = new BrowserSession({ ...binding, allowedOrigin: origin, tabId: 1,
    identityDigest: 'b'.repeat(64), subjectDigest: 'c'.repeat(64), termsVersion: 'synthetic-p1',
    registry: new BrowserEpochRegistry(), transport: f.transport, persistence: {
      releaseWorker: async () => { released++; }, pauseForHuman: async () => { throw Error(); },
      recoverHandoff: async () => { throw Error(); }, resumePreflight: async () => { throw Error(); }
    } });
  const fence = { serviceGeneration: binding.serviceGeneration, signal: f.controller.signal,
    deadline: Date.now() + 10000, assertCurrent: async () => {} };
  assert.deepEqual(await session.recognize(fence), { state: 'login' });
  assert.deepEqual(await session.inspect('login', fence), { state: 'login' });
  await session.shutdown(); assert.equal(released, 1); assert.equal(f.closes(), 1);
  await assert.rejects(session.inspect('login', fence));
});
for (const [key, value] of Object.entries({ protocolVersion: 2, profileId: 'other', connectionGeneration: 2,
  serviceGeneration: 'other', origin: 'http://127.0.0.1:43118', tabId: 2, sequence: 2, extra: 'CANARY' })) {
  test(`P1 rejects ${key} mismatch before reading and becomes terminal`, async () => {
    const f = fixture(); await assert.rejects(f.transport.inspect(request({ [key]: value })));
    assert.equal(f.page.reads, 0); await assert.rejects(f.transport.inspect(request())); await f.transport.close();
  });
}
test('P1 rejects replay and changed epoch', async () => {
  for (const next of [request(), request({ sequence: 2, epoch: 'b'.repeat(64) })]) {
    const f = fixture(); await f.transport.inspect(request());
    await assert.rejects(f.transport.inspect(next)); assert.equal(f.page.reads, 1); await f.transport.close();
  }
});
for (const contract of [{ count: 0 }, { count: 2 }, { state: 'calendar' }, { state: 'CANARY-secret' }]) {
  test(`P1 fails closed on page contract ${JSON.stringify(contract)}`, async () => {
    const f = fixture(); Object.assign(f.page, contract);
    await assert.rejects(f.transport.inspect(request()), error => !error.message.includes('CANARY'));
    await f.transport.close();
  });
}
for (const trigger of ['navigation', 'close', 'disconnect', 'cancel', 'revoke', 'concurrent', 'timeout']) {
  test(`P1 invalidates pending observation on ${trigger} without accepting late results`, async () => {
    const f = fixture({ observationTimeoutMs: 25 }); let resolve;
    f.page.pending = new Promise(r => { resolve = r; });
    const read = f.transport.inspect(request()); const rejected = assert.rejects(read);
    await new Promise(r => setImmediate(r));
    if (trigger === 'navigation') f.page.emit('framenavigated', f.page.frame);
    if (trigger === 'close') f.page.emit('close');
    if (trigger === 'disconnect') f.page.browser.emit('disconnected');
    if (trigger === 'cancel') f.controller.abort();
    if (trigger === 'revoke') await f.transport.revoke({ ...binding, epoch: 'a'.repeat(64), allowedOrigin: origin }, 1);
    if (trigger === 'concurrent') await assert.rejects(f.transport.inspect(request({ sequence: 2 })));
    await rejected; resolve('login');
    await assert.rejects(f.transport.inspect(request({ sequence: 2 }))); await f.transport.close();
  });
}
test('P1 rejects all gestures without authorizing or dispatching actions', async () => {
  const f = fixture(); let authorized = 0;
  for (const kind of ['calendar.first_page', 'calendar.next_page', 'slot.select', 'booking.intent', 'booking.submit', 'appointment.readback']) {
    await assert.rejects(f.transport.gesture(request({ kind: 'gesture', command: { kind } }), async () => { authorized++; },
      { deadline: Date.now() + 1000, signal: f.controller.signal }));
  }
  assert.equal(authorized, 0); assert.equal(f.page.reads, 0); await f.transport.close(); await f.transport.close(); assert.equal(f.closes(), 1);
});
