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

function serviceStatus(overrides = {}) {
  return {
    lifecycle: 'running', databaseMode: 'plaintext',
    model: { configured: true, selection: { provider: 'scripted', model: 'synthetic' } },
    queue: { queued: 0, running: 0, finished: 1, stopped: 0, interrupted: 0,
      oldestQueuedAt: null, activeJobId: null },
    runtime: { accepting: true, faulted: false, activeJobId: null, activeStartedAt: null,
      lastSchedulerPollAt: null, nextDueAt: null },
    unresolvedActionIds: [], unresolvedActions: [],
    limits: { foreground: true, awakeOnly: true, supervised: false },
    ...overrides
  };
}

function jobSummary(overrides = {}) {
  return {
    id: 'job-1', position: 1, requestId: 'web-chat-request', kind: 'owner_turn', status: 'finished',
    admittedAt: new Date(NOW).toISOString(), startedAt: new Date(NOW).toISOString(),
    finishedAt: new Date(NOW).toISOString(), focus: { threadId: 'thread', workId: null },
    actionId: null, resultReason: 'completed', ...overrides
  };
}

async function enableService(ui, items = []) {
  ui.queueJson(200, serviceStatus());
  ui.queueJson(200, { items, nextAfter: null });
  ui.queueJson(200, { items: [], nextAfter: null });
  await ui.click('service-refresh');
}

test('service UI loads exact chat text and renders action outcome separately from verification', async () => {
  const ui = createOwnerControlUi({ now: NOW });
  await pair(ui);
  await enableService(ui, [jobSummary(), jobSummary({
    id: 'job-2', position: 2, requestId: 'web-execute-request', kind: 'execute',
    focus: null, actionId: 'action-a', resultReason: 'readback_unresolved'
  })]);

  ui.queueJson(200, { ...jobSummary(), result: { reason: 'completed', conversation: {
    threadId: 'thread', ownerText: 'Owner question', assistantText: 'the actual reply'
  } } });
  await ui.element('jobs').children[0].children[0].dispatch('click');
  assert.match(ui.element('job-result').textContent, /Owner question/);
  assert.match(ui.element('job-result').textContent, /the actual reply/);

  ui.queueJson(200, { ...jobSummary({ id: 'job-2', position: 2, requestId: 'web-execute-request',
    kind: 'execute', focus: null, actionId: 'action-a', resultReason: 'readback_unresolved' }),
  result: { reason: 'readback_unresolved', action: { actionId: 'action-a',
    outcome: { status: 'accepted', evidenceRef: 'outcome-ref', evidence: 'provider accepted' },
    verification: { status: 'not_satisfied', recordedAt: new Date(NOW).toISOString(),
      evidenceRef: null, evidence: null } } } });
  await ui.element('jobs').children[1].children[0].dispatch('click');
  const resultText = ui.element('job-result').textContent;
  assert.match(resultText, /Outcome status: accepted/);
  assert.match(resultText, /Outcome evidence: provider accepted/);
  assert.match(resultText, /Verification status: not_satisfied/);
  assert.match(resultText, /Result: readback_unresolved/);
});

test('readback UI separates historical unknown effect from satisfied verification', async () => {
  const ui = createOwnerControlUi({ now: NOW });
  await pair(ui);
  const job = jobSummary({ kind: 'readback', actionId: 'action', focus: null });
  await enableService(ui, [job]);
  ui.queueJson(200, { ...job, result: { reason: 'completed', action: { actionId: 'action',
    outcome: { status: 'unknown', evidenceRef: 'original-outcome', evidence: 'Provider outcome unavailable' },
    verification: { status: 'satisfied', recordedAt: new Date(NOW).toISOString(), evidenceRef: null, evidence: null }
  } } });
  await ui.element('jobs').children[0].children[0].dispatch('click');
  assert.match(ui.element('job-result').textContent, /Outcome status: unknown/);
  assert.match(ui.element('job-result').textContent, /Provider outcome unavailable/);
  assert.match(ui.element('job-result').textContent, /Verification status: satisfied/);
  assert.doesNotMatch(ui.element('job-result').textContent, /Outcome status: accepted/);
});

