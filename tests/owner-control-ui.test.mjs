import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createOwnerControlUi,
  deferred,
  response
} from './owner-control-ui-harness.mjs';

const NOW = Date.parse('2026-09-14T12:00:00.000Z');
const BOOTSTRAP_TOKEN = 'b'.repeat(43);
const SESSION_TOKEN = 's'.repeat(43);
const REVIEW_TOKEN = 'r'.repeat(43);
const DIGEST = 'd'.repeat(64);

function bootstrap(ui, overrides = {}) {
  return {
    version: 1,
    origin: ui.origin,
    token: BOOTSTRAP_TOKEN,
    expiresAt: new Date(NOW + 60_000).toISOString(),
    ...overrides
  };
}

function action(actionId, overrides = {}) {
  return {
    actionId,
    workId: `${actionId}-work`,
    workTitle: `Work for ${actionId}`,
    workRevision: 3,
    currentWorkRevision: 3,
    phase: 'acting',
    status: 'proposed',
    digest: DIGEST,
    approvalExpiresAt: null,
    synthetic: true,
    ...overrides
  };
}

function review(actionValue, overrides = {}) {
  return {
    action: actionValue,
    command: {
      kind: 'operation.execute',
      operationId: 'contact.update',
      operationVersion: '1',
      connectionId: 'synthetic-account',
      provider: 'synthetic-accounts',
      subject: 'owner-control-subject',
      connectionGeneration: 7,
      resourceId: 'contact-profile',
      arguments: { email: 'literal+owner@example.test' },
      affectedResourceIds: ['contact-profile'],
      precondition: {
        state: { email: 'before@example.test' },
        providerVersion: 'version-before',
        source: 'synthetic-provider',
        observedAt: '2026-09-14T11:59:00.000Z'
      },
      expectedResult: { email: 'literal+owner@example.test' },
      subjectRevision: 9,
      requestFingerprint: 'fingerprint-literal'
    },
    connection: {
      id: 'synthetic-account',
      provider: 'synthetic-accounts',
      subject: 'owner-control-subject',
      label: 'Local synthetic account',
      generation: 7,
      status: 'active'
    },
    reviewToken: REVIEW_TOKEN,
    reviewExpiresAt: new Date(NOW + 120_000).toISOString(),
    approvalExpiresAt: new Date(NOW + 600_000).toISOString(),
    canApprove: true,
    canCancel: true,
    ...overrides
  };
}

async function pair(ui, pages = [{ workspaceId: 'owner-control-demo', items: [], nextAfter: null }]) {
  ui.selectFile(JSON.stringify(bootstrap(ui)));
  ui.queueJson(200, {
    token: SESSION_TOKEN,
    expiresAt: new Date(NOW + 3_600_000).toISOString(),
    idleExpiresAt: new Date(NOW + 900_000).toISOString()
  });
  for (const page of pages) ui.queueJson(200, page);
  await ui.click('pair');
}

function actionButton(ui, index = 0) {
  return ui.element('actions').children[index].children[0];
}

test('pairing strictly checks bootstrap size, keys, token, origin, and expiry before sending a credential', async t => {
  const cases = [
    ['oversized document', ui => `${JSON.stringify(bootstrap(ui))}${' '.repeat(4097)}`],
    ['extra key', ui => JSON.stringify({ ...bootstrap(ui), ownerId: 'owner' })],
    ['missing key', ui => {
      const value = bootstrap(ui);
      delete value.token;
      return JSON.stringify(value);
    }],
    ['malformed token', ui => JSON.stringify(bootstrap(ui, { token: 'short-token' }))],
    ['different origin', ui => JSON.stringify(bootstrap(ui, { origin: 'http://127.0.0.1:43128' }))],
    ['expired instant', ui => JSON.stringify(bootstrap(ui, {
      expiresAt: new Date(NOW).toISOString()
    }))],
    ['noncanonical instant', ui => JSON.stringify(bootstrap(ui, {
      expiresAt: new Date(NOW + 60_000).toUTCString()
    }))]
  ];

  for (const [name, document] of cases) {
    await t.test(name, async () => {
      const ui = createOwnerControlUi({ now: NOW });
      ui.selectFile(document(ui));

      await ui.click('pair');

      assert.equal(ui.fetchCalls.length, 0);
      assert.equal(ui.element('bootstrap-file').value, '');
      assert.match(ui.element('status').textContent, /pairing file is (?:empty or too large|invalid)/i);
      assert.equal(ui.element('status').className, 'error');
    });
  }
});

