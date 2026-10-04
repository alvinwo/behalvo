import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { BrowserSession, BrowserEpochRegistry } from '../dist/browser/session.js';
import { startSyntheticPortal } from '../dist/synthetic-portal/server.js';
import { SyntheticPortalState } from '../dist/synthetic-portal/state.js';
const enabled = process.env.BEHALVO_PLAYWRIGHT_P2_ACCEPTANCE === '1';
const { PlaywrightActionsOwner } = enabled ? await import('../dist/browser/playwright-actions-owner.js') : {};
const origin = 'http://127.0.0.1:43117';
async function fixture(t, options = {}) {
  const state = new SyntheticPortalState({ scenario: 'calendar_match', ...options });
  const commands = [], actual = state.gesture.bind(state);
  state.gesture = command => { commands.push(command.kind); const result = actual(command);
    if (options.loseSubmissionResponse && command.kind === 'booking.submit') throw new Error('CANARY-LOST-RESPONSE');
    return result; };
  const portal = await startSyntheticPortal({ state, formResponse: 'document' });
  const binding = { profileId: 'p2-fixture', connectionGeneration: 1, serviceGeneration: 'p2-service' };
  let page, server;
  const { chromium } = await import('playwright');
  const controller = new AbortController();
  const owner = new PlaywrightActionsOwner({ ...binding, signal: controller.signal, runDeadline: Date.now() + 30000 }, {
    loadChromium: async () => ({ executablePath: () => chromium.executablePath(),
      launchServer: async value => { server = await chromium.launchServer(value); return server; },
      connect: async (...args) => { const browser = await chromium.connect(...args);
        browser.on('context', () => {});
        const create = browser.newContext.bind(browser);
        browser.newContext = async value => { const context = await create(value); context.on('page', p => { page ??= p; }); return context; };
        return browser; } })
  });
  let session;
  t.after(async () => {
    await session?.shutdown().catch(() => {});
    const cleanup = await owner.close(); await portal.close();
    assert.equal(cleanup.confirmed, true); owner.finishReceipt(true, null, true);
  });
  const ready = await owner.start();
  const initial = state.inspect();
  session = new BrowserSession({ ...binding, allowedOrigin: origin, tabId: 1,
    identityDigest: initial.identityDigest ?? createHash('sha256').update('synthetic-owner').digest('hex'),
    subjectDigest: initial.subjectDigest ?? createHash('sha256').update('synthetic-account').digest('hex'), termsVersion: 'terms-1',
    requireDispatchGuard: true, registry: new BrowserEpochRegistry(), transport: ready.transport,
    persistence: { async pauseForHuman() {}, async releaseWorker() {}, async recoverHandoff() {},
      async resumePreflight(epoch) {
        const base = { protocolVersion: 1, requestId: 'resume-1', ...binding, epoch: epoch.epoch, origin, tabId: 1 };
        await ready.transport.inspect({ ...base, kind: 'recognize', sequence: 1 });
        const read = await ready.transport.inspect({ ...base, requestId: 'resume-2', kind: 'inspect', sequence: 2, expectedPageState: 'calendar' });
        return { ...binding, ...read.snapshot, appointmentAbsent: true, sequence: 2 };
      }
    } });
  const fence = { serviceGeneration: binding.serviceGeneration, deadline: Date.now() + 20000,
    signal: controller.signal, async assertCurrent() {}, assertDispatchCurrent() {} };
  await session.recognize(fence);
  const gesture = (command, source, destination) => session.gestureAndWaitForNavigation(command, source, [destination], fence);
  return { state, commands, owner, ready, session, fence, gesture, page, server, controller, binding };
}
test('visible action transport performs six typed forms and authoritative DOM readback once', { skip: !enabled, timeout: 35000 }, async t => {
  const f = await fixture(t);
  assert.equal((await f.session.recognize(f.fence)).state, 'calendar');
  await f.gesture({ kind: 'calendar.first_page' }, 'calendar', 'calendar');
  const calendar = await f.gesture({ kind: 'calendar.next_page' }, 'calendar', 'calendar');
  const slotId = calendar.candidates[0].id, intentId = 'synthetic-p2-intent';
  await f.gesture({ kind: 'booking.intent', slotId, intentId }, 'calendar', 'calendar');
  await f.gesture({ kind: 'slot.select', slotId }, 'calendar', 'booking_review');
  await f.gesture({ kind: 'booking.submit', slotId, intentId }, 'booking_review', 'confirmation');
  const booking = await f.gesture({ kind: 'appointment.readback' }, 'confirmation', 'appointment');
  assert.equal(booking.complete, true); assert.equal(booking.booking.status, 'booked');
  assert.equal(f.state.mutationCount, 1);
  assert.deepEqual(f.commands, ['calendar.first_page', 'calendar.next_page', 'booking.intent', 'slot.select', 'booking.submit', 'appointment.readback']);
});
test('visible final guard refusal consumes request without a portal POST', { skip: !enabled, timeout: 35000 }, async t => {
  const f = await fixture(t);
  let guardCalls = 0;
  f.fence.assertDispatchCurrent = () => { guardCalls++; throw new Error('CANARY-PRIVATE-AUTHORITY'); };
  await assert.rejects(f.gesture({ kind: 'calendar.first_page' }, 'calendar', 'calendar'), error => !error.message.includes('CANARY'));
  assert.deepEqual(f.commands, []); assert.equal(guardCalls, 1);
  await assert.rejects(f.session.recognize({ ...f.fence, assertDispatchCurrent() {} }));
});
test('visible same-run handoff accepts fresh candidate reads and refuses retired epochs', { skip: !enabled, timeout: 35000 }, async t => {
  const f = await fixture(t); const oldEpoch = f.session.epoch;
  await f.session.recognize(f.fence); await f.session.transferToHuman('synthetic_human');
  await f.ready.transport.reconcileRevocation(oldEpoch, 1);
  const resumed = await f.session.resume(); assert.notEqual(resumed.epoch, oldEpoch.epoch);
  assert.equal((await f.session.inspect('calendar', f.fence)).state, 'calendar');
  assert.deepEqual(f.commands, []);
  await assert.rejects(f.ready.transport.inspect({ protocolVersion: 1, requestId: 'old-epoch', ...f.binding,
    epoch: oldEpoch.epoch, origin, tabId: 1, sequence: 1, kind: 'recognize' }));
});
test('visible transport refuses unowned historical retirement', { skip: !enabled, timeout: 35000 }, async t => {
  const f = await fixture(t);
  await assert.rejects(f.ready.transport.reconcileRevocation({ ...f.binding,
    serviceGeneration: 'historical-service', epoch: randomBytes(32).toString('hex'), allowedOrigin: origin }, 1));
});
test('visible malformed form cannot dispatch a substituted command', { skip: !enabled, timeout: 35000 }, async t => {
  const f = await fixture(t);
  await f.page.evaluate(() => document.querySelector('input[name="kind"]').value = 'booking.submit');
  await assert.rejects(f.gesture({ kind: 'calendar.first_page' }, 'calendar', 'calendar'));
  assert.deepEqual(f.commands, []);
});
for (const scenario of ['login', 'security_question', 'group_roster', 'booking_review', 'challenge', 'session_expired',
  'forbidden', 'rate_limited', 'terms_changed', 'unknown', 'confirmation', 'ambiguous_submission', 'appointment'])
  test(`visible DOM parser reads the actual ${scenario} contract`, { skip: !enabled, timeout: 35000 }, async t => {
    const f = await fixture(t, { scenario });
    assert.deepEqual(await f.session.recognize(f.fence), f.state.inspect());
    assert.deepEqual(f.commands, []);
  });
