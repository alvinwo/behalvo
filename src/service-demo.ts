import { isDeepStrictEqual } from 'node:util';
import { chmodSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { SqliteStore } from './storage/sqlite-store.js';
import { startLocalService, type LocalService } from './service/local-service.js';
import { createCompiledSyntheticBrowserHarness,
  type CompiledSyntheticBrowserHarness } from './synthetic-portal/compiled-browser.js';
import { startSyntheticPortal } from './synthetic-portal/server.js';
import { SyntheticPortalState } from './synthetic-portal/state.js';

interface JsonResponse { status: number; body: Record<string, unknown> }

interface ServiceHandle {
  service: LocalService;
  token: string;
  harness: CompiledSyntheticBrowserHarness;
}

export interface ServiceDemoResult {
  synthetic: true;
  fixedPortalOrigin: 'http://127.0.0.1:43117';
  emptyPoll: { complete: boolean; candidateCount: number };
  overdueRestart: { coalescedJobs: number };
  handoff: { pauseReason: string; resumedFromFreshPage: boolean };
  race: { kind: 'pre_reservation_candidate_disappeared'; candidateId: string;
    reservations: number; providerMutations: number };
  booking: { candidateId: string; providerMutations: number; status: string;
    verification: string; readbackStatus: string };
  final: { grantStatus: string; monitorStatus: string; activeMonitorJobs: number };
  laterRestart: { additionalObservations: number; additionalGestures: number };
  rebuild: { matches: boolean; countersBefore: DemoCounters; countersAfter: DemoCounters };
  browser: { compiledManifestContent: boolean; compiledBackground: boolean;
    framedNativeTransport: boolean; serviceOwnedSession: boolean; sessions: number; nativeFrames: number };
}

interface DemoCounters { providerMutations: number; commands: number; nativeFrames: number }

export interface ServiceDemoOptions {
  rootDirectory?: string;
  quiet?: boolean;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid ${label}.`);
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length < 1) throw new Error(`Invalid ${label}.`);
  return value;
}

function number(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value)) throw new Error(`Invalid ${label}.`);
  return value as number;
}

async function request(origin: string, method: 'GET' | 'POST', path: string, token: string,
  body?: Record<string, unknown>): Promise<JsonResponse> {
  const response = await fetch(`${origin}${path}`, { method, redirect: 'manual', headers: {
    host: new URL(origin).host, ...(method === 'POST' ? { origin, 'content-type': 'application/json' } : {}),
    authorization: `Bearer ${token}`
  }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const responseText = await response.text();
  return { status: response.status, body: responseText ? record(JSON.parse(responseText), 'control response') : {} };
}

async function waitFor<T>(read: () => Promise<T>, accept: (value: T) => boolean, label: string): Promise<T> {
  let latest: T | undefined;
  for (let attempt = 0; attempt < 400; attempt++) {
    latest = await read();
    if (accept(latest)) return latest;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${label}: ${JSON.stringify(latest)}`);
}

function pageItems(response: JsonResponse): Record<string, unknown>[] {
  const items = response.body.items;
  if (!Array.isArray(items) || items.some(item => !item || typeof item !== 'object' || Array.isArray(item)))
    throw new Error('Invalid control list response.');
  return items as Record<string, unknown>[];
}

function prepareRoot(rootDirectory: string | undefined): { path: string; removeAfterRun: boolean } {
  if (rootDirectory === undefined) {
    const path = mkdtempSync(join(tmpdir(), 'behalvo-service-demo-'));
    try { chmodSync(path, 0o700); }
    catch (error) { rmSync(path, { recursive: true, force: true }); throw error; }
    return { path, removeAfterRun: true };
  }
  let status;
  try { status = lstatSync(rootDirectory); }
  catch { throw new Error('Service demo output directory must be an existing directory.'); }
  if (status.isSymbolicLink() || !status.isDirectory())
    throw new Error('Service demo output directory must be a nonsymlink directory.');
  if (typeof process.geteuid !== 'function' || status.uid !== process.geteuid())
    throw new Error('Service demo output directory must be owned by the current user.');
  if ((status.mode & 0o077) !== 0)
    throw new Error('Service demo output directory must have private owner-only permissions.');
  let entries: string[];
  try { entries = readdirSync(rootDirectory); }
  catch { throw new Error('Service demo output directory must be readable.'); }
  if (entries.length !== 0) throw new Error('Service demo output directory must be empty.');
  return { path: rootDirectory, removeAfterRun: false };
}