test('service UI identifies legacy reminders without inventing service request provenance', async () => {
  const ui = createOwnerControlUi({ now: NOW });
  await pair(ui);
  const reminder = { timerId: 'legacy-timer', requestId: null, admittedAt: null,
    work: { id: 'work', title: 'Legacy follow-up' }, dueAt: new Date(NOW).toISOString(), status: 'fired' };
  const job = jobSummary({ kind: 'reminder', requestId: 'legacy-timer', focus: null });
  ui.queueJson(200, serviceStatus());
  ui.queueJson(200, { items: [job], nextAfter: null });
  ui.queueJson(200, { items: [reminder], nextAfter: null });
  await ui.click('service-refresh');
  assert.match(ui.element('reminders').textContent, /Legacy follow-up/);
  assert.match(ui.element('reminders').textContent, /no owner-service receipt/i);
  assert.doesNotMatch(ui.element('reminders').textContent, /null/);
  ui.queueJson(200, { ...job, result: { reason: 'completed', reminder } });
  await ui.element('jobs').children[0].children[0].dispatch('click');
  assert.match(ui.element('job-result').textContent, /no owner-service receipt/i);
  assert.match(ui.element('job-result').textContent, /Reminder status: fired/);
});

test('service UI renders durable scheduled, fired, and cancelled reminder meaning', async () => {
  const ui = createOwnerControlUi({ now: NOW });
  await pair(ui);
  ui.queueJson(200, serviceStatus());
  ui.queueJson(200, { items: [], nextAfter: null });
  ui.queueJson(200, { items: [
    { timerId: 'timer-1', requestId: 'owner-first', admittedAt: new Date(NOW).toISOString(),
      work: { id: 'work-1', title: 'Check refund' }, dueAt: new Date(NOW + 60_000).toISOString(), status: 'scheduled' },
    { timerId: 'timer-2', requestId: 'owner-second', admittedAt: new Date(NOW).toISOString(),
      work: { id: 'work-2', title: 'Send notes' }, dueAt: new Date(NOW + 120_000).toISOString(), status: 'fired' },
    { timerId: 'timer-3', requestId: 'owner-third', admittedAt: new Date(NOW).toISOString(),
      work: { id: 'work-3', title: 'Stale follow-up' }, dueAt: new Date(NOW + 180_000).toISOString(), status: 'cancelled' }
  ], nextAfter: null });

  await ui.click('service-refresh');

  const text = ui.element('reminders').textContent;
  assert.match(text, /owner-first.*Check refund.*scheduled/);
  assert.match(text, /owner-second.*Send notes.*fired/);
  assert.match(text, /owner-third.*Stale follow-up.*cancelled/);
});

test('chat and reminder lost acknowledgements retain immutable request identities for explicit receipt recovery', async () => {
  const ui = createOwnerControlUi({ now: NOW });
  await pair(ui);
  await enableService(ui);
  ui.element('chat-thread').value = 'thread';
  ui.element('chat-text').value = 'Owner text';
  ui.queueFetch(() => Promise.reject(new Error('response lost after commit')));

  await ui.click('send-chat');
  const firstChat = JSON.parse(ui.fetchCalls.at(-1).init.body);
  assert.match(ui.element('status').textContent, new RegExp(firstChat.requestId));
  assert.match(ui.element('status').textContent, /recover/i);
  ui.queueJson(202, { receipt: { id: 'chat-receipt' }, job: jobSummary({ requestId: firstChat.requestId }),
    duplicate: true });
  ui.queueJson(200, { items: [], nextAfter: null });
  await ui.click('send-chat');
  const chatPosts = ui.fetchCalls.filter(call => call.path === '/api/chat')
    .map(call => JSON.parse(call.init.body));
  assert.equal(chatPosts.length, 2);
  assert.equal(chatPosts[1].requestId, chatPosts[0].requestId);

  ui.element('reminder-work').value = 'work';
  ui.element('reminder-due').value = new Date(NOW + 60_000).toISOString();
  ui.queueFetch(() => Promise.reject(new Error('response lost after commit')));
  await ui.click('create-reminder');
  const firstReminder = JSON.parse(ui.fetchCalls.at(-1).init.body);
  assert.match(ui.element('status').textContent, new RegExp(firstReminder.requestId));
  ui.queueJson(202, { receipt: { id: 'reminder-receipt' }, duplicate: true });
  ui.queueJson(200, { items: [], nextAfter: null });
  ui.queueJson(200, { items: [], nextAfter: null });
  await ui.click('create-reminder');
  const reminderPosts = ui.fetchCalls.filter(call => call.path === '/api/reminders' && call.init.method === 'POST')
    .map(call => JSON.parse(call.init.body));
  assert.equal(reminderPosts.length, 2);
  assert.equal(reminderPosts[1].requestId, reminderPosts[0].requestId);
});

