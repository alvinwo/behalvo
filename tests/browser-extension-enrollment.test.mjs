import test from 'node:test';
import assert from 'node:assert/strict';

const allowedOrigin = 'http://127.0.0.1:43117';
const extensionId = 'a'.repeat(32);
const popupUrl = `chrome-extension://${extensionId}/popup.html`;
const enrollment = 'enrollment-value-1234567890abcdef';

function listenerSet() {
  const listeners = [];
  return {
    listeners,
    api: {
      addListener(listener) { listeners.push(listener); }
    },
    emit(value) {
      for (const listener of listeners) listener(value);
    }
  };
}

function fakePort() {
  const messages = listenerSet();
  const disconnects = listenerSet();
  const posted = [];
  let disconnectCount = 0;
  return {
    posted,
    messages,
    disconnects,
    get disconnectCount() { return disconnectCount; },
    port: {
      postMessage(value) { posted.push(structuredClone(value)); },
      disconnect() { disconnectCount++; },
      onMessage: messages.api,
      onDisconnect: disconnects.api
    }
  };
}

function fakeChrome({ tabs = [{ id: 7, url: `${allowedOrigin}/`, incognito: false }] } = {}) {
  const native = [];
  const contentMessages = [];
  let nativeConnections = 0;
  const runtimeMessages = listenerSet();
  const storageWrites = [];
  return {
    get nativeConnections() { return nativeConnections; },
    native,
    contentMessages,
    storageWrites,
    api: {
      runtime: {
        id: extensionId,
        getURL(path) { return `chrome-extension://${extensionId}/${path}`; },
        connectNative(name) {
          nativeConnections++;
          const next = fakePort();
          native.push({ name, ...next });
          return next.port;
        },
        onMessage: runtimeMessages.api
      },
      tabs: {
        query(_query, callback) { callback(structuredClone(tabs)); },
        sendMessage(tabId, value, callback) {
          contentMessages.push({ tabId, value: structuredClone(value) });
          callback?.({ ok: true });
        }
      },
      storage: {
        local: {
          set(value, callback) { storageWrites.push(structuredClone(value)); callback?.(); }
        }
      }
    }
  };
}

function popupSender(overrides = {}) {
  return { id: extensionId, url: popupUrl, ...overrides };
}

async function backgroundModule(suffix = '') {
  return import(`../extension/dist/background.js${suffix}`);
}

test('background startup registers no implicit native connection', async () => {
  const chromeFixture = fakeChrome();
  const previous = globalThis.chrome;
  globalThis.chrome = chromeFixture.api;
  try {
    await backgroundModule(`?explicit-enrollment-${Date.now()}`);
    assert.equal(chromeFixture.nativeConnections, 0);
  } finally {
    if (previous === undefined) delete globalThis.chrome;
    else globalThis.chrome = previous;
  }
});

test('only the extension popup can initiate enrollment and background chooses the one synthetic tab', async () => {
  const background = await backgroundModule();
  assert.equal(typeof background.createExtensionEnrollmentController, 'function');
  const chromeFixture = fakeChrome();
  const controller = background.createExtensionEnrollmentController(chromeFixture.api);

  for (const sender of [
    { id: extensionId, url: `chrome-extension://${extensionId}/other.html` },
    { id: 'b'.repeat(32), url: popupUrl },
    { id: extensionId, url: popupUrl, tab: { id: 99, url: `${allowedOrigin}/` } }
  ]) {
    await assert.rejects(
      controller.handlePopupMessage({ kind: 'bridge.enroll.request', enrollment }, sender),
      /popup|enrollment|sender/i
    );
  }
  assert.equal(chromeFixture.nativeConnections, 0);

  const pending = controller.handlePopupMessage(
    { kind: 'bridge.enroll.request', enrollment },
    popupSender()
  );
  assert.deepEqual(controller.status(), { state: 'enrolling' });
  assert.equal(chromeFixture.nativeConnections, 1);
  assert.deepEqual(chromeFixture.native[0].posted, [{
    bridgeVersion: 1,
    kind: 'bridge.enroll',
    enrollment,
    tabId: 7,
    origin: allowedOrigin
  }]);
  assert.equal(chromeFixture.contentMessages.length, 0);
  assert.equal(chromeFixture.storageWrites.length, 0);

  chromeFixture.native[0].messages.emit({
    bridgeVersion: 1,
    kind: 'bridge.enrollment.accepted',
    tabId: 7,
    origin: allowedOrigin
  });
  assert.deepEqual(await pending, { state: 'enrolled', tabId: 7, origin: allowedOrigin });
  assert.deepEqual(controller.status(), { state: 'enrolled', tabId: 7, origin: allowedOrigin });
});

