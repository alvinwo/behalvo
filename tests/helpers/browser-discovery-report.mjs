import { isDeepStrictEqual } from 'node:util';
import { parseBrowserSnapshot } from '../../dist/browser/types.js';
const fail = () => { throw new Error('Invalid synthetic browser discovery report.'); };
const additions = { group_roster: ['identity_digest', 'subject_digest', 'roster_digest', 'terms_version'],
  booking_review: ['review_contract'], confirmation: ['booking_contract'], ambiguous_submission: ['intent_field'],
  appointment: ['booking_contract', 'appointment_complete'] };
export const DISCOVERY_CASES = Object.freeze(['login', 'security_question', 'group_roster', 'booking_review', 'challenge',
  'session_expired', 'forbidden', 'rate_limited', 'terms_changed', 'unknown', 'confirmation', 'ambiguous_submission', 'appointment']
  .map(caseId => Object.freeze({ caseId, pageState: caseId, checks: Object.freeze(['page_state', ...(additions[caseId] ?? [])]) })));
const gaps = ['calendar_pagination', 'live_identity', 'complete_roster', 'terms_permission', 'live_origin_graph',
  'polling_plan', 'authenticated_profile_custody', 'live_state_reachability'];
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const hash = /^[a-f0-9]{64}$/, commit = /^[a-f0-9]{40}$/;
const matches = (pattern, value) => typeof value === 'string' && pattern.test(value);
const version = /^\d{1,4}(?:\.\d{1,6}){1,3}$/;
/** Reject accessors/non-JSON objects before inspection or serialization; never invoke toJSON. */
function safe(value, limit = 65536) {
  let nodes = 0;
  const walk = (item, depth) => {
    if (++nodes > 10000 || depth > 24) fail();
    if (item === null || typeof item === 'boolean') return;
    if (typeof item === 'number') { if (!Number.isFinite(item)) fail(); return; }
    if (typeof item === 'string') { if (Buffer.byteLength(item) > limit) fail(); return; }
    if (typeof item !== 'object' || (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype)) fail();
    if (Array.isArray(item) && (item.length > 1000 || Object.getPrototypeOf(item) !== Array.prototype)) fail();
    for (const key of Reflect.ownKeys(item)) {
      if (typeof key !== 'string' || key === 'toJSON' || key === '__proto__') fail();
      const descriptor = Object.getOwnPropertyDescriptor(item, key);
      if (!Object.hasOwn(descriptor, 'value') || (key !== 'length' && !descriptor.enumerable)) fail();
      if (key !== 'length') walk(descriptor.value, depth + 1);
    }
  };
  walk(value, 0);
  if (Buffer.byteLength(JSON.stringify(value)) + 1 > limit) fail();
}
function exact(value, keys) {
  if (!value || Array.isArray(value) || typeof value !== 'object' ||
    Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) fail();
}
const checksFor = (entry, status) => Object.fromEntries(entry.checks.map(key => [key, status]));
/** Map only validated contract presence, never original values or workflow/live assertions. */
export function mapDiscoverySnapshot(caseId, rawSnapshot) {
  try {
    const entry = DISCOVERY_CASES.find(item => item.caseId === caseId); if (!entry) fail();
    safe(rawSnapshot, 32768);
    const snapshot = parseBrowserSnapshot(rawSnapshot);
    if (snapshot.state !== entry.pageState || (snapshot.state === 'appointment' && snapshot.complete !== true)) fail();
    return checksFor(entry, 'observed');
  } catch { return fail(); }
}
export function missingDiscoveryCase(caseId, outcome = 'missing', code = 'missing_case') {
  const entry = DISCOVERY_CASES.find(item => item.caseId === caseId); if (!entry) fail();
  return { caseId, pageState: entry.pageState, provenance: 'fixture_seeded', outcome, code,
    checks: checksFor(entry, outcome === 'rejected' ? 'rejected' : 'unobserved'), cleanup: 'confirmed', gestureCount: 0, postCount: 0 };
}
function validateProvenance(value) {
  if (value?.kind === 'clean_commit') { exact(value, ['kind', 'commit']); if (!matches(commit, value.commit)) fail(); }
  else {
    exact(value, ['kind', 'baseCommit', 'beforeFingerprint', 'afterFingerprint', 'changedDuringRun']);
    if (value.kind !== 'dirty_tree' || !matches(commit, value.baseCommit) || !matches(hash, value.beforeFingerprint) ||
        !matches(hash, value.afterFingerprint) || typeof value.changedDuringRun !== 'boolean' ||
        (value.beforeFingerprint !== value.afterFingerprint && !value.changedDuringRun)) fail();
  }
}
/** Input rows are fixed sanitized evidence, not a signed attestation or domain authority. */
export function buildDiscoveryReport(input) {
  try {
    safe(input); exact(input, ['workspaceId', 'runId', 'versions', 'provenance', 'cases']);
    if (input.workspaceId !== 'synthetic-browser-discovery' || !matches(uuid, input.runId)) fail();
    exact(input.versions, ['adapterId', 'adapterVersion', 'playwright', 'node', 'browser']);
    const v = input.versions;
    if (v.adapterId !== 'us-visa-china' || v.adapterVersion !== 1 || v.playwright !== '1.63.0' ||
        !matches(version, v.node) || (v.browser !== null && !matches(version, v.browser))) fail();
    validateProvenance(input.provenance);
    if (!Array.isArray(input.cases) || input.cases.length > 13) fail();
    const seen = new Map();
    for (const row of input.cases) {
      exact(row, ['caseId', 'pageState', 'provenance', 'outcome', 'code', 'checks', 'cleanup', 'gestureCount', 'postCount']);
      const entry = DISCOVERY_CASES.find(item => item.caseId === row.caseId);
      if (!entry || seen.has(row.caseId) || row.pageState !== entry.pageState || row.provenance !== 'fixture_seeded' ||
          !['confirmed', 'pending'].includes(row.cleanup)) fail();
      const codes = { observed: ['none'], rejected: ['observation_failed', 'assertion_failed', 'cleanup_pending', 'unexpected_request'],
        skipped: ['not_enabled', 'filtered'], missing: ['missing_case'] };
      if (!Object.hasOwn(codes, row.outcome) || !codes[row.outcome].includes(row.code)) fail();
      const status = row.outcome === 'observed' ? 'observed' : row.outcome === 'rejected' ? 'rejected' : 'unobserved';
      if (!isDeepStrictEqual(row.checks, checksFor(entry, status))) fail();
      for (const count of [row.gestureCount, row.postCount])
        if (!(Number.isSafeInteger(count) && count >= 0) && !(count === null && row.outcome === 'rejected')) fail();
      if (row.outcome !== 'rejected' && (row.cleanup !== 'confirmed' || row.gestureCount !== 0 || row.postCount !== 0)) fail();
      seen.set(row.caseId, structuredClone(row));
    }
    const cases = DISCOVERY_CASES.map(item => seen.get(item.caseId) ?? missingDiscoveryCase(item.caseId));
    const counts = { expected: 13, executed: cases.filter(row => ['observed', 'rejected'].includes(row.outcome)).length,
      skipped: cases.filter(row => row.outcome === 'skipped').length, missing: cases.filter(row => row.outcome === 'missing').length,
      rejected: cases.filter(row => row.outcome === 'rejected').length };
    const cleanup = cases.some(row => row.cleanup === 'pending') ? 'pending' : 'confirmed';
    const result = counts.rejected || cleanup === 'pending' || input.provenance.changedDuringRun ? 'failed'
      : counts.skipped || counts.missing || v.browser === null ? 'incomplete' : 'passed';
    return { format: 'synthetic-browser-discovery-v1', source: 'synthetic_owned_playwright', origin: 'http://127.0.0.1:43117',
      liveRegistration: 'disabled', workspaceId: input.workspaceId, runId: input.runId, versions: structuredClone(v),
      provenance: structuredClone(input.provenance), cases, gaps: Object.fromEntries(gaps.map(key => [key, 'unobserved'])), counts, cleanup, result };
  } catch { return fail(); }
}
export function serializeDiscoveryReport(report) {
  try {
    safe(report);
    exact(report, ['format', 'source', 'origin', 'liveRegistration', 'workspaceId', 'runId', 'versions', 'provenance', 'cases', 'gaps', 'counts', 'cleanup', 'result']);
    const expected = buildDiscoveryReport({ workspaceId: report.workspaceId, runId: report.runId, versions: report.versions,
      provenance: report.provenance, cases: report.cases });
    if (!isDeepStrictEqual(expected, report)) fail();
    const bytes = Buffer.from(`${JSON.stringify(expected, null, 2)}\n`);
    if (bytes.length > 65536) fail(); return bytes;
  } catch { return fail(); }
}