test('visible lost submission response leaves one booking and never resubmits', { skip: !enabled, timeout: 35000 }, async t => {
  const f = await fixture(t, { loseSubmissionResponse: true });
  const calendar = await f.gesture({ kind: 'calendar.next_page' }, 'calendar', 'calendar');
  const slotId = calendar.candidates[0].id, intentId = 'synthetic-lost-response';
  await f.gesture({ kind: 'booking.intent', slotId, intentId }, 'calendar', 'calendar');
  await f.gesture({ kind: 'slot.select', slotId }, 'calendar', 'booking_review');
  await assert.rejects(f.gesture({ kind: 'booking.submit', slotId, intentId }, 'booking_review', 'confirmation'),
    error => !error.message.includes('CANARY'));
  await assert.rejects(f.gesture({ kind: 'booking.submit', slotId, intentId }, 'booking_review', 'confirmation'));
  assert.equal(f.state.mutationCount, 1);
  assert.equal(f.commands.filter(kind => kind === 'booking.submit').length, 1);
  await f.session.shutdown();
});
for (const change of ['duplicate_root', 'missing_safety_attribute', 'unsolicited_reload'])
  test(`visible ${change} cannot produce trusted observations`, { skip: !enabled, timeout: 35000 }, async t => {
    const f = await fixture(t);
    if (change === 'duplicate_root') await f.page.evaluate(() => document.body.append(document.querySelector('main').cloneNode(true)));
    if (change === 'missing_safety_attribute') await f.page.evaluate(() => document.querySelector('main').removeAttribute('data-behalvo-appointment-absent'));
    if (change === 'unsolicited_reload') await f.page.reload().catch(() => {});
    await assert.rejects(f.session.inspect('calendar', f.fence)); assert.deepEqual(f.commands, []);
  });