test('confirmed reminder admission is not presented as unconfirmed when queue refresh fails', async () => {
  const ui = createOwnerControlUi({ now: NOW });
  await pair(ui);
  await enableService(ui);
  ui.element('reminder-work').value = 'work';
  ui.element('reminder-due').value = new Date(NOW + 60_000).toISOString();
  ui.queueJson(202, { receipt: { id: 'reminder-receipt' }, duplicate: false });
  ui.queueFetch(() => Promise.reject(new Error('queue refresh unavailable')));

  await ui.click('create-reminder');

  assert.match(ui.element('status').textContent, /admission confirmed/i);
  assert.match(ui.element('status').textContent, /queue refresh failed/i);
  assert.doesNotMatch(ui.element('status').textContent, /recover receipt/i);
  assert.equal(ui.element('reminder-work').value, '');
  assert.equal(ui.element('reminder-due').value, '');
  assert.doesNotMatch(ui.element('create-reminder').textContent, /recover/i);
});

test('lost reminder acknowledgement retains its immutable recovery request after the due time', async () => {
  const ui = createOwnerControlUi({ now: NOW });
  await pair(ui);
  await enableService(ui);
  const dueAt = new Date(NOW + 1_000).toISOString();
  ui.element('reminder-work').value = 'work';
  ui.element('reminder-due').value = dueAt;
  ui.queueFetch(() => Promise.reject(new Error('response lost after commit')));
  await ui.click('create-reminder');
  const first = JSON.parse(ui.fetchCalls.at(-1).init.body);
  await ui.advanceTo(NOW + 1_001);
  ui.queueJson(202, { receipt: { id: 'original-reminder-receipt' }, duplicate: true });
  ui.queueJson(200, { items: [], nextAfter: null });
  ui.queueJson(200, { items: [], nextAfter: null });

  await ui.click('create-reminder');

  const posts = ui.fetchCalls.filter(call => call.path === '/api/reminders' && call.init.method === 'POST')
    .map(call => JSON.parse(call.init.body));
  assert.equal(posts.length, 2);
  assert.equal(posts[1].requestId, first.requestId);
  assert.equal(posts[1].dueAt, dueAt);
  assert.match(ui.element('status').textContent, /existing receipt/i);
  assert.equal(ui.element('reminder-work').value, '');
  assert.equal(ui.element('reminder-due').value, '');
  assert.doesNotMatch(ui.element('create-reminder').textContent, /recover/i);
});

test('missing expired reminder recovery is terminal and permits a new future request', async () => {
  const ui = createOwnerControlUi({ now: NOW });
  await pair(ui);
  await enableService(ui);
  ui.element('reminder-work').value = 'work';
  ui.element('reminder-due').value = new Date(NOW + 1_000).toISOString();
  ui.queueFetch(() => Promise.reject(new Error('request was not committed')));
  await ui.click('create-reminder');
  await ui.advanceTo(NOW + 1_001);
  ui.queueJson(400, { error: 'invalid_request' });

  await ui.click('create-reminder');

  assert.match(ui.element('status').textContent, /no durable reminder receipt/i);
  assert.match(ui.element('status').textContent, /new future time/i);
  assert.doesNotMatch(ui.element('create-reminder').textContent, /recover/i);
  const posts = ui.fetchCalls.filter(call => call.path === '/api/reminders' && call.init.method === 'POST');
  assert.equal(posts.length, 2);
});

test('readback lost acknowledgement reuses its immutable request identity', async () => {
  const ui = createOwnerControlUi({ now: NOW });
  const accepted = action('action-a', { status: 'accepted',
    outcome: { status: 'accepted', evidenceRef: 'outcome-ref' },
    verification: { status: 'not_satisfied', recordedAt: new Date(NOW).toISOString(), evidenceRef: null } });
  await pair(ui, [{ workspaceId: 'owner-control-demo', items: [accepted], nextAfter: null }]);
  await enableService(ui);
  ui.queueJson(200, review(accepted, { canApprove: false, canCancel: false,
    approvalExpiresAt: null, canExecute: false }));
  await actionButton(ui).dispatch('click');
  assert.match(ui.element('review').textContent, /Outcome statusaccepted/);
  assert.match(ui.element('review').textContent, /Verification statusnot_satisfied/);
  ui.queueFetch(() => Promise.reject(new Error('response lost after commit')));

  await ui.click('readback');
  const first = JSON.parse(ui.fetchCalls.at(-1).init.body);
  assert.match(ui.element('status').textContent, new RegExp(first.requestId));
  assert.match(ui.element('readback').textContent, /recover/i);
  ui.queueJson(202, { receipt: { id: 'readback-receipt' }, job: jobSummary({
    id: 'readback-job', requestId: first.requestId, kind: 'readback', focus: null,
    actionId: 'action-a', status: 'queued', resultReason: null
  }), duplicate: true });
  ui.queueJson(200, { items: [], nextAfter: null });
  await ui.click('readback');

  const posts = ui.fetchCalls.filter(call => call.path.endsWith('/readback'))
    .map(call => JSON.parse(call.init.body));
  assert.equal(posts.length, 2);
  assert.equal(posts[1].requestId, posts[0].requestId);
});

