(() => {
  'use strict';

  const MAXIMUM_BOOTSTRAP_BYTES = 4096;
  const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
  const ISO_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
  const ACTION_JOB_PATHS = Object.freeze({ execute: '/execute', readback: '/readback' });

  const byId = id => document.getElementById(id);
  const pairingPanel = byId('pairing');
  const consolePanel = byId('console');
  const fileInput = byId('bootstrap-file');
  const statusNode = byId('status');
  const actionList = byId('actions');
  const reviewPanel = byId('review-panel');
  const reviewNode = byId('review');
  const pairButton = byId('pair');
  const refreshButton = byId('refresh');
  const signOutButton = byId('sign-out');
  const approveButton = byId('approve');
  const cancelButton = byId('cancel');
  const executeButton = byId('execute');
  const readbackButton = byId('readback');
  const serviceRefreshButton = byId('service-refresh');
  const serviceDashboard = byId('service-dashboard');
  const serviceLifecycle = byId('service-lifecycle');
  const serviceLimits = byId('service-limits');
  const serviceBarriers = byId('service-barriers');
  const jobsNode = byId('jobs');
  const remindersNode = byId('reminders');
  const jobResultNode = byId('job-result');
  const refreshJobsButton = byId('refresh-jobs');
  const chatThread = byId('chat-thread');
  const chatWork = byId('chat-work');
  const chatText = byId('chat-text');
  const sendChatButton = byId('send-chat');
  const reminderWork = byId('reminder-work');
  const reminderDue = byId('reminder-due');
  const createReminderButton = byId('create-reminder');
  const connectionsNode = byId('connections');
  const monitoredAdaptersNode = byId('monitored-adapters');

  let sessionToken = null;
  let selectedActionId = null;
  let activeReview = null;
  let reviewExpiryTimer = null;
  let viewGeneration = 0;
  let pairingPending = false;
  let pendingList = null;
  const pendingReviews = new Map();
  let pendingDecision = null;
  let signingOut = false;
  let actionButtons = [];
  let servicePending = null;
  let serviceAvailable = false;
  let serviceRequestCounter = 0;
  let activeExecutionRequest = null;
  let jobDetailGeneration = 0;
  const pendingAdmissions = { chat: null, reminder: null, readback: null };

  class RequestFailure extends Error {
    constructor(kind, status = 0, code = '') {
      super(kind);
      this.kind = kind;
      this.status = status;
      this.code = code;
    }
  }

  function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  function hasExactKeys(value, expected) {
    if (!isRecord(value)) return false;
    const actual = Object.keys(value).sort();
    const sortedExpected = [...expected].sort();
    return actual.length === sortedExpected.length &&
      actual.every((key, index) => key === sortedExpected[index]);
  }

  function isCanonicalFutureInstant(value) {
    if (typeof value !== 'string' || !ISO_INSTANT_PATTERN.test(value)) return false;
    const timestamp = Date.parse(value);
    if (!Number.isFinite(timestamp) || timestamp <= Date.now()) return false;
    try {
      return new Date(timestamp).toISOString() === value;
    } catch {
      return false;
    }
  }

  function isBootstrapDocument(value) {
    return hasExactKeys(value, ['version', 'origin', 'token', 'expiresAt']) &&
      Object.getPrototypeOf(value) === Object.prototype &&
      value.version === 1 &&
      value.origin === location.origin &&
      typeof value.token === 'string' &&
      TOKEN_PATTERN.test(value.token) &&
      isCanonicalFutureInstant(value.expiresAt);
  }

  function isControlSession(value) {
    return hasExactKeys(value, ['token', 'expiresAt', 'idleExpiresAt']) &&
      typeof value.token === 'string' && TOKEN_PATTERN.test(value.token) &&
      isCanonicalFutureInstant(value.expiresAt) &&
      isCanonicalFutureInstant(value.idleExpiresAt) &&
      Date.parse(value.idleExpiresAt) <= Date.parse(value.expiresAt);
  }

  function setStatus(message, isError = false) {
    statusNode.textContent = message;
    statusNode.className = isError ? 'error' : 'status';
  }

  function updateControls() {
    const decisionPending = pendingDecision !== null;
    const listPending = pendingList !== null;
    pairButton.disabled = pairingPending;
    refreshButton.disabled = sessionToken === null || decisionPending || listPending;
    signOutButton.disabled = sessionToken === null || signingOut;
    approveButton.disabled = decisionPending || activeReview === null || !activeReview.canApprove;
    cancelButton.disabled = decisionPending || activeReview === null || !activeReview.canCancel;
    executeButton.disabled = decisionPending || activeReview === null || !activeReview.canExecute ||
      typeof activeReview.executionToken !== 'string';
    readbackButton.disabled = decisionPending || activeReview === null ||
      !['accepted', 'unknown'].includes(String(activeReview.action.status));
    serviceRefreshButton.disabled = sessionToken === null || servicePending !== null;
    refreshJobsButton.disabled = sessionToken === null || !serviceAvailable || servicePending !== null;
    sendChatButton.disabled = sessionToken === null || !serviceAvailable || servicePending !== null;
    sendChatButton.textContent = pendingAdmissions.chat ? 'Recover chat receipt' : 'Queue chat';
    createReminderButton.disabled = sessionToken === null || !serviceAvailable || servicePending !== null;
    createReminderButton.textContent = pendingAdmissions.reminder ? 'Recover reminder receipt' : 'Create reminder';
    readbackButton.textContent = pendingAdmissions.readback ? 'Recover readback receipt' : 'Request readback';
    for (const entry of actionButtons) {
      entry.button.disabled = sessionToken === null || decisionPending || listPending ||
        pendingReviews.has(entry.actionId);
    }
  }

  function clearReview() {
    if (reviewExpiryTimer !== null) {
      clearTimeout(reviewExpiryTimer);
      reviewExpiryTimer = null;
    }
    activeReview = null;
    activeExecutionRequest = null;
    selectedActionId = null;
    reviewNode.textContent = '';
    reviewPanel.hidden = true;
    updateControls();
  }

  function clearActions() {
    actionButtons = [];
    actionList.textContent = '';
    updateControls();
  }

  function clearService() {
    jobDetailGeneration += 1;
    serviceAvailable = false;
    servicePending = null;
    serviceDashboard.hidden = true;
    serviceLifecycle.textContent = '';
    serviceLimits.textContent = '';
    serviceBarriers.textContent = '';
    jobsNode.textContent = '';
    remindersNode.textContent = '';
    jobResultNode.textContent = '';
    connectionsNode.textContent = '';
    monitoredAdaptersNode.textContent = '';
    updateControls();
  }

  function showPairing() {
    consolePanel.hidden = true;
    pairingPanel.hidden = false;
  }

  function showConsole() {
    pairingPanel.hidden = true;
    consolePanel.hidden = false;
  }

  function leaveSession() {
    sessionToken = null;
    viewGeneration += 1;
    pendingList = null;
    pendingReviews.clear();
    pendingDecision = null;
    pendingAdmissions.chat = null;
    pendingAdmissions.reminder = null;
    pendingAdmissions.readback = null;
    clearReview();
    clearActions();
    clearService();
    showPairing();
    updateControls();
  }

  function expireSession() {
    leaveSession();
    setStatus('The local session expired. Restart the server to pair again. Existing approvals persist.', true);
  }

  async function decodeResponse(response) {
    if (response.status === 204) return undefined;

    let body;
    let parsed = true;
    try {
      body = await response.json();
    } catch {
      body = {};
      parsed = false;
    }

    if (!response.ok) {
      const code = parsed && isRecord(body) && typeof body.error === 'string' ? body.error : '';
      throw new RequestFailure('http', response.status, code);
    }
    if (!parsed) throw new RequestFailure('invalid_response', response.status);
    return body;
  }

  async function request(path, token, method = 'GET', body) {
    const headers = { Authorization: `Bearer ${token}` };
    const init = { method, credentials: 'omit', headers };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }

    let response;
    try {
      response = await fetch(path, init);
    } catch {
      throw new RequestFailure('network');
    }
    return decodeResponse(response);
  }

  function requestFailureMessage(error) {
    if (!(error instanceof RequestFailure)) return 'The local request could not be completed.';
    if (error.status === 403) return 'The local server rejected this page origin.';
    if (error.status === 404) return 'The requested prepared action is no longer available.';
    if (error.status === 409) return 'The action changed or this review is no longer current.';
    if (error.status === 429) return 'The local server is temporarily limiting review requests.';
    if (error.status === 503) return 'Local owner control is unavailable.';
    if (error.kind === 'invalid_response') return 'The local server returned an invalid response.';
    if (error.kind === 'network') return 'The local server could not be reached.';
    return 'The local request failed.';
  }

  function mutationResultIsUnconfirmed(error) {
    return error instanceof RequestFailure &&
      (error.kind === 'network' || error.kind === 'invalid_response' || error.status === 500);
  }

  function nextRequestId(purpose) {
    serviceRequestCounter += 1;
    return `web-${purpose}-${Date.now()}-${serviceRequestCounter}`;
  }

  function validServiceStatus(value) {
    return isRecord(value) && ['running', 'stopping', 'faulted'].includes(value.lifecycle) &&
      isRecord(value.model) && typeof value.model.configured === 'boolean' &&
      isRecord(value.queue) && isRecord(value.runtime) && Array.isArray(value.unresolvedActionIds) &&
      Array.isArray(value.unresolvedActions) &&
      Array.isArray(value.connections) && value.connections.every(validConnection) &&
      Array.isArray(value.monitoredAdapters) && value.monitoredAdapters.every(validMonitoredAdapter) &&
      isRecord(value.limits);
  }

  function validMonitoredAdapter(value) {
    return isRecord(value) && value.adapterId === 'us-visa-china' && value.adapterVersion === 1 &&
      value.liveRegistration === 'disabled' && ['not_started', 'ready_for_owner_review'].includes(value.discovery) &&
      Array.isArray(value.blockers) && value.blockers.every(item => typeof item === 'string') &&
      (value.report === null || isRecord(value.report));
  }

  function renderMonitoredAdapters(adapters) {
    monitoredAdaptersNode.textContent = '';
    for (const adapter of adapters) {
      const item = document.createElement('li');
      const blockers = adapter.blockers.length > 0 ? adapter.blockers.join(', ') : 'separate local activation required';
      item.textContent = `${adapter.adapterId}@${adapter.adapterVersion}: live registration ${adapter.liveRegistration}; ` +
        `supervised discovery ${adapter.discovery}; blockers: ${blockers}.`;
      monitoredAdaptersNode.append(item);
    }
  }

  function validConnection(value) {
    return hasExactKeys(value, ['id', 'service', 'generation', 'profileId', 'mode', 'state', 'secretPurposes']) &&
      typeof value.id === 'string' && typeof value.service === 'string' && Number.isSafeInteger(value.generation) &&
      typeof value.profileId === 'string' && ['synthetic', 'live'].includes(value.mode) &&
      ['connected', 'disconnecting', 'disconnect_failed', 'disconnected'].includes(value.state) &&
      Array.isArray(value.secretPurposes) && value.secretPurposes.every(item => typeof item === 'string');
  }

  function renderConnections(connections, token, marker) {
    connectionsNode.textContent = '';
    for (const connection of connections) {
      const item = document.createElement('li');
      item.textContent = `${connection.service} — ${connection.id}; profile ${connection.profileId}; generation ${connection.generation}; ${connection.mode}; ${connection.state}. `;
      const choices = [];
      for (let index = 0; index < connection.secretPurposes.length; index++) {
        const purpose = connection.secretPurposes[index];
        const label = document.createElement('label');
        const choice = document.createElement('input');
        choice.type = 'checkbox'; choice.value = purpose; choice.checked = false;
        choice.id = `connection-delete-${connection.id}-${index}`;
        label.htmlFor = choice.id; label.textContent = `Delete ${purpose}`;
        label.append(choice); choices.push(choice); item.append(label);
      }
      if (connection.state === 'connected' || connection.state === 'disconnect_failed') {
        const button = document.createElement('button');
        button.type = 'button'; button.textContent = connection.state === 'disconnect_failed'
          ? 'Retry incomplete disconnect and selected deletions'
          : 'Disconnect and delete selected stored items';
        button.addEventListener('click', async () => {
          button.disabled = true;
          try {
            const result = await request(`/api/connections/${encodeURIComponent(connection.id)}/disconnect`, token,
              'POST', { deletePurposes: choices.filter(choice => choice.checked).map(choice => choice.value) });
            if (marker !== viewGeneration || token !== sessionToken) return;
            if (!hasExactKeys(result, ['connectionId', 'state', 'profileRemovalOffered', 'profilePath',
              'deletedPurposes']) || result.connectionId !== connection.id || result.state !== 'disconnected' ||
              result.profileRemovalOffered !== true || typeof result.profilePath !== 'string' ||
              !Array.isArray(result.deletedPurposes)) throw new RequestFailure('invalid_response', 200);
            item.textContent = `${connection.service} — disconnected. Dedicated profile was not removed; removal is a separate explicit action.`;
            setStatus('Connection disconnected. The dedicated profile was not removed.');
          } catch (error) {
            if (marker !== viewGeneration || token !== sessionToken) return;
            button.disabled = false; setStatus(requestFailureMessage(error), true);
          }
        });
        item.append(button);
      }
      connectionsNode.append(item);
    }
  }

  function validJobSummary(job) {
    return isRecord(job) && typeof job.id === 'string' && typeof job.requestId === 'string' &&
      typeof job.kind === 'string' && typeof job.status === 'string' &&
      (job.resultReason === null || typeof job.resultReason === 'string');
  }

  function renderJobDetail(job) {
    if (!validJobSummary(job) || !isRecord(job.result) || typeof job.result.reason !== 'string')
      throw new RequestFailure('invalid_response', 200);
    const lines = [`Request: ${job.requestId}`, `Result: ${job.result.reason}`];
    if (isRecord(job.result.conversation)) {
      const conversation = job.result.conversation;
      if (typeof conversation.threadId !== 'string' || typeof conversation.ownerText !== 'string' ||
        typeof conversation.assistantText !== 'string') throw new RequestFailure('invalid_response', 200);
      lines.push(`Thread: ${conversation.threadId}`, `Owner: ${conversation.ownerText}`,
        `Assistant: ${conversation.assistantText}`);
    }
    if (Array.isArray(job.result.works)) {
      for (const work of job.result.works) {
        if (!isRecord(work) || typeof work.id !== 'string' || typeof work.title !== 'string' ||
          typeof work.goal !== 'string' || work.phase !== 'open') throw new RequestFailure('invalid_response', 200);
        lines.push(`New work: ${work.title} (${work.id}) — ${work.goal}`);
      }
    }
    if (isRecord(job.result.action)) {
      const action = job.result.action;
      if (typeof action.actionId !== 'string' || !isRecord(action.outcome) ||
        typeof action.outcome.status !== 'string') throw new RequestFailure('invalid_response', 200);
      lines.push(`Action: ${action.actionId}`, `Outcome status: ${action.outcome.status}`,
        `Outcome evidence: ${action.outcome.evidence ?? 'None'}`,
        `Outcome evidence reference: ${action.outcome.evidenceRef ?? 'None'}`);
      if (action.verification === null) lines.push('Verification status: None');
      else {
        if (!isRecord(action.verification) || typeof action.verification.status !== 'string' ||
          typeof action.verification.recordedAt !== 'string') throw new RequestFailure('invalid_response', 200);
        lines.push(`Verification status: ${action.verification.status}`,
          `Verification recorded: ${action.verification.recordedAt}`,
          `Verification evidence: ${action.verification.evidence ?? 'None'}`,
          `Verification evidence reference: ${action.verification.evidenceRef ?? 'None'}`);
      }
    }
    if (isRecord(job.result.reminder)) {
      const reminder = job.result.reminder;
      if (!validReminderSummary(reminder)) throw new RequestFailure('invalid_response', 200);
      lines.push(`Reminder request: ${reminder.requestId ?? 'No owner-service receipt'}`, `Timer: ${reminder.timerId}`,
        `Work: ${reminder.work.title} (${reminder.work.id})`, `Due: ${reminder.dueAt}`,
        `Reminder status: ${reminder.status}`);
    }
    jobResultNode.textContent = lines.join('\n');
  }

  async function loadJobDetail(jobId) {
    if (sessionToken === null) return;
    const token = sessionToken;
    const marker = viewGeneration;
    const selection = ++jobDetailGeneration;
    jobResultNode.textContent = '';
    try {
      const job = await request(`/api/jobs/${encodeURIComponent(jobId)}`, token);
      if (token !== sessionToken || marker !== viewGeneration || selection !== jobDetailGeneration) return;
      renderJobDetail(job);
    } catch (error) {
      if (token !== sessionToken || marker !== viewGeneration || selection !== jobDetailGeneration) return;
      if (error instanceof RequestFailure && error.status === 401) expireSession();
      else setStatus(requestFailureMessage(error), true);
    }
  }

  function renderJobs(items) {
    jobDetailGeneration += 1;
    jobsNode.textContent = '';
    jobResultNode.textContent = '';
    for (const job of items) {
      if (!validJobSummary(job)) throw new RequestFailure('invalid_response', 200);
      const item = document.createElement('li');
      const result = job.resultReason === null ? '' : ` — ${job.resultReason}`;
      item.textContent = `${job.kind} — ${job.status}${result} — request ${job.requestId} — ${job.id} `;
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = 'Show exact result';
      button.addEventListener('click', () => loadJobDetail(job.id));
      item.append(button);
      jobsNode.append(item);
    }
  }

  async function fetchJobs(token, marker) {
    const items = [];
    const cursors = new Set();
    let after = null;
    do {
      const path = after === null ? '/api/jobs' : `/api/jobs?after=${encodeURIComponent(after)}`;
      const page = await request(path, token);
      if (token !== sessionToken || marker !== viewGeneration) return false;
      if (!isRecord(page) || !Array.isArray(page.items) ||
        (page.nextAfter !== null && !Number.isSafeInteger(page.nextAfter)))
        throw new RequestFailure('invalid_response', 200);
      items.push(...page.items);
      after = page.nextAfter;
      if (after !== null) {
        if (cursors.has(after)) throw new RequestFailure('invalid_response', 200);
        cursors.add(after);
      }
    } while (after !== null);
    if (token !== sessionToken || marker !== viewGeneration) return false;
    renderJobs(items);
    return true;
  }

  function validReminderSummary(reminder) {
    return hasExactKeys(reminder, ['timerId', 'requestId', 'admittedAt', 'work', 'dueAt', 'status']) &&
      typeof reminder.timerId === 'string' &&
      ((typeof reminder.requestId === 'string' && typeof reminder.admittedAt === 'string') ||
        (reminder.requestId === null && reminder.admittedAt === null)) && typeof reminder.dueAt === 'string' &&
      ['scheduled', 'fired', 'cancelled'].includes(reminder.status) &&
      hasExactKeys(reminder.work, ['id', 'title']) && typeof reminder.work.id === 'string' &&
      typeof reminder.work.title === 'string';
  }

  function renderReminders(items) {
    remindersNode.textContent = '';
    for (const reminder of items) {
      if (!validReminderSummary(reminder)) throw new RequestFailure('invalid_response', 200);
      const item = document.createElement('li');
      item.textContent = `${reminder.requestId ?? 'No owner-service receipt'} — ${reminder.work.title} (${reminder.work.id}) — ` +
        `${reminder.dueAt} — ${reminder.status} — timer ${reminder.timerId}`;
      remindersNode.append(item);
    }
  }

  async function fetchReminders(token, marker) {
    const items = [];
    const cursors = new Set();
    let after = null;
    do {
      const path = after === null ? '/api/reminders' : `/api/reminders?after=${encodeURIComponent(after)}`;
      const page = await request(path, token);
      if (token !== sessionToken || marker !== viewGeneration) return false;
      if (!isRecord(page) || !Array.isArray(page.items) ||
        (page.nextAfter !== null && !Number.isSafeInteger(page.nextAfter)))
        throw new RequestFailure('invalid_response', 200);
      items.push(...page.items);
      after = page.nextAfter;
      if (after !== null) {
        if (cursors.has(after)) throw new RequestFailure('invalid_response', 200);
        cursors.add(after);
      }
    } while (after !== null);
    if (token !== sessionToken || marker !== viewGeneration) return false;
    renderReminders(items);
    return true;
  }

  async function loadService() {
    if (sessionToken === null || servicePending !== null) return;
    const token = sessionToken;
    const marker = viewGeneration;
    const pendingRequest = {};
    servicePending = pendingRequest;
    updateControls();
    try {
      const value = await request('/api/service', token);
      if (marker !== viewGeneration || token !== sessionToken) return;
      if (!validServiceStatus(value)) throw new RequestFailure('invalid_response', 200);
      serviceAvailable = true;
      serviceDashboard.hidden = false;
      serviceLifecycle.textContent = JSON.stringify({
        lifecycle: value.lifecycle,
        databaseMode: value.databaseMode,
        model: value.model,
        queue: value.queue,
        runtime: value.runtime
      }, null, 2);
      serviceLimits.textContent = value.limits.awakeOnly && value.limits.foreground ?
        'Foreground and awake-only: work stops when this process or laptop stops. This is not a 24/7 daemon.' :
        'Review the reported service lifecycle limits.';
      renderConnections(value.connections, token, marker);
      renderMonitoredAdapters(value.monitoredAdapters);
      const maintenance = value.unresolvedActions.filter(action => isRecord(action) &&
        action.kind === 'crash_preserved_execution').map(action => action.actionId);
      serviceBarriers.textContent = maintenance.length > 0 ?
        `Crash-preserved running actions require stopped-service exclusive maintenance; never retry automatically: ${maintenance.join(', ')}` :
        value.unresolvedActionIds.length > 0 ?
        `Unresolved action barriers require explicit readback or review: ${value.unresolvedActionIds.join(', ')}` :
        'No unresolved action barriers reported.';
      if (!await fetchJobs(token, marker)) return;
      if (!await fetchReminders(token, marker)) return;
      if (marker === viewGeneration && token === sessionToken) setStatus('Service status and queue refreshed.');
    } catch (error) {
      if (marker !== viewGeneration || token !== sessionToken) return;
      if (error instanceof RequestFailure && error.status === 401) { expireSession(); return; }
      clearService();
      if (error instanceof RequestFailure && error.status === 404)
        setStatus('This local server provides prepared-action review only.');
      else setStatus(requestFailureMessage(error), true);
    } finally {
      if (servicePending === pendingRequest) servicePending = null;
      updateControls();
    }
  }

  async function refreshJobs() {
    if (sessionToken === null || !serviceAvailable || servicePending !== null) return;
    const token = sessionToken;
    const marker = viewGeneration;
    const pendingRequest = {};
    servicePending = pendingRequest;
    updateControls();
    try {
      if (!await fetchJobs(token, marker)) return;
      if (!await fetchReminders(token, marker)) return;
      if (token === sessionToken && marker === viewGeneration) setStatus('Service queue refreshed.');
    } catch (error) {
      if (token !== sessionToken || marker !== viewGeneration) return;
      if (error instanceof RequestFailure && error.status === 401) expireSession();
      else setStatus(requestFailureMessage(error), true);
    } finally {
      if (servicePending === pendingRequest) servicePending = null;
      updateControls();
    }
  }

  async function admitService(kind) {
    if (sessionToken === null || !serviceAvailable || servicePending !== null) return;
    const token = sessionToken;
    const marker = viewGeneration;
    let path;
    let submitted;
    let pending;
    if (kind === 'chat') {
      const threadId = chatThread.value.trim();
      const text = chatText.value.trim();
      const workId = chatWork.value.trim();
      if (!threadId || !text) { setStatus('Thread ID and owner message are required.', true); return; }
      path = '/api/chat';
      submitted = { threadId, text, ...(workId ? { workId } : {}) };
      pending = pendingAdmissions.chat;
    } else {
      const workId = reminderWork.value.trim();
      const dueAt = reminderDue.value.trim();
      path = '/api/reminders';
      submitted = { workId, dueAt };
      pending = pendingAdmissions.reminder;
      if (!pending && (!workId || !isCanonicalFutureInstant(dueAt))) {
        setStatus('A work ID and canonical UTC reminder instant are required.', true);
        return;
      }
    }
    if (pending && JSON.stringify(pending.submitted) !== JSON.stringify(submitted)) {
      setStatus(`Recover pending request ${pending.body.requestId} with its unchanged input before creating new work.`, true);
      return;
    }
    const body = pending?.body ?? Object.freeze({ requestId: nextRequestId(kind), ...submitted });
    pendingAdmissions[kind] = { submitted: Object.freeze({ ...submitted }), body };
    const pendingRequest = {};
    let admissionConfirmed = false;
    servicePending = pendingRequest;
    updateControls();
    try {
      const admitted = await request(path, token, 'POST', body);
      if (token !== sessionToken || marker !== viewGeneration) return;
      if (!isRecord(admitted) || !isRecord(admitted.receipt)) throw new RequestFailure('invalid_response', 202);
      admissionConfirmed = true;
      pendingAdmissions[kind] = null;
      if (kind === 'chat') chatText.value = '';
      else {
        reminderWork.value = '';
        reminderDue.value = '';
      }
      setStatus(`${kind === 'chat' ? 'Chat' : 'Reminder'} request durably admitted${admitted.duplicate ? ' (existing receipt)' : ''}.`);
      await fetchJobs(token, marker);
      if (kind === 'reminder') await fetchReminders(token, marker);
    } catch (error) {
      if (token !== sessionToken || marker !== viewGeneration) return;
      if (error instanceof RequestFailure && error.status === 401) expireSession();
      else if (admissionConfirmed)
        setStatus('Admission confirmed, but queue refresh failed. Refresh the queue to view the admitted request.', true);
      else if (mutationResultIsUnconfirmed(error))
        setStatus(`Admission may have committed. Recover receipt with request ${body.requestId} and unchanged input.`, true);
      else {
        pendingAdmissions[kind] = null;
        if (kind === 'reminder' && pending && error instanceof RequestFailure &&
          error.status === 400 && error.code === 'invalid_request' && Date.parse(body.dueAt) <= Date.now())
          setStatus('No durable reminder receipt exists for this expired request. Choose a new future time to create a reminder.', true);
        else setStatus(requestFailureMessage(error), true);
      }
    } finally {
      if (servicePending === pendingRequest) servicePending = null;
      updateControls();
    }
  }

  function appendReviewRow(list, name, value) {
    const term = document.createElement('dt');
    const detail = document.createElement('dd');
    term.textContent = name;
    detail.className = 'value';
    detail.textContent = value;
    list.append(term, detail);
  }

  function validReview(value) {
    return isRecord(value) && isRecord(value.action) &&
      typeof value.action.actionId === 'string' &&
      typeof value.action.workId === 'string' &&
      typeof value.action.workTitle === 'string' &&
      typeof value.action.digest === 'string' &&
      typeof value.reviewToken === 'string' && TOKEN_PATTERN.test(value.reviewToken) &&
      typeof value.reviewExpiresAt === 'string' &&
      (value.approvalExpiresAt === null || typeof value.approvalExpiresAt === 'string') &&
      typeof value.canApprove === 'boolean' && typeof value.canCancel === 'boolean';
  }

  function showReview(value) {
    if (!validReview(value)) throw new RequestFailure('invalid_response', 200);

    const reviewDeadline = Date.parse(value.reviewExpiresAt);
    if (!Number.isFinite(reviewDeadline) || reviewDeadline <= Date.now()) {
      clearReview();
      setStatus('The review expired. Obtain a new review before deciding.', true);
      return false;
    }

    const displayedReview = { ...value, canExecute: value.canExecute === true };
    activeReview = displayedReview;
    activeExecutionRequest = null;
    reviewNode.textContent = '';
    const rows = [
      ['Action ID', value.action.actionId],
      ['Work ID', value.action.workId],
      ['Work title', value.action.workTitle],
      ['Original work revision', String(value.action.workRevision)],
      ['Current work revision', String(value.action.currentWorkRevision)],
      ['Phase', String(value.action.phase)],
      ['Action status', String(value.action.status)],
      ['Outcome status', String(value.action.outcome?.status ?? value.action.status)],
      ['Outcome evidence reference', value.action.outcome?.evidenceRef ?? 'None'],
      ['Verification status', value.action.verification?.status ?? 'None'],
      ['Verification recorded', value.action.verification?.recordedAt ?? 'None'],
      ['Verification evidence reference', value.action.verification?.evidenceRef ?? 'None'],
      ['Synthetic operation', String(value.action.synthetic)],
      ['Action approval expiry', value.action.approvalExpiresAt ?? 'None'],
      ['Displayed approval expiry', value.approvalExpiresAt ?? 'None'],
      ['Review expiry', value.reviewExpiresAt],
      ['Can approve', String(value.canApprove)],
      ['Can cancel', String(value.canCancel)],
      ['Can explicitly execute', String(value.canExecute === true)],
      ['Execution confirmation expiry', value.executionExpiresAt ?? 'None'],
      ['Digest', value.action.digest],
      ['Current connection', JSON.stringify(value.connection, null, 2)],
      ['Complete command', JSON.stringify(value.command, null, 2)]
    ];
    const list = document.createElement('dl');
    for (const [name, fieldValue] of rows) appendReviewRow(list, name, fieldValue);
    reviewNode.append(list);
    reviewPanel.hidden = false;

    reviewExpiryTimer = setTimeout(() => {
      if (activeReview === displayedReview) {
        clearReview();
        setStatus('The review expired. Obtain a new review before deciding.', true);
      }
    }, reviewDeadline - Date.now());
    updateControls();
    return true;
  }

  async function runActionJob(kind) {
    if (sessionToken === null || activeReview === null || selectedActionId === null || pendingDecision !== null) return;
    const token = sessionToken;
    const marker = viewGeneration;
    const review = activeReview;
    const actionId = selectedActionId;
    let body;
    if (kind === 'execute') {
      if (!review.canExecute || typeof review.executionToken !== 'string') return;
      if (!activeExecutionRequest || activeExecutionRequest.actionId !== actionId ||
        activeExecutionRequest.digest !== review.action.digest ||
        activeExecutionRequest.confirmationToken !== review.executionToken) {
        activeExecutionRequest = { actionId, requestId: nextRequestId('execute'),
          digest: review.action.digest, confirmationToken: review.executionToken };
      }
      body = { requestId: activeExecutionRequest.requestId, digest: activeExecutionRequest.digest,
        confirmationToken: activeExecutionRequest.confirmationToken };
    } else {
      const pending = pendingAdmissions.readback;
      if (pending && (pending.actionId !== actionId || pending.body.digest !== review.action.digest)) {
        setStatus(`Recover pending request ${pending.body.requestId} from action ${pending.actionId} before creating another readback.`, true);
        return;
      }
      body = pending?.body ?? Object.freeze({ requestId: nextRequestId('readback'), digest: review.action.digest });
      pendingAdmissions.readback = { actionId, body };
    }
    const pending = {};
    let admissionConfirmed = false;
    pendingDecision = pending;
    updateControls();
    setStatus(`${kind === 'execute' ? 'Admitting explicit execution' : 'Admitting readback'}…`);
    try {
      const result = await request(`/api/actions/${encodeURIComponent(actionId)}${ACTION_JOB_PATHS[kind]}`, token, 'POST', body);
      if (token !== sessionToken || pendingDecision !== pending) return;
      if (!isRecord(result) || !isRecord(result.receipt) || !isRecord(result.job))
        throw new RequestFailure('invalid_response', 202);
      admissionConfirmed = true;
      activeExecutionRequest = null;
      if (kind === 'readback') pendingAdmissions.readback = null;
      setStatus(`${kind === 'execute' ? 'Execution' : 'Readback'} request durably admitted${result.duplicate ? ' (existing receipt)' : ''}.`);
      await fetchJobs(token, marker);
    } catch (error) {
      if (token !== sessionToken || pendingDecision !== pending) return;
      if (error instanceof RequestFailure && error.status === 401) expireSession();
      else if (admissionConfirmed)
        setStatus('Admission confirmed, but queue refresh failed. Refresh the queue to view the admitted request.', true);
      else if (mutationResultIsUnconfirmed(error) && kind === 'execute')
        setStatus('Execution admission is unconfirmed. Retry this same explicit request to recover its durable receipt; do not create another request.', true);
      else if (mutationResultIsUnconfirmed(error) && kind === 'readback')
        setStatus(`Readback admission may have committed. Recover receipt with request ${body.requestId}.`, true);
      else {
        if (kind === 'readback') pendingAdmissions.readback = null;
        setStatus(requestFailureMessage(error), true);
      }
    } finally {
      if (pendingDecision === pending) pendingDecision = null;
      updateControls();
    }
  }

  function renderActions(actions) {
    clearActions();
    for (const action of actions) {
      const item = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = `Review ${action.workTitle} — ${action.actionId} (${action.status})`;
      button.addEventListener('click', () => reviewAction(action.actionId));
      item.append(button);
      actionList.append(item);
      actionButtons.push({ button, actionId: action.actionId });
    }
    updateControls();
  }

  function validActionPage(page) {
    return isRecord(page) && Array.isArray(page.items) &&
      (page.nextAfter === null || typeof page.nextAfter === 'string');
  }

  async function loadActions() {
    if (sessionToken === null || pendingDecision !== null) return;

    const token = sessionToken;
    const marker = ++viewGeneration;
    const listRequest = {};
    pendingList = listRequest;
    clearReview();
    clearActions();
    setStatus('Loading prepared actions…');
    updateControls();

    const actions = [];
    const cursors = new Set();
    let after = null;
    try {
      do {
        const path = after === null ? '/api/actions' :
          `/api/actions?after=${encodeURIComponent(after)}`;
        const page = await request(path, token);
        if (marker !== viewGeneration || token !== sessionToken) return;
        if (!validActionPage(page)) throw new RequestFailure('invalid_response', 200);
        actions.push(...page.items);
        after = page.nextAfter;
        if (after !== null) {
          if (cursors.has(after)) throw new RequestFailure('invalid_response', 200);
          cursors.add(after);
        }
      } while (after !== null);

      if (marker !== viewGeneration || token !== sessionToken) return;
      renderActions(actions);
      setStatus(actions.length > 0 ?
        'Choose a prepared action to inspect.' :
        'No supported prepared actions are available.');
    } catch (error) {
      if (marker !== viewGeneration || token !== sessionToken) return;
      if (error instanceof RequestFailure && error.status === 401) {
        expireSession();
        return;
      }
      clearActions();
      setStatus(requestFailureMessage(error), true);
    } finally {
      if (pendingList === listRequest) pendingList = null;
      updateControls();
    }
  }

  async function reviewAction(actionId) {
    if (sessionToken === null || pendingDecision !== null || pendingReviews.has(actionId)) return;

    const token = sessionToken;
    const marker = ++viewGeneration;
    const reviewRequest = {};
    pendingReviews.set(actionId, reviewRequest);
    clearReview();
    setStatus('Loading the exact review…');
    updateControls();
    try {
      const value = await request(
        `/api/actions/${encodeURIComponent(actionId)}/review`,
        token,
        'POST',
        {}
      );
      if (marker !== viewGeneration || token !== sessionToken) return;
      selectedActionId = actionId;
      if (showReview(value)) setStatus('Review the complete command before deciding.');
    } catch (error) {
      if (marker !== viewGeneration || token !== sessionToken) return;
      if (error instanceof RequestFailure && error.status === 401) {
        expireSession();
        return;
      }
      clearReview();
      setStatus(`${requestFailureMessage(error)} Obtain a new review before deciding.`, true);
    } finally {
      if (pendingReviews.get(actionId) === reviewRequest) pendingReviews.delete(actionId);
      updateControls();
    }
  }

  async function decide(kind) {
    if (sessionToken === null || activeReview === null ||
      selectedActionId === null || pendingDecision !== null) return;

    const token = sessionToken;
    const review = activeReview;
    const actionId = selectedActionId;
    const marker = ++viewGeneration;
    const decisionRequest = {};
    pendingDecision = decisionRequest;
    setStatus(`Recording ${kind === 'approve' ? 'approval' : 'cancellation'}…`);
    updateControls();

    try {
      const result = await request(
        `/api/actions/${encodeURIComponent(actionId)}/${kind}`,
        token,
        'POST',
        { reviewToken: review.reviewToken, digest: review.action.digest }
      );
      if (marker !== viewGeneration || token !== sessionToken) return;
      if (!isRecord(result) || result.actionId !== actionId || typeof result.status !== 'string') {
        throw new RequestFailure('invalid_response', 200);
      }
      clearReview();
      setStatus(
        `${kind === 'approve' ? 'Approval' : 'Cancellation'} recorded by the server (${result.status}).`
      );
    } catch (error) {
      if (marker !== viewGeneration || token !== sessionToken) return;
      clearReview();
      if (error instanceof RequestFailure && error.status === 401) {
        expireSession();
      } else if (mutationResultIsUnconfirmed(error)) {
        setStatus(
          'The decision may have been committed, but its result is unconfirmed. ' +
          'Refresh the action list; do not retry the decision.',
          true
        );
      } else {
        setStatus(`${requestFailureMessage(error)} Obtain a new review before deciding again.`, true);
      }
    } finally {
      if (pendingDecision === decisionRequest) pendingDecision = null;
      updateControls();
    }
  }

  async function pairBrowser() {
    if (pairingPending) return;
    const chosen = fileInput.files && fileInput.files[0];
    if (!chosen) {
      setStatus('Select a pairing file first.', true);
      return;
    }
    if (!Number.isInteger(chosen.size) || chosen.size <= 0 ||
      chosen.size > MAXIMUM_BOOTSTRAP_BYTES) {
      fileInput.value = '';
      setStatus('The pairing file is empty or too large.', true);
      return;
    }

    const marker = ++viewGeneration;
    pairingPending = true;
    updateControls();
    setStatus('Checking the local pairing file…');

    let bootstrap;
    try {
      const text = await chosen.text();
      bootstrap = JSON.parse(text);
    } catch {
      bootstrap = null;
    }
    fileInput.value = '';

    if (marker !== viewGeneration) {
      pairingPending = false;
      updateControls();
      return;
    }
    if (!isBootstrapDocument(bootstrap)) {
      pairingPending = false;
      updateControls();
      setStatus('The pairing file is invalid for this local server.', true);
      return;
    }

    try {
      const value = await request(
        '/api/session/bootstrap',
        bootstrap.token,
        'POST',
        {}
      );
      if (marker !== viewGeneration) return;
      if (!isControlSession(value)) throw new RequestFailure('invalid_response', 200);
      sessionToken = value.token;
      showConsole();
      setStatus('Paired with this local server.');
      await loadActions();
    } catch (error) {
      if (marker !== viewGeneration) return;
      sessionToken = null;
      showPairing();
      const detail = error instanceof RequestFailure && error.status === 403 ?
        'The pairing file belongs to a different local origin.' :
        'Pairing failed or expired.';
      setStatus(`${detail} Restart the server to pair again.`, true);
    } finally {
      pairingPending = false;
      updateControls();
    }
  }

  async function signOut() {
    if (signingOut) return;
    const token = sessionToken;
    leaveSession();
    const marker = viewGeneration;
    signingOut = true;
    updateControls();
    setStatus('Signing out. Existing approvals persist. Restart the server to pair again.');
    try {
      if (token !== null) await request('/api/session/logout', token, 'POST', {});
    } catch {
      // Browser authority is cleared locally even when the logout response is lost.
    } finally {
      signingOut = false;
      updateControls();
      if (marker === viewGeneration && sessionToken === null) {
        setStatus('Signed out. Existing approvals persist. Restart the server to pair again.');
      }
    }
  }

  pairButton.addEventListener('click', pairBrowser);
  refreshButton.addEventListener('click', loadActions);
  signOutButton.addEventListener('click', signOut);
  approveButton.addEventListener('click', () => decide('approve'));
  cancelButton.addEventListener('click', () => decide('cancel'));
  executeButton.addEventListener('click', () => runActionJob('execute'));
  readbackButton.addEventListener('click', () => runActionJob('readback'));
  serviceRefreshButton.addEventListener('click', loadService);
  refreshJobsButton.addEventListener('click', refreshJobs);
  sendChatButton.addEventListener('click', () => admitService('chat'));
  createReminderButton.addEventListener('click', () => admitService('reminder'));

  setStatus('Select the short-lived pairing file for this local server.');
  updateControls();
})();
