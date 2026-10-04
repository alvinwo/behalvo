import { isDeepStrictEqual } from 'node:util';
import { chmodSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SqliteStore } from '../storage/sqlite-store.js';
import { startLocalService, type LocalService } from '../service/local-service.js';
import { PlaywrightActionsOwner } from './playwright-actions-owner.js';
import type { BrowserSessionTransport } from './session.js';
import { bounded, failureCode, PlaywrightDiagnosticError, type PlaywrightFailureCode } from './playwright-errors.js';
import { startSyntheticPortal } from '../synthetic-portal/server.js';
import { SyntheticPortalState } from '../synthetic-portal/state.js';

interface JsonResponse { status: number; body: Record<string, unknown> }

interface ServiceHandle {
  service: LocalService;
  token: string;
  harness: ActionsHarness;
}

interface DemoCounters { providerMutations: number; commands: number }

interface ActionsHarness { transport: BrowserSessionTransport; tabId: 1; finish(): Promise<void>;
  metrics(): { commands: string[]; contentRequests: string[] } }
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
  body?: Record<string, unknown>, signal?: AbortSignal): Promise<JsonResponse> {
  const response = await fetch(`${origin}${path}`, { method, ...(signal ? { signal } : {}), redirect: 'manual', headers: {
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

export type PlaywrightActionsResult =
  | { ok: true; synthetic: true; cleanup: 'confirmed'; playwrightVersion: '1.63.0'; browserVersion: string;
      emptyPoll: true; cleanRestart: true; handoffResume: true; candidateRace: true; singleBooking: true;
      authoritativeReadback: true; replayNoEffects: true }
  | { ok: false; code: PlaywrightFailureCode; cleanup: 'confirmed' | 'pending'; receiptPaths: string[] };

/** Trusted composition seams for synthetic fault tests; never exposed as CLI options. */
export interface PlaywrightActionsDependencies {
  startService?: typeof startLocalService;
  startPortal?: typeof startSyntheticPortal;
  createOwner?: (input: ConstructorParameters<typeof PlaywrightActionsOwner>[0]) => Pick<PlaywrightActionsOwner, 'start' | 'close' | 'finishReceipt' | 'receiptPath'>;
  runTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  setupTimeoutMs?: number;
  removeRoot?: (path: string) => void;
}
export async function runPlaywrightActions(input: { signal: AbortSignal }, dependencies: PlaywrightActionsDependencies = {}): Promise<PlaywrightActionsResult> {
  const controller = new AbortController();
  const signal = AbortSignal.any([input.signal, controller.signal]);
  const setupTimeout = Math.min(15_000, Math.max(1, dependencies.setupTimeoutMs ?? 15_000));
  const runTimeout = Math.min(180_000, Math.max(1, dependencies.runTimeoutMs ?? 180_000));
  const deadline = Date.now() + runTimeout;
  const timer = setTimeout(() => controller.abort(), runTimeout);
  const root = mkdtempSync(join(tmpdir(), 'behalvo-playwright-actions-')); chmodSync(root, 0o700);
  let closing = false, pending = 0, confirmed = false, cleanupFailed = false, browserVersion = '';
  let code: PlaywrightFailureCode | undefined;
  const owners: Pick<PlaywrightActionsOwner, 'start' | 'close' | 'finishReceipt' | 'receiptPath'>[] = [], services: LocalService[] = [];
  const current = () => { if (closing || signal.aborted || Date.now() >= deadline) throw new PlaywrightDiagnosticError('cancelled'); };
  const rawRequest = request;
  const control = async (...args: Parameters<typeof request>) => {
    current(); const result = await bounded(rawRequest(args[0], args[1], args[2], args[3], args[4], signal), deadline - Date.now(), 'observation_timeout', signal);
    current(); return result;
  };
  const dbPath = join(root, 'service.db'); const bootstrapDirectory = join(root, 'bootstrap');
  const workspaceId = 'service-demo-workspace'; const ownerId = 'service-demo-owner';
  const encryptionKey = new Uint8Array(32).fill(0x5d);
  let now = Date.now();
  const portalState = new SyntheticPortalState({ scenario: 'calendar_empty' });
  let portal: Awaited<ReturnType<typeof startSyntheticPortal>> | undefined;
  const harnesses: ActionsHarness[] = [];
  const observedCandidateIds: string[] = [];
  let withdrawCandidate = false; let firstStart = true;

  const browserCounters = (): DemoCounters => ({ providerMutations: portalState.mutationCount,
    commands: harnesses.reduce((sum, harness) => sum + harness.metrics().commands.length, 0) });
  const observations = (store: SqliteStore): number => store.journal(workspaceId)
    .filter(item => item.event.type === 'monitor.observation_recorded').length;

  const start = async (): Promise<ServiceHandle> => {
    let harness: ActionsHarness | undefined;
    current(); pending++;
    const service = await bounded((dependencies.startService ?? startLocalService)({ dbPath, bootstrapDirectory, workspaceId, ownerId,
      upgradeStorage: firstStart, assets: { html: '', javascript: '', css: '' }, port: 0,
      encryptionKey, clock: () => now, syntheticMonitoring: {
        fixtureId: 'visa-beijing-group-v1',
        async createBrowserTransport(binding) {
          current();
          const owner = (dependencies.createOwner ?? (input => new PlaywrightActionsOwner(input)))({ ...binding.binding, serviceGeneration: binding.serviceGeneration,
            signal, runDeadline: deadline }); owners.push(owner);
          const ready = await owner.start(); current(); browserVersion = ready.browserVersion;
          const transport = ready.transport, commands: string[] = [], contentRequests: string[] = [];
          const wrapped: BrowserSessionTransport = {
            async inspect(request) { const result = await transport.inspect(request); contentRequests.push(request.kind);
              if (result.snapshot.state === 'calendar') for (const slot of result.snapshot.candidates) observedCandidateIds.push(slot.id);
              return result; },
            async gesture(request, authorize, authority) {
              if (request.kind !== 'gesture') throw new PlaywrightDiagnosticError('protocol_rejected');
              commands.push(request.command.kind);
              if (withdrawCandidate && request.command.kind === 'calendar.first_page' &&
                  commands.filter(kind => kind === 'calendar.first_page').length >= 2) {
                withdrawCandidate = false; portalState.withdrawCandidateBeforeReservation();
              }
              return transport.gesture(request, authorize, authority);
            },
            revoke: (epoch, tabId) => transport.revoke(epoch, tabId),
            reconcileRevocation: (epoch, tabId) => transport.reconcileRevocation(epoch, tabId),
            shutdown: (epoch, tabId) => transport.shutdown(epoch, tabId), close: () => transport.close()
          };
          harness = { transport: wrapped, tabId: 1,
            finish: async () => { if (!(await owner.close()).confirmed) throw new PlaywrightDiagnosticError('cleanup_pending'); },
            metrics: () => ({ commands, contentRequests }) };
          harnesses.push(harness); return { transport: wrapped, tabId: 1 };
        }
      } }).then(async value => {
        services.push(value);
        if (closing || signal.aborted) {
          try { if (!await value.shutdown()) { cleanupFailed = true; throw new PlaywrightDiagnosticError('cleanup_pending'); } }
          catch (error) { cleanupFailed = true; throw error; }
          finally { pending--; }
          throw new PlaywrightDiagnosticError('cancelled');
        }
        pending--; return value;
      }, error => { pending--; throw error; }), Math.min(setupTimeout, deadline - Date.now()), 'setup_timeout', signal);
    current(); firstStart = false;
    if (!harness) { await service.shutdown(); throw new Error('Synthetic browser harness was not created.'); }
    const bootstrap = record(JSON.parse(readFileSync(service.bootstrapPath, 'utf8')), 'bootstrap');
    const bootstrapToken = text(bootstrap.token, 'bootstrap token');
    const paired = await control(service.origin, 'POST', '/api/session/bootstrap', bootstrapToken, {});
    if (paired.status !== 200) throw new Error('Synthetic service pairing failed.');
    return { service, token: text(paired.body.token, 'paired token'), harness };
  };
  const stop = async (handle: ServiceHandle): Promise<void> => {
    if (!await handle.service.shutdown()) { cleanupFailed = true; throw new PlaywrightDiagnosticError('cleanup_pending'); }
    await handle.harness.finish();
  };

  let active: ServiceHandle | undefined;
  const scenario = async () => {

    current(); pending++;
    portal = await bounded((dependencies.startPortal ?? startSyntheticPortal)({ state: portalState, formResponse: 'document' }).then(async value => {
      portal = value;
      if (closing || signal.aborted) {
        try { await value.close(); }
        catch (error) { cleanupFailed = true; throw error; }
        finally { pending--; }
        throw new PlaywrightDiagnosticError('cancelled');
      }
      pending--; return value;
    }, error => { pending--; throw error; }), Math.min(setupTimeout, deadline - Date.now()), 'setup_timeout', signal);
    active = await start();
    if ((await control(active.service.origin, 'POST', '/api/monitoring/synthetic/setup', active.token,
      { requestId: 'demo-setup', fixtureId: 'visa-beijing-group-v1' })).status !== 200)
      throw new Error('Synthetic setup failed.');
    const proposed = await control(active.service.origin, 'POST', '/api/grants', active.token,
      { requestId: 'demo-proposal', fixtureId: 'visa-beijing-group-v1' });
    const grant = record(proposed.body.grant, 'proposed grant'); const grantId = text(grant.id, 'grant id');
    const grantDigest = text(grant.digest, 'grant digest'); const grantRevision = number(grant.revision, 'grant revision');
    const review = await control(active.service.origin, 'POST', `/api/grants/${grantId}/review`, active.token, {});
    if (review.status !== 200 || review.body.canArm !== true) throw new Error('Synthetic grant review failed.');
    const armed = await control(active.service.origin, 'POST', `/api/grants/${grantId}/arm`, active.token,
      { requestId: 'demo-arm', digest: grantDigest, revision: grantRevision,
        armToken: text(review.body.armToken, 'arm token') });
    if (armed.status !== 200) throw new Error('Synthetic grant arm failed.');
    const monitor = record(armed.body.monitor, 'armed monitor'); const monitorId = text(monitor.id, 'monitor id');

    now += 3_000;
    const empty = await waitFor(async () => control(active!.service.origin, 'GET', `/api/monitors/${monitorId}`,
      active!.token), value => Boolean(value.body.lastObservation && typeof value.body.lastObservation === 'object' &&
        !Array.isArray(value.body.lastObservation) &&
        (value.body.lastObservation as Record<string, unknown>).complete === true),
    'complete empty observation');
    const emptyObservation = record(empty.body.lastObservation, 'empty observation');
    const emptyJobs = pageItems(await control(active.service.origin, 'GET', '/api/jobs', active.token))
      .filter(item => record(item.monitoring, 'monitoring job').purpose === 'observe').length;
    await stop(active); active = undefined;

    portalState.beginHumanChallenge(); now += 10_000;
    active = await start();
    const paused = await waitFor(async () => control(active!.service.origin, 'GET', `/api/monitors/${monitorId}`,
      active!.token), value => value.body.status === 'paused', 'durable human handoff');
    const restartJobs = pageItems(await control(active.service.origin, 'GET', '/api/jobs', active.token))
      .filter(item => record(item.monitoring, 'monitoring job').purpose === 'observe').length;
    if (restartJobs - emptyJobs !== 1) throw new Error('Overdue monitor restart was not coalesced.');

    portalState.completeHumanChallenge();
    const resumed = await control(active.service.origin, 'POST', `/api/monitors/${monitorId}/resume`, active.token,
      { requestId: 'demo-resume', digest: grantDigest, revision: grantRevision,
        controlRevision: number(paused.body.controlRevision, 'monitor control revision'), recoverHandoff: false });
    if (resumed.status !== 202) throw new Error('Synthetic monitor resume was not queued.');
    await waitFor(async () => control(active!.service.origin, 'GET', `/api/monitors/${monitorId}`, active!.token),
      value => value.body.status === 'active', 'fresh-page resume');
    const resumeKinds = active.harness.metrics().contentRequests;
    const resumedFromFreshPage = resumeKinds.includes('recognize') && resumeKinds.includes('inspect');

    portalState.publishCandidateBeforeReservation(); withdrawCandidate = true; now += 3_000;
    const raced = await waitFor(async () => control(active!.service.origin, 'GET', `/api/monitors/${monitorId}`,
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
    const raceMonitorAction = (await control(active.service.origin, 'GET',
      `/api/monitors/${monitorId}`, active.token)).body.action;
    if (raceMonitorAction !== null || portalState.mutationCount !== 0)
      throw new Error('Pre-reservation race created an action or provider mutation.');
    const raceCandidateId = observedCandidateIds[0];
    if (!raceCandidateId) throw new Error('Synthetic race candidate was not observed.');

    portalState.publishLaterCandidate(); now += 3_000;
    let bookedResult = await waitFor(async () => control(active!.service.origin, 'GET',
      `/api/monitors/${monitorId}`, active!.token), value => {
      const action = value.body.action;
      return Boolean(action && typeof action === 'object' && !Array.isArray(action) &&
        ['accepted', 'unknown'].includes(String((action as Record<string, unknown>).status)) &&
        (action as Record<string, unknown>).readbackEligible === true);
    }, 'booking outcome');
    if (record(bookedResult.body.action, 'booking outcome').status === 'unknown') {
      const unknown = record(bookedResult.body.action, 'unknown action');
      if (Number(portalState.mutationCount) !== 1) throw new PlaywrightDiagnosticError('page_rejected');
      await stop(active); active = undefined;
      active = await start();
      const readback = await control(active.service.origin, 'POST',
        `/api/actions/${text(unknown.id, 'action id')}/readback`, active.token,
        { requestId: 'demo-unknown-readback', digest: text(unknown.digest, 'action digest') });
      if (readback.status !== 202) throw new PlaywrightDiagnosticError('page_rejected');
      bookedResult = await waitFor(async () => control(active!.service.origin, 'GET', `/api/monitors/${monitorId}`, active!.token),
        value => Boolean(value.body.action && typeof value.body.action === 'object' &&
          (value.body.action as Record<string, unknown>).status === 'accepted'), 'authoritative unknown readback');
    }
    const booked = record(bookedResult.body.action, 'booked monitor action');
    const bookingCandidateId = observedCandidateIds.find(id => id !== raceCandidateId);
    if (!bookingCandidateId || Number(portalState.mutationCount) !== 1)
      throw new Error('Synthetic booking evidence is incomplete.');
    const finalMonitorStatusHttp = text((await control(active.service.origin, 'GET',
      `/api/monitors/${monitorId}`, active.token)).body.status, 'final monitor status');
    const finalGrantStatusHttp = text((await control(active.service.origin, 'GET',
      `/api/grants/${grantId}`, active.token)).body.status, 'final grant status');
    const jobs = pageItems(await control(active.service.origin, 'GET', '/api/jobs', active.token));
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

    if (emptyObservation.complete !== true || !resumedFromFreshPage || finalAction.status !== 'accepted' ||
        finalAction.verification?.status !== 'satisfied' || booking.booking.status !== 'booked' ||
        finalGrantState.status !== 'consumed' || finalMonitorState.status !== 'stopped' || activeMonitorJobs !== 0 ||
        additionalObservations !== 0 || browserCounters().commands !== countersBeforeLater.commands ||
        !matches || !isDeepStrictEqual(countersBefore, countersAfter)) throw new PlaywrightDiagnosticError('page_rejected');
  };
  let completed = false;
  try { await bounded(scenario(), deadline - Date.now(), 'observation_timeout', signal); completed = true; }
  catch (error) { code = input.signal.aborted ? 'cancelled' : failureCode(error, 'page_rejected'); }
  finally {
    closing = true; controller.abort(); clearTimeout(timer);
    try {
      const results = await bounded(Promise.allSettled([
        ...services.map(service => service.shutdown().then(value => { if (!value) throw new Error('cleanup_pending'); })),
        ...owners.map(owner => owner.close().then(value => { if (!value.confirmed) throw new Error('cleanup_pending'); })),
        portal?.close() ?? Promise.resolve()
      ]), Math.min(5000, Math.max(1, dependencies.shutdownTimeoutMs ?? 5000)), 'cleanup_pending');
      confirmed = !cleanupFailed && pending === 0 && results.every(result => result.status === 'fulfilled');
    } catch { confirmed = false; }
    if (confirmed) {
      try { (dependencies.removeRoot ?? (path => rmSync(path, { recursive: true, force: true })))(root); }
      catch { confirmed = false; code = 'cleanup_pending'; }
    }
  }
  if (!confirmed) code = 'cleanup_pending';
  for (const owner of owners) {
    try { owner.finishReceipt(confirmed, code ?? null, completed && !code); }
    catch { confirmed = false; code = 'cleanup_pending'; }
  }
  if (completed && confirmed && !code) return { ok: true, synthetic: true, cleanup: 'confirmed',
    playwrightVersion: '1.63.0', browserVersion, emptyPoll: true, cleanRestart: true, handoffResume: true,
    candidateRace: true, singleBooking: true, authoritativeReadback: true, replayNoEffects: true };
  return { ok: false, code: code ?? 'page_rejected', cleanup: confirmed ? 'confirmed' : 'pending',
    receiptPaths: owners.map(owner => owner.receiptPath) };
}