test('pairing paginates with bearer credentials kept out of URLs, content, storage, and logs', async () => {
  const ui = createOwnerControlUi({ now: NOW });
  await pair(ui, [
    { workspaceId: 'owner-control-demo', items: [action('action-a')], nextAfter: 'action-a' },
    { workspaceId: 'owner-control-demo', items: [action('action-b')], nextAfter: null }
  ]);

  assert.deepEqual(ui.fetchCalls.map(call => call.path), [
    '/api/session/bootstrap',
    '/api/actions',
    '/api/actions?after=action-a'
  ]);
  assert.equal(ui.fetchCalls[0].init.headers.Authorization, `Bearer ${BOOTSTRAP_TOKEN}`);
  assert.equal(ui.fetchCalls[1].init.headers.Authorization, `Bearer ${SESSION_TOKEN}`);
  assert.equal(ui.element('actions').children.length, 2);
  assert.doesNotMatch(ui.fetchCalls.map(call => `${call.path} ${call.init.body ?? ''}`).join('\n'),
    new RegExp(`${BOOTSTRAP_TOKEN}|${SESSION_TOKEN}`));
  assert.doesNotMatch(ui.allText(), new RegExp(`${BOOTSTRAP_TOKEN}|${SESSION_TOKEN}`));
  assert.deepEqual(ui.storageCalls, []);
  assert.deepEqual(ui.consoleCalls, []);
});

test('a late pairing response cannot restore the signed-out console', async () => {
  const ui = createOwnerControlUi({ now: NOW });
  const pendingPair = deferred();
  ui.selectFile(JSON.stringify(bootstrap(ui)));
  ui.queueFetch(() => pendingPair.promise);

  const pairingClick = ui.click('pair');
  await ui.flush();
  await ui.dispatch('sign-out', 'click');
  pendingPair.resolve(response(200, {
    token: SESSION_TOKEN,
    expiresAt: new Date(NOW + 3_600_000).toISOString(),
    idleExpiresAt: new Date(NOW + 900_000).toISOString()
  }));
  await pairingClick;

  assert.equal(ui.element('pairing').hidden, false);
  assert.equal(ui.element('console').hidden, true);
  assert.match(ui.element('status').textContent, /signed out.*approvals persist.*restart/i);
});

test('a later action selection owns the review when responses arrive out of order', async () => {
  const ui = createOwnerControlUi({ now: NOW });
  await pair(ui, [{
    workspaceId: 'owner-control-demo',
    items: [action('action-a'), action('action-b')],
    nextAfter: null
  }]);
  const firstReview = deferred();
  ui.queueFetch(() => firstReview.promise);
  const firstClick = actionButton(ui, 0).dispatch('click');
  await ui.flush();
  ui.queueJson(200, review(action('action-b'), {
    command: { marker: 'literal command for action-b' },
    connection: { marker: 'literal connection for action-b' }
  }));

  await actionButton(ui, 1).dispatch('click');
  firstReview.resolve(response(200, review(action('action-a'), {
    command: { marker: 'stale command for action-a' },
    connection: { marker: 'stale connection for action-a' }
  })));
  await firstClick;

  assert.match(ui.element('review').textContent, /literal command for action-b/);
  assert.doesNotMatch(ui.element('review').textContent, /stale command for action-a/);
});

test('a repeated click cannot issue a duplicate review while that action is pending', async () => {
  const ui = createOwnerControlUi({ now: NOW });
  const reviewedAction = action('action-a');
  await pair(ui, [{ workspaceId: 'owner-control-demo', items: [reviewedAction], nextAfter: null }]);
  const pendingReview = deferred();
  ui.queueFetch(() => pendingReview.promise);

  const firstClick = actionButton(ui).dispatch('click');
  await ui.flush();
  await actionButton(ui).dispatch('click');

  assert.equal(ui.fetchCalls.filter(call => call.path.endsWith('/review')).length, 1);
  pendingReview.resolve(response(200, review(reviewedAction)));
  await firstClick;
});