test('visible moved form cannot dispatch after its captured source root is replaced', { skip: !enabled, timeout: 35000 }, async t => {
  const f = await fixture(t);
  const { capturePlaywrightSource, preparePlaywrightForm, activatePlaywrightForm } = await import('../dist/browser/playwright-actions-dom.js');
  const source = await capturePlaywrightSource(f.page);
  const prepared = await preparePlaywrightForm(source.root, { kind: 'calendar.first_page' });
  await f.page.evaluate(() => {
    const root = document.querySelector('main');
    document.body.append(root.querySelector('button[data-behalvo-gesture="calendar.first_page"]').form);
    root.outerHTML = '<main data-behalvo-page-state="challenge"></main>';
  });
  await assert.rejects(activatePlaywrightForm(prepared, { kind: 'calendar.first_page' }, 'a'.repeat(64)));
  assert.deepEqual(f.commands, []);
  await Promise.all([source.root.dispose(), prepared.form.dispose(), prepared.button.dispose()]);
});
for (const status of [403, 429]) test(`visible HTTP ${status} rejects a misleading comment before exposing calendar`, { skip: !enabled, timeout: 35000 }, async t => {
  const { createServer } = await import('node:http');
  const real = await startSyntheticPortal({ state: new SyntheticPortalState({ scenario: 'calendar_match' }), formResponse: 'document' });
  const html = await (await fetch(origin)).text(); await real.close();
  const server = createServer((_request, response) => { response.writeHead(status, { 'content-type': 'text/html; charset=utf-8', connection: 'close' });
    response.end(`<!-- data-behalvo-page-state="${status === 403 ? 'forbidden' : 'rate_limited'}" -->${html}`); });
  await new Promise(resolve => server.listen(43117, '127.0.0.1', resolve));
  const owner = new PlaywrightActionsOwner({ profileId: 'status-test', connectionGeneration: 1, serviceGeneration: 'status-generation',
    signal: new AbortController().signal, runDeadline: Date.now() + 20000 });
  t.after(async () => { assert.equal((await owner.close()).confirmed, true); owner.finishReceipt(true, null, true);
    await new Promise(resolve => server.close(resolve)); });
  await assert.rejects(async () => {
    const ready = await owner.start();
    await ready.transport.inspect({ protocolVersion: 1, requestId: 'status-read', profileId: 'status-test', connectionGeneration: 1,
      serviceGeneration: 'status-generation', epoch: 'a'.repeat(64), origin, tabId: 1, sequence: 1, kind: 'recognize' });
  });
});