export async function runServiceDemo(options: ServiceDemoOptions = {}): Promise<ServiceDemoResult> {
  if (!options || typeof options !== 'object' || Array.isArray(options) ||
      (options.rootDirectory !== undefined && (typeof options.rootDirectory !== 'string' ||
        !isAbsolute(options.rootDirectory) || options.rootDirectory.length < 2)) ||
      (options.quiet !== undefined && typeof options.quiet !== 'boolean'))
    throw new Error('Service demo output directory must be absolute.');
  const preparedRoot = prepareRoot(options.rootDirectory); const root = preparedRoot.path;
  const dbPath = join(root, 'service.db'); const bootstrapDirectory = join(root, 'bootstrap');
  const workspaceId = 'service-demo-workspace'; const ownerId = 'service-demo-owner';
  const encryptionKey = new Uint8Array(32).fill(0x5d);
  let now = Date.now();
  const portalState = new SyntheticPortalState({ scenario: 'calendar_empty' });
  let portal: Awaited<ReturnType<typeof startSyntheticPortal>> | undefined;
  const harnesses: CompiledSyntheticBrowserHarness[] = [];
  const observedCandidateIds: string[] = [];
  let withdrawCandidate = false; let firstStart = true;

  const browserCounters = (): DemoCounters => ({ providerMutations: portalState.mutationCount,
    commands: harnesses.reduce((sum, harness) => sum + harness.metrics().commands.length, 0),
    nativeFrames: harnesses.reduce((sum, harness) => sum + harness.metrics().nativeFrames, 0) });
  const observations = (store: SqliteStore): number => store.journal(workspaceId)
    .filter(item => item.event.type === 'monitor.observation_recorded').length;

  const start = async (): Promise<ServiceHandle> => {
    let harness: CompiledSyntheticBrowserHarness | undefined;
    const service = await startLocalService({ dbPath, bootstrapDirectory, workspaceId, ownerId,
      upgradeStorage: firstStart, assets: { html: '', javascript: '', css: '' }, port: 0,
      encryptionKey, clock: () => now, syntheticMonitoring: {
        fixtureId: 'visa-beijing-group-v1',
        async createBrowserTransport() {
          if (!portal) throw new Error('Synthetic portal was not started.');
          harness = await createCompiledSyntheticBrowserHarness(portal, {
            async beforeDestination(kind, _count, commands) {
              if (kind === 'calendar.next_page') {
                const snapshot = portalState.inspect();
                if (snapshot.state === 'calendar' && snapshot.candidates[0])
                  observedCandidateIds.push(snapshot.candidates[0].id);
              }
              if (withdrawCandidate && kind === 'calendar.first_page' &&
                  commands.filter(item => item === 'calendar.first_page').length >= 2) {
                withdrawCandidate = false;
                portalState.withdrawCandidateBeforeReservation();
              }
            }
          });
          harnesses.push(harness);
          return { transport: harness.transport, tabId: harness.tabId };
        }
      } });
    firstStart = false;
    if (!harness) { await service.shutdown(); throw new Error('Synthetic browser harness was not created.'); }
    const bootstrap = record(JSON.parse(readFileSync(service.bootstrapPath, 'utf8')), 'bootstrap');
    const bootstrapToken = text(bootstrap.token, 'bootstrap token');
    const paired = await request(service.origin, 'POST', '/api/session/bootstrap', bootstrapToken, {});
    if (paired.status !== 200) throw new Error('Synthetic service pairing failed.');
    return { service, token: text(paired.body.token, 'paired token'), harness };
  };
  const stop = async (handle: ServiceHandle): Promise<void> => {
    if (!await handle.service.shutdown()) throw new Error('Synthetic service did not stop cleanly.');
    await handle.harness.finish();
  };

  let active: ServiceHandle | undefined;
  try {
    portal = await startSyntheticPortal({ state: portalState });
    active = await start();
    if ((await request(active.service.origin, 'POST', '/api/monitoring/synthetic/setup', active.token,
      { requestId: 'demo-setup', fixtureId: 'visa-beijing-group-v1' })).status !== 200)
      throw new Error('Synthetic setup failed.');
    const proposed = await request(active.service.origin, 'POST', '/api/grants', active.token,
      { requestId: 'demo-proposal', fixtureId: 'visa-beijing-group-v1' });
    const grant = record(proposed.body.grant, 'proposed grant'); const grantId = text(grant.id, 'grant id');
    const grantDigest = text(grant.digest, 'grant digest'); const grantRevision = number(grant.revision, 'grant revision');
    const review = await request(active.service.origin, 'POST', `/api/grants/${grantId}/review`, active.token, {});
    if (review.status !== 200 || review.body.canArm !== true) throw new Error('Synthetic grant review failed.');
    const armed = await request(active.service.origin, 'POST', `/api/grants/${grantId}/arm`, active.token,
      { requestId: 'demo-arm', digest: grantDigest, revision: grantRevision,
        armToken: text(review.body.armToken, 'arm token') });
    if (armed.status !== 200) throw new Error('Synthetic grant arm failed.');
    const monitor = record(armed.body.monitor, 'armed monitor'); const monitorId = text(monitor.id, 'monitor id');

    now += 3_000;
    const empty = await waitFor(async () => request(active!.service.origin, 'GET', `/api/monitors/${monitorId}`,
      active!.token), value => Boolean(value.body.lastObservation && typeof value.body.lastObservation === 'object' &&
        !Array.isArray(value.body.lastObservation) &&
        (value.body.lastObservation as Record<string, unknown>).complete === true),
    'complete empty observation');
    const emptyObservation = record(empty.body.lastObservation, 'empty observation');
    const emptyJobs = pageItems(await request(active.service.origin, 'GET', '/api/jobs', active.token))
      .filter(item => record(item.monitoring, 'monitoring job').purpose === 'observe').length;
    await stop(active); active = undefined;

    portalState.beginHumanChallenge(); now += 10_000;
    active = await start();
    const paused = await waitFor(async () => request(active!.service.origin, 'GET', `/api/monitors/${monitorId}`,
      active!.token), value => value.body.status === 'paused', 'durable human handoff');
    const restartJobs = pageItems(await request(active.service.origin, 'GET', '/api/jobs', active.token))
      .filter(item => record(item.monitoring, 'monitoring job').purpose === 'observe').length;
    if (restartJobs - emptyJobs !== 1) throw new Error('Overdue monitor restart was not coalesced.');

    portalState.completeHumanChallenge();
    await active.harness.refreshPageFromPortal();
    const resumed = await request(active.service.origin, 'POST', `/api/monitors/${monitorId}/resume`, active.token,
      { requestId: 'demo-resume', digest: grantDigest, revision: grantRevision,
        controlRevision: number(paused.body.controlRevision, 'monitor control revision'), recoverHandoff: false });
    if (resumed.status !== 202) throw new Error('Synthetic monitor resume was not queued.');
    await waitFor(async () => request(active!.service.origin, 'GET', `/api/monitors/${monitorId}`, active!.token),
      value => value.body.status === 'active', 'fresh-page resume');
    const resumeKinds = active.harness.metrics().contentRequests;
    const resumedFromFreshPage = resumeKinds.includes('recognize') && resumeKinds.includes('inspect');

    portalState.publishCandidateBeforeReservation(); withdrawCandidate = true; now += 3_000;
    const raced = await waitFor(async () => request(active!.service.origin, 'GET', `/api/monitors/${monitorId}`,
      active!.token), value => {
        const observation = value.body.lastObservation;
        if (!observation || typeof observation !== 'object' || Array.isArray(observation)) return false;
        const coverage = (observation as Record<string, unknown>).coverage;
        return Boolean(coverage && typeof coverage === 'object' && !Array.isArray(coverage) &&
          (coverage as Record<string, unknown>).preflight === 'candidate_disappeared_before_reservation');
      }, 'pre-reservation candidate disappearance');
    const raceCoverage = record(record(raced.body.lastObservation, 'race observation').coverage, 'race coverage');
    if (raceCoverage.preflight !== 'candidate_disappeared_before_reservation')
      throw new Error('Synthetic race was mislabeled.');
    const raceMonitorAction = (await request(active.service.origin, 'GET',
      `/api/monitors/${monitorId}`, active.token)).body.action;
    if (raceMonitorAction !== null || portalState.mutationCount !== 0)
      throw new Error('Pre-reservation race created an action or provider mutation.');
    const raceCandidateId = observedCandidateIds[0];
    if (!raceCandidateId) throw new Error('Synthetic race candidate was not observed.');

    portalState.publishLaterCandidate(); now += 3_000;
    const bookedResult = await waitFor(async () => request(active!.service.origin, 'GET',
      `/api/monitors/${monitorId}`, active!.token), value => {
      const action = value.body.action;
      return Boolean(action && typeof action === 'object' && !Array.isArray(action) &&
        (action as Record<string, unknown>).status === 'accepted' &&
        (action as Record<string, unknown>).readbackEligible === true &&
        portalState.authoritativeReadback().state === 'appointment');
    }, 'verified booking readback');
    const booked = record(bookedResult.body.action, 'booked monitor action');
    const bookingCandidateId = observedCandidateIds.find(id => id !== raceCandidateId);
    if (!bookingCandidateId || Number(portalState.mutationCount) !== 1)
      throw new Error('Synthetic booking evidence is incomplete.');
    const finalMonitorStatusHttp = text((await request(active.service.origin, 'GET',
      `/api/monitors/${monitorId}`, active.token)).body.status, 'final monitor status');
    const finalGrantStatusHttp = text((await request(active.service.origin, 'GET',
      `/api/grants/${grantId}`, active.token)).body.status, 'final grant status');
    const jobs = pageItems(await request(active.service.origin, 'GET', '/api/jobs', active.token));
    const activeMonitorJobs = jobs.filter(item => item.kind === 'monitor' &&
      (item.status === 'queued' || item.status === 'running')).length;
    await stop(active); active = undefined;

    const beforeLater = new SqliteStore(dbPath, { encryptionKey, serviceQueue: { upgradeExisting: false } });
    const observationsBeforeLater = observations(beforeLater); beforeLater.close();
    const countersBeforeLater = browserCounters(); now += 10_000;
    active = await start();
    await new Promise(resolve => setTimeout(resolve, 1_100));
    await stop(active); active = undefined;
    const afterLater = new SqliteStore(dbPath, { encryptionKey, serviceQueue: { upgradeExisting: false } });
    const additionalObservations = observations(afterLater) - observationsBeforeLater;
    const countersBefore = browserCounters(); const projected = afterLater.state(workspaceId);
    const rebuilt = afterLater.rebuild(workspaceId); const matches = isDeepStrictEqual(rebuilt, projected);
    const finalAction = Object.values(projected.actions).find(item => item.id === booked.id);
    const finalGrantState = projected.monitoredActionGrants[grantId];
    const finalMonitorState = projected.monitors[monitorId];
    const booking = portalState.authoritativeReadback();
    afterLater.close();
    const countersAfter = browserCounters();
    if (!finalAction || !finalGrantState || !finalMonitorState || booking.state !== 'appointment' ||
        finalGrantStatusHttp !== finalGrantState.status || finalMonitorStatusHttp !== finalMonitorState.status)
      throw new Error('Synthetic final state is incomplete.');

    const metrics = harnesses.map(harness => harness.metrics());
    return { synthetic: true, fixedPortalOrigin: 'http://127.0.0.1:43117',
      emptyPoll: { complete: emptyObservation.complete === true, candidateCount: 0 },
      overdueRestart: { coalescedJobs: restartJobs - emptyJobs },
      handoff: { pauseReason: text(paused.body.pauseReason, 'pause reason'), resumedFromFreshPage },
      race: { kind: 'pre_reservation_candidate_disappeared', candidateId: raceCandidateId,
        reservations: raceMonitorAction === null ? 0 : 1, providerMutations: 0 },
      booking: { candidateId: bookingCandidateId, providerMutations: portalState.mutationCount,
        status: finalAction.status, verification: finalAction.verification?.status ?? 'missing',
        readbackStatus: booking.booking.status },
      final: { grantStatus: finalGrantState.status, monitorStatus: finalMonitorState.status, activeMonitorJobs },
      laterRestart: { additionalObservations,
        additionalGestures: browserCounters().commands - countersBeforeLater.commands },
      rebuild: { matches, countersBefore, countersAfter },
      browser: { compiledManifestContent: metrics.every(item => item.compiledManifestContent),
        compiledBackground: metrics.every(item => item.compiledBackground),
        framedNativeTransport: metrics.every(item => item.framedNativeTransport), serviceOwnedSession: true,
        sessions: metrics.length, nativeFrames: metrics.reduce((sum, item) => sum + item.nativeFrames, 0) } };
  } finally {
    try {
      if (active) { try { await active.service.shutdown(); } finally { await active.harness.finish(); } }
    } finally {
      try { if (portal) await portal.close(); }
      finally { if (preparedRoot.removeAfterRun) rmSync(root, { recursive: true }); }
    }
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  runServiceDemo().then(result => { process.stdout.write(`${JSON.stringify(result, null, 2)}\n`); }, error => {
    process.stderr.write(`Synthetic service demo failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
