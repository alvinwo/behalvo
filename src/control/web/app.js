(() => {
  'use strict';

  const MAXIMUM_BOOTSTRAP_BYTES = 4096;
  const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
  const ISO_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

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
    clearReview();
    clearActions();
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

    activeReview = value;
    reviewNode.textContent = '';
    const rows = [
      ['Action ID', value.action.actionId],
      ['Work ID', value.action.workId],
      ['Work title', value.action.workTitle],
      ['Original work revision', String(value.action.workRevision)],
      ['Current work revision', String(value.action.currentWorkRevision)],
      ['Phase', String(value.action.phase)],
      ['Action status', String(value.action.status)],
      ['Synthetic operation', String(value.action.synthetic)],
      ['Action approval expiry', value.action.approvalExpiresAt ?? 'None'],
      ['Displayed approval expiry', value.approvalExpiresAt ?? 'None'],
      ['Review expiry', value.reviewExpiresAt],
      ['Can approve', String(value.canApprove)],
      ['Can cancel', String(value.canCancel)],
      ['Digest', value.action.digest],
      ['Current connection', JSON.stringify(value.connection, null, 2)],
      ['Complete command', JSON.stringify(value.command, null, 2)]
    ];
    const list = document.createElement('dl');
    for (const [name, fieldValue] of rows) appendReviewRow(list, name, fieldValue);
    reviewNode.append(list);
    reviewPanel.hidden = false;

    reviewExpiryTimer = setTimeout(() => {
      if (activeReview === value) {
        clearReview();
        setStatus('The review expired. Obtain a new review before deciding.', true);
      }
    }, reviewDeadline - Date.now());
    updateControls();
    return true;
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

  setStatus('Select the short-lived pairing file for this local server.');
  updateControls();
})();