test('sign-out discards a delayed review without restoring its command or controls', async () => {
  const ui = createOwnerControlUi({ now: NOW });
  const reviewedAction = action('action-a');
  await pair(ui, [{ workspaceId: 'owner-control-demo', items: [reviewedAction], nextAfter: null }]);
  const pendingReview = deferred();
  ui.queueFetch(() => pendingReview.promise);
  const reviewClick = actionButton(ui).dispatch('click');
  await ui.flush();
  ui.queueJson(204, undefined);

  await ui.click('sign-out');
  pendingReview.resolve(response(200, review(reviewedAction)));
  await reviewClick;

  assert.equal(ui.element('pairing').hidden, false);
  assert.equal(ui.element('console').hidden, true);
  assert.equal(ui.element('review-panel').hidden, true);
  assert.equal(ui.element('review').textContent, '');
  assert.match(ui.element('status').textContent, /signed out.*approvals persist.*restart/i);
});

test('the exact review renders every action field and expires its one-use receipt locally', async () => {
  const ui = createOwnerControlUi({ now: NOW });
  const reviewedAction = action('action-a', {
    workTitle: 'Literal work title',
    workRevision: 3,
    currentWorkRevision: 4
  });
  await pair(ui, [{ workspaceId: 'owner-control-demo', items: [reviewedAction], nextAfter: null }]);
  ui.queueJson(200, review(reviewedAction));

  await actionButton(ui).dispatch('click');

  const text = ui.element('review').textContent;
  for (const literal of [
    'action-a', 'action-a-work', 'Literal work title', '3', '4', 'acting', 'proposed',
    DIGEST, 'Synthetic', 'true', 'literal+owner@example.test', 'before@example.test',
    'Local synthetic account', 'owner-control-subject', '7',
    new Date(NOW + 120_000).toISOString(), new Date(NOW + 600_000).toISOString()
  ]) assert.match(text, new RegExp(literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(text, new RegExp(REVIEW_TOKEN));
  assert.deepEqual(ui.storageCalls, []);
  assert.deepEqual(ui.consoleCalls, []);
  assert.equal(ui.element('approve').disabled, false);
  assert.equal(ui.element('cancel').disabled, false);

  await ui.advanceTo(NOW + 120_000);

  assert.equal(ui.element('review-panel').hidden, true);
  assert.equal(ui.element('approve').disabled, true);
  assert.equal(ui.element('cancel').disabled, true);
  assert.match(ui.element('status').textContent, /review expired.*new review/i);
});

test('a review received after its receipt deadline never enables a decision', async () => {
  const ui = createOwnerControlUi({ now: NOW });
  const reviewedAction = action('action-a');
  await pair(ui, [{ workspaceId: 'owner-control-demo', items: [reviewedAction], nextAfter: null }]);
  ui.queueJson(200, review(reviewedAction, {
    reviewExpiresAt: new Date(NOW - 1).toISOString()
  }));

  await actionButton(ui).dispatch('click');

  assert.equal(ui.element('review-panel').hidden, true);
  assert.equal(ui.element('approve').disabled, true);
  assert.equal(ui.element('cancel').disabled, true);
  assert.match(ui.element('status').textContent, /review expired.*new review/i);
});

test('a pending decision disables every control that could replace or repeat its review', async () => {
  const ui = createOwnerControlUi({ now: NOW });
  const reviewedAction = action('action-a');
  await pair(ui, [{ workspaceId: 'owner-control-demo', items: [reviewedAction], nextAfter: null }]);
  ui.queueJson(200, review(reviewedAction));
  await actionButton(ui).dispatch('click');
  const decision = deferred();
  ui.queueFetch(() => decision.promise);

  const decisionClick = ui.click('approve');
  await ui.flush();

  assert.equal(ui.element('approve').disabled, true);
  assert.equal(ui.element('cancel').disabled, true);
  assert.equal(ui.element('refresh').disabled, true);
  assert.equal(actionButton(ui).disabled, true);
  await ui.click('approve');
  await actionButton(ui).dispatch('click');
  assert.equal(ui.fetchCalls.filter(call => call.path.endsWith('/approve')).length, 1);
  assert.equal(ui.fetchCalls.filter(call => call.path.endsWith('/review')).length, 1);

  decision.resolve(response(200, action('action-a', {
    status: 'approved',
    approvalExpiresAt: new Date(NOW + 600_000).toISOString()
  })));
  await decisionClick;
});

test('a lost decision response is unconfirmed, is not retried, and consumes the local review', async () => {
  const ui = createOwnerControlUi({ now: NOW });
  const reviewedAction = action('action-a');
  await pair(ui, [{ workspaceId: 'owner-control-demo', items: [reviewedAction], nextAfter: null }]);
  ui.queueJson(200, review(reviewedAction));
  await actionButton(ui).dispatch('click');
  ui.queueFetch(() => Promise.reject(new Error('socket closed after request write')));

  await ui.click('approve');

  assert.equal(ui.fetchCalls.filter(call => call.path.endsWith('/approve')).length, 1);
  assert.match(ui.element('status').textContent, /unconfirmed/i);
  assert.match(ui.element('status').textContent, /may have been committed/i);
  assert.match(ui.element('status').textContent, /refresh/i);
  assert.match(ui.element('status').textContent, /do not retry/i);
  assert.doesNotMatch(ui.element('status').textContent, /socket closed/i);
  assert.equal(ui.element('review-panel').hidden, true);
  assert.equal(ui.element('approve').disabled, true);
});

test('an internal decision error is unconfirmed and never triggers an automatic retry', async () => {
  const ui = createOwnerControlUi({ now: NOW });
  const reviewedAction = action('action-a');
  await pair(ui, [{ workspaceId: 'owner-control-demo', items: [reviewedAction], nextAfter: null }]);
  ui.queueJson(200, review(reviewedAction));
  await actionButton(ui).dispatch('click');
  ui.queueJson(500, { error: 'internal_error' });

  await ui.click('cancel');

  assert.equal(ui.fetchCalls.filter(call => call.path.endsWith('/cancel')).length, 1);
  assert.match(ui.element('status').textContent, /unconfirmed/i);
  assert.match(ui.element('status').textContent, /may have been committed/i);
  assert.match(ui.element('status').textContent, /refresh/i);
  assert.match(ui.element('status').textContent, /do not retry/i);
});

test('a confirmed decision keeps its server success visible without an automatic refresh', async () => {
  const ui = createOwnerControlUi({ now: NOW });
  const reviewedAction = action('action-a');
  await pair(ui, [{ workspaceId: 'owner-control-demo', items: [reviewedAction], nextAfter: null }]);
  ui.queueJson(200, review(reviewedAction));
  await actionButton(ui).dispatch('click');
  ui.queueJson(200, action('action-a', {
    status: 'approved',
    approvalExpiresAt: new Date(NOW + 600_000).toISOString()
  }));

  await ui.click('approve');

  assert.equal(ui.fetchCalls.filter(call => call.path === '/api/actions').length, 1);
  assert.match(ui.element('status').textContent, /approval recorded by the server \(approved\)/i);
  assert.equal(ui.element('status').className, 'status');
});

test('sign-out wins over a delayed decision response and keeps its visible persistence warning', async () => {
  const ui = createOwnerControlUi({ now: NOW });
  const reviewedAction = action('action-a');
  await pair(ui, [{ workspaceId: 'owner-control-demo', items: [reviewedAction], nextAfter: null }]);
  ui.queueJson(200, review(reviewedAction));
  await actionButton(ui).dispatch('click');
  const decision = deferred();
  ui.queueFetch(() => decision.promise);
  const decisionClick = ui.click('approve');
  await ui.flush();
  ui.queueJson(204, undefined);

  await ui.click('sign-out');
  decision.resolve(response(200, action('action-a', { status: 'approved' })));
  await decisionClick;

  assert.equal(ui.element('pairing').hidden, false);
  assert.equal(ui.element('console').hidden, true);
  assert.match(ui.element('status').textContent, /signed out.*approvals persist.*restart/i);
  assert.doesNotMatch(ui.element('status').textContent, /recorded by the server/i);
});

test('an expired server session returns to pairing with restart instructions', async () => {
  const ui = createOwnerControlUi({ now: NOW });
  await pair(ui);
  ui.queueJson(401, { error: 'unauthenticated' });

  await ui.click('refresh');

  assert.equal(ui.element('pairing').hidden, false);
  assert.equal(ui.element('console').hidden, true);
  assert.match(ui.element('status').textContent, /session expired.*restart/i);
});