test('confirmed readback admission is not presented as unconfirmed when queue refresh fails', async () => {
  const ui = createOwnerControlUi({ now: NOW });
  const accepted = action('action-a', { status: 'accepted',
    outcome: { status: 'accepted', evidenceRef: 'outcome-ref' }, verification: null });
  await pair(ui, [{ workspaceId: 'owner-control-demo', items: [accepted], nextAfter: null }]);
  await enableService(ui);
  ui.queueJson(200, review(accepted, { canApprove: false, canCancel: false,
    approvalExpiresAt: null, canExecute: false }));
  await actionButton(ui).dispatch('click');
  ui.queueJson(202, { receipt: { id: 'readback-receipt' }, job: jobSummary({
    id: 'readback-job', requestId: 'readback-request', kind: 'readback', focus: null,
    actionId: 'action-a', status: 'queued', resultReason: null
  }), duplicate: false });
  ui.queueFetch(() => Promise.reject(new Error('queue refresh unavailable')));

  await ui.click('readback');

  assert.match(ui.element('status').textContent, /admission confirmed/i);
  assert.match(ui.element('status').textContent, /queue refresh failed/i);
  assert.doesNotMatch(ui.element('status').textContent, /may have committed|unconfirmed|recover receipt/i);
  assert.doesNotMatch(ui.element('readback').textContent, /recover/i);
});

test('an older exact-result response cannot replace the owners newer job selection', async () => {
  const ui = createOwnerControlUi({ now: NOW });
  const jobA = jobSummary({ id: 'job-a', requestId: 'req-a' });
  const jobB = jobSummary({ id: 'job-b', position: 2, requestId: 'req-b' });
  await pair(ui);
  await enableService(ui, [jobA, jobB]);
  const delayedA = deferred();
  ui.queueFetch(() => delayedA.promise);
  const selectingA = ui.element('jobs').children[0].children[0].dispatch('click');
  ui.queueJson(200, { ...jobB, result: { reason: 'completed', conversation: {
    threadId: 'thread', ownerText: 'Question B', assistantText: 'Answer B'
  } } });

  await ui.element('jobs').children[1].children[0].dispatch('click');
  assert.match(ui.element('job-result').textContent, /Request: req-b/);
  assert.match(ui.element('job-result').textContent, /Answer B/);
  delayedA.resolve(response(200, { ...jobA, result: { reason: 'completed', conversation: {
    threadId: 'thread', ownerText: 'Question A', assistantText: 'Answer A'
  } } }));
  await selectingA;

  assert.match(ui.element('job-result').textContent, /Request: req-b/);
  assert.match(ui.element('job-result').textContent, /Answer B/);
  assert.doesNotMatch(ui.element('job-result').textContent, /req-a|Answer A/);
});

test('logout fences every delayed jobs page before it can restore private service state', async () => {
  const ui = createOwnerControlUi({ now: NOW });
  await pair(ui);
  const jobs = deferred();
  ui.queueJson(200, serviceStatus());
  ui.queueFetch(() => jobs.promise);
  const loading = ui.click('service-refresh');
  for (let index = 0; index < 10 && !ui.fetchCalls.some(call => call.path === '/api/jobs'); index++) await ui.flush();
  assert.equal(ui.fetchCalls.at(-1).path, '/api/jobs');
  ui.queueJson(204, undefined);

  const signingOut = ui.click('sign-out');
  await ui.flush();
  assert.equal(ui.element('jobs').textContent, '');
  jobs.resolve(response(200, { items: [jobSummary({ id: 'private-job' })], nextAfter: null }));
  await Promise.all([loading, signingOut]);

  assert.equal(ui.element('jobs').textContent, '');
  assert.equal(ui.element('job-result').textContent, '');
  assert.equal(ui.element('service-dashboard').hidden, true);
  assert.equal(ui.element('pairing').hidden, false);
});

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