test('enrollment requires exactly one non-incognito tab at the fixed synthetic root', async () => {
  const background = await backgroundModule();
  for (const tabs of [
    [],
    [{ id: 7, url: `${allowedOrigin}/`, incognito: true }],
    [{ id: 7, url: `${allowedOrigin}/other`, incognito: false }],
    [{ id: 7, url: `${allowedOrigin}/`, incognito: false },
      { id: 8, url: `${allowedOrigin}/`, incognito: false }]
  ]) {
    const chromeFixture = fakeChrome({ tabs });
    const controller = background.createExtensionEnrollmentController(chromeFixture.api);
    await assert.rejects(
      controller.handlePopupMessage({ kind: 'bridge.enroll.request', enrollment }, popupSender()),
      /exactly one|synthetic tab/i
    );
    assert.equal(chromeFixture.nativeConnections, 0);
    assert.deepEqual(controller.status(), { state: 'disconnected' });
  }
});

test('native rejection, malformed acceptance, or disconnect invalidates the run without reconnect', async () => {
  const background = await backgroundModule();
  const cases = [
    { bridgeVersion: 1, kind: 'bridge.enrollment.rejected', code: 'enrollment_rejected' },
    { bridgeVersion: '1', kind: 'bridge.enrollment.accepted', tabId: 7, origin: allowedOrigin },
    { bridgeVersion: 1, kind: 'bridge.enrollment.accepted', tabId: '7', origin: allowedOrigin },
    { bridgeVersion: 1, kind: 'bridge.enrollment.accepted', tabId: 7, origin: 17 }
  ];
  for (const message of cases) {
    const chromeFixture = fakeChrome();
    const controller = background.createExtensionEnrollmentController(chromeFixture.api);
    const pending = controller.handlePopupMessage(
      { kind: 'bridge.enroll.request', enrollment },
      popupSender()
    );
    chromeFixture.native[0].messages.emit(message);
    await assert.rejects(pending, /enrollment|native|protocol/i);
    assert.deepEqual(controller.status(), { state: 'invalidated' });
    assert.equal(chromeFixture.nativeConnections, 1);
  }

  const chromeFixture = fakeChrome();
  const controller = background.createExtensionEnrollmentController(chromeFixture.api);
  const pending = controller.handlePopupMessage(
    { kind: 'bridge.enroll.request', enrollment },
    popupSender()
  );
  chromeFixture.native[0].disconnects.emit();
  await assert.rejects(pending, /disconnect|enrollment|native/i);
  assert.deepEqual(controller.status(), { state: 'invalidated' });
  assert.equal(chromeFixture.nativeConnections, 1);
  await assert.rejects(
    controller.handlePopupMessage({ kind: 'bridge.enroll.request', enrollment }, popupSender()),
    /invalidated|enrollment/i
  );
  assert.equal(chromeFixture.nativeConnections, 1);
});

test('popup enrollment input is strict and cannot smuggle browser authority', async () => {
  const background = await backgroundModule();
  const chromeFixture = fakeChrome();
  const controller = background.createExtensionEnrollmentController(chromeFixture.api);
  for (const value of [
    { kind: 'bridge.enroll.request' },
    { kind: 'bridge.enroll.request', enrollment: '' },
    { kind: 'bridge.enroll.request', enrollment, tabId: 9 },
    { kind: 'bridge.enroll.request', enrollment, url: `${allowedOrigin}/` },
    { kind: 'bridge.enroll.request', enrollment, origin: allowedOrigin },
    { kind: 'bridge.enroll.request', enrollment, command: { kind: 'calendar.next_page' } }
  ]) {
    await assert.rejects(controller.handlePopupMessage(value, popupSender()), /enrollment|message/i);
  }
  assert.equal(chromeFixture.nativeConnections, 0);
});
