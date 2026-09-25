import { createHash, randomUUID } from 'node:crypto';
import { createSyntheticUsVisaChinaExecutionAdapter } from '../adapters/us-visa-china/adapter.js';
import { US_VISA_CHINA_ADAPTER_ID, US_VISA_CHINA_ADAPTER_VERSION } from '../adapters/us-visa-china/types.js';
import { BrowserEpochRegistry, BrowserSession } from '../browser/session.js';
import { BROWSER_PROTOCOL_VERSION, parseBrowserResponse, type BrowserRequest } from '../browser/types.js';
import { MonitoringRegistry } from '../monitoring/registry.js';
import { MonitoringService, MonitorResumeRejectedError } from '../monitoring/service.js';
import type { MonitoredActionGrant, MonitoredArmPlanV1, MonitorState } from '../monitoring/types.js';
import { assertArmPlanCurrent, monitoredActionGrantDigest, validateGrant } from '../monitoring/policy.js';
import type { SqliteStore } from '../storage/sqlite-store.js';
import type { ServiceJob, ServiceReceipt } from '../storage/service-jobs.js';
import type { DomainEvent } from '../kernel/types.js';
import type { SyntheticMonitoringOptions } from './config.js';
import { canonicalJson, jsonValue } from '../operations/validation.js';

export const SYNTHETIC_PORTAL_ORIGIN = 'http://127.0.0.1:43117' as const;
export const SYNTHETIC_MONITORING_IDS = Object.freeze({
  connectionId: 'synthetic-visa-connection', workId: 'synthetic-visa-work',
  threadId: 'synthetic-visa-thread', monitorId: 'synthetic-visa-monitor'
});
export const SYNTHETIC_MONITORING_EXPIRY = '2027-01-31T16:00:00.000Z';

function hash(value: string): string { return createHash('sha256').update(value).digest('hex'); }

export const SYNTHETIC_MONITORING_DIGESTS = Object.freeze({
  identityDigest: hash('synthetic-owner'), subjectDigest: hash('synthetic-account'),
  rosterDigest: hash('synthetic-group-roster'), termsDigest: hash('synthetic-terms')
});

export const SYNTHETIC_POLLING_PLAN = Object.freeze({ maxObservationAgeMs: 60_000 as const,
  intervalMs: 2_000 as const, jitterMs: 250 as const, requestBudget: 30 as const,
  requestWindowMs: 60_000 as const, backoffBaseMs: 2_000 as const, backoffMaxMs: 60_000 as const });

export interface SyntheticMonitoringComposition {
  service: MonitoringService;
  session: BrowserSession;
  binding: Readonly<{ profileId: string; installationGeneration: string }>;
  setup(requestId: string): { duplicate: boolean; receipt: ServiceReceipt };
  propose(requestId: string, grantId: string): { duplicate: boolean; receipt: ServiceReceipt; grant: MonitoredActionGrant };
  arm(requestId: string, grantId: string, digest: string, revision: number, beforeCommit?: () => void):
    { duplicate: boolean; receipt: ServiceReceipt; grant: MonitoredActionGrant; monitor: MonitorState };
}

export async function createSyntheticMonitoringComposition(input: {
  store: SqliteStore; workspaceId: string; ownerId: string; serviceGeneration: string;
  options: SyntheticMonitoringOptions; clock: () => string;
}): Promise<SyntheticMonitoringComposition> {
  const installation = input.store.monitorInstallation();
  if (!installation?.active) throw new Error('Synthetic monitoring installation is blocked.');
  const installationGeneration = installation.generation;
  const profileId = `synthetic-visa-profile-${installationGeneration}`;
  const browserBinding = Object.freeze({ allowedOrigin: SYNTHETIC_PORTAL_ORIGIN,
    connectionId: SYNTHETIC_MONITORING_IDS.connectionId, connectionGeneration: 1 as const, profileId,
    ...SYNTHETIC_MONITORING_DIGESTS, termsVersion: 'terms-1' as const });
  const created = await input.options.createBrowserTransport(Object.freeze({
    serviceGeneration: input.serviceGeneration, installationGeneration,
    binding: browserBinding
  }));
  if (!created || typeof created.transport?.inspect !== 'function' ||
      typeof created.transport?.gesture !== 'function' || typeof created.transport?.revoke !== 'function' ||
      typeof created.transport?.reconcileRevocation !== 'function' ||
      typeof created.transport?.close !== 'function' || !Number.isSafeInteger(created.tabId) || created.tabId < 1) {
    try { await created?.transport?.close?.(); } catch { /* retain fixed configuration failure */ }
    throw new Error('Invalid synthetic monitoring browser transport.');
  }
  const registry = new MonitoringRegistry();
  let session!: BrowserSession;
  let activeResumeJob: ServiceJob | undefined;
  let activeResumeFence: import('../operations/execution-context.js').TrustedExecutionFence | undefined;
  const service = new MonitoringService(input.store, registry, { workspaceId: input.workspaceId,
    ownerId: input.ownerId, installationGeneration, clock: input.clock,
    checkpointBinding() { return { ...session.epoch, tabId: created.tabId }; },
    async checkpointHandler(_monitorId, reason) { await session.transferToHuman(reason); },
    async resumeHandler(job, fence, trustedLifecycleCommit) {
      if (activeResumeJob) throw new Error('Monitor resume is already active.');
      activeResumeJob = job; activeResumeFence = fence;
      try {
        if (job.parameters.kind === 'monitor' && job.parameters.purpose === 'resume' &&
            job.parameters.recoverHandoff) await session.recoverHandoff();
        await session.resume((candidate, _sequence, preflight) => {
          if (!preflight.rosterDigest || !preflight.termsDigest)
            throw new MonitorResumeRejectedError('binding_changed');
          const observedAt = input.clock();
          const sanitized = { observedAt, identityDigest: preflight.identityDigest,
            subjectDigest: preflight.subjectDigest, rosterDigest: preflight.rosterDigest,
            termsDigest: preflight.termsDigest, termsVersion: preflight.termsVersion,
            appointmentAbsent: true as const, pageState: 'calendar' as const };
          const evidenceDigest = createHash('sha256').update(canonicalJson(jsonValue({
            ...sanitized, candidate
          }, 'resume evidence'))).digest('hex');
          trustedLifecycleCommit({ ...sanitized, evidenceDigest });
        });
      } finally { activeResumeJob = undefined; activeResumeFence = undefined; }
    } });
  const existingMonitor = input.store.state(input.workspaceId).monitors[SYNTHETIC_MONITORING_IDS.monitorId];
  const existingHandoff = existingMonitor?.control?.handoff;
  // Composition precedes startup job repair; a persisted candidate still requires exact retirement.
  const retirementTarget = existingMonitor?.control?.resume?.candidate ??
    (existingHandoff?.state !== 'confirmed' ? existingHandoff?.binding : undefined);
  session = new BrowserSession({ profileId, connectionGeneration: 1,
    serviceGeneration: input.serviceGeneration, allowedOrigin: SYNTHETIC_PORTAL_ORIGIN, tabId: created.tabId,
    identityDigest: SYNTHETIC_MONITORING_DIGESTS.identityDigest,
    subjectDigest: SYNTHETIC_MONITORING_DIGESTS.subjectDigest, termsVersion: 'terms-1',
    rosterDigest: SYNTHETIC_MONITORING_DIGESTS.rosterDigest,
    termsDigest: SYNTHETIC_MONITORING_DIGESTS.termsDigest,
    ...(existingMonitor?.status === 'paused'
      ? retirementTarget
        ? { initialState: 'faulted' as const, initialFaultEpoch: {
            profileId: retirementTarget.profileId,
            connectionGeneration: retirementTarget.connectionGeneration,
            epoch: retirementTarget.epoch,
            serviceGeneration: retirementTarget.serviceGeneration,
            allowedOrigin: retirementTarget.allowedOrigin
          } }
        : { initialState: 'human' as const }
      : {}),
    registry: new BrowserEpochRegistry(), transport: created.transport,
    persistence: {
      async pauseForHuman() {
        const monitor = input.store.state(input.workspaceId).monitors[SYNTHETIC_MONITORING_IDS.monitorId];
        if (!monitor || monitor.status !== 'paused')
          throw new Error('Durable monitor pause is required before browser handoff.');
      },
      async releaseWorker() { service.releaseMonitorWorker(SYNTHETIC_MONITORING_IDS.monitorId); },
      async recoverHandoff(target) {
        const monitor = input.store.state(input.workspaceId).monitors[SYNTHETIC_MONITORING_IDS.monitorId];
        const handoff = monitor?.control?.handoff;
        if (!monitor || monitor.status !== 'paused' || !handoff || handoff.state === 'confirmed' ||
            handoff.binding.profileId !== target.profileId || handoff.binding.epoch !== target.epoch)
          throw new Error('Durable browser handoff target is not current.');
        await created.transport.reconcileRevocation({ profileId: handoff.binding.profileId,
          connectionGeneration: handoff.binding.connectionGeneration, epoch: handoff.binding.epoch,
          serviceGeneration: handoff.binding.serviceGeneration, allowedOrigin: handoff.binding.allowedOrigin },
        handoff.binding.tabId);
        service.settleMonitorHandoff({ monitorId: monitor.id, handoffId: handoff.id, state: 'confirmed' });
      },
      async candidateRetirementFailed(target) {
        const job = activeResumeJob;
        if (!job?.claim || job.parameters.kind !== 'monitor' || job.parameters.purpose !== 'resume')
          throw new Error('Resume candidate retirement failure has no current durable job.');
        service.recordResumeRetirementFailure(job, { ...target, tabId: created.tabId });
      },
      async resumePreflight(epoch) {
        const job = activeResumeJob; const fence = activeResumeFence;
        if (!job?.claim || !fence || job.parameters.kind !== 'monitor' || job.parameters.purpose !== 'resume')
          throw new Error('Resume must use the owner-admitted monitor job.');
        await fence.assertCurrent();
        input.store.recordMonitorResumeStarted(input.workspaceId, job.claim, { ...epoch, tabId: created.tabId }, input.clock());
        const request = (kind: 'recognize' | 'inspect', sequence: number): BrowserRequest => {
          const base = { protocolVersion: BROWSER_PROTOCOL_VERSION, requestId: randomUUID(), profileId: epoch.profileId,
          connectionGeneration: epoch.connectionGeneration, epoch: epoch.epoch,
            serviceGeneration: epoch.serviceGeneration, origin: epoch.allowedOrigin, tabId: created.tabId, sequence };
          return kind === 'inspect' ? { ...base, kind, expectedPageState: 'calendar' } : { ...base, kind };
        };
        const firstRequest = request('recognize', 1);
        await fence.assertCurrent();
        const first = parseBrowserResponse(await created.transport.inspect(firstRequest));
        await fence.assertCurrent();
        const secondRequest = request('inspect', 2);
        const second = parseBrowserResponse(await created.transport.inspect(secondRequest));
        await fence.assertCurrent();
        for (const [sent, received] of [[firstRequest, first], [secondRequest, second]] as const) {
          if (received.requestId !== sent.requestId || received.profileId !== sent.profileId ||
              received.connectionGeneration !== sent.connectionGeneration || received.epoch !== sent.epoch ||
              received.serviceGeneration !== sent.serviceGeneration || received.origin !== sent.origin ||
              received.tabId !== sent.tabId || received.sequence !== sent.sequence)
            throw new Error('Browser response binding or replay is invalid.');
        }
        if (first.snapshot.state === 'appointment' || second.snapshot.state === 'appointment')
          throw new MonitorResumeRejectedError('existing_appointment');
        if (first.snapshot.state !== 'calendar' || second.snapshot.state !== 'calendar')
          throw new Error('Browser resume preflight did not reach the calendar.');
        if (first.snapshot.appointmentAbsent !== true || second.snapshot.appointmentAbsent !== true)
          throw new MonitorResumeRejectedError('existing_appointment');
        if (first.snapshot.identityDigest !== second.snapshot.identityDigest ||
            first.snapshot.subjectDigest !== second.snapshot.subjectDigest ||
            first.snapshot.rosterDigest !== second.snapshot.rosterDigest ||
            first.snapshot.termsDigest !== second.snapshot.termsDigest ||
            first.snapshot.termsVersion !== second.snapshot.termsVersion ||
            second.snapshot.identityDigest !== browserBinding.identityDigest ||
            second.snapshot.subjectDigest !== browserBinding.subjectDigest ||
            second.snapshot.rosterDigest !== browserBinding.rosterDigest ||
            second.snapshot.termsDigest !== browserBinding.termsDigest ||
            second.snapshot.termsVersion !== browserBinding.termsVersion)
          throw new MonitorResumeRejectedError('binding_changed');
        return { profileId: epoch.profileId, connectionGeneration: epoch.connectionGeneration,
          identityDigest: second.snapshot.identityDigest, subjectDigest: second.snapshot.subjectDigest,
          rosterDigest: second.snapshot.rosterDigest, termsDigest: second.snapshot.termsDigest,
          termsVersion: second.snapshot.termsVersion, appointmentAbsent: true, sequence: 2 };
      }
    }
  });
  registry.register(createSyntheticUsVisaChinaExecutionAdapter({ session }));

  function setup(requestId: string): { duplicate: boolean; receipt: ServiceReceipt } {
    const state = input.store.state(input.workspaceId);
    const identity = { workspaceId: input.workspaceId, source: 'owner:service', requestId };
    const envelope = { kind: 'monitoring_setup' as const, fixtureId: 'visa-beijing-group-v1' as const };
    const existing = input.store.findServiceReceipt(identity, envelope);
    if (existing) return { duplicate: true, receipt: existing };
    const events: DomainEvent[] = [];
    const connection = state.connections[SYNTHETIC_MONITORING_IDS.connectionId];
    if (!connection) events.push({ type: 'connection.registered' as const, data: { connection: {
      id: SYNTHETIC_MONITORING_IDS.connectionId, provider: 'visa-scheduling',
      subject: 'synthetic-account', label: 'Synthetic visa scheduling account', generation: 1, status: 'active' as const
    } } });
    else if (connection.provider !== 'visa-scheduling' || connection.subject !== 'synthetic-account' ||
        connection.generation !== 1 || connection.status !== 'active')
      throw new Error('Synthetic monitoring fixture binding conflicts with current state.');
    if (!state.works[SYNTHETIC_MONITORING_IDS.workId]) events.push({ type: 'work.created' as const, data: {
      id: SYNTHETIC_MONITORING_IDS.workId, threadId: SYNTHETIC_MONITORING_IDS.threadId,
      title: 'Synthetic Beijing group appointment', goal: 'Book one eligible synthetic group appointment.'
    } });
    const committed = input.store.commitMonitoringRequest({ ...identity, ownerId: input.ownerId, envelope,
      expectedVersion: state.version, events, monitoring: { fixtureId: 'visa-beijing-group-v1',
        connectionId: SYNTHETIC_MONITORING_IDS.connectionId, workId: SYNTHETIC_MONITORING_IDS.workId,
        recordIds: [] }, at: input.clock() });
    return { duplicate: committed.duplicate, receipt: committed.receipt };
  }

  function armPlan(): MonitoredArmPlanV1 {
    const work = input.store.state(input.workspaceId).works[SYNTHETIC_MONITORING_IDS.workId];
    if (!work) throw new Error('Synthetic monitoring fixture is not set up.');
    return { version: 1, fixtureId: 'visa-beijing-group-v1', monitorId: SYNTHETIC_MONITORING_IDS.monitorId,
      workId: work.id, workRevision: work.revision, termsVersion: 'terms-1', polling: { ...SYNTHETIC_POLLING_PLAN },
      stopPolicy: 'synthetic-visa-one-effect-v1' };
  }

  function propose(requestId: string, grantId: string):
      { duplicate: boolean; receipt: ServiceReceipt; grant: MonitoredActionGrant } {
    const state = input.store.state(input.workspaceId);
    if (!state.connections[SYNTHETIC_MONITORING_IDS.connectionId] || !state.works[SYNTHETIC_MONITORING_IDS.workId])
      throw new Error('Synthetic monitoring fixture is not set up.');
    const identity = { workspaceId: input.workspaceId, source: 'owner:service', requestId };
    const envelope = { kind: 'monitoring_propose' as const, fixtureId: 'visa-beijing-group-v1' as const };
    const existingReceipt = input.store.findServiceReceipt(identity, envelope);
    if (existingReceipt) {
      const existing = input.store.state(input.workspaceId).monitoredActionGrants[grantId];
      if (!existing) throw new Error('Synthetic monitoring proposal receipt is inconsistent.');
      return { duplicate: true, receipt: existingReceipt, grant: structuredClone(existing) };
    }
    const overlapping = Object.values(state.monitoredActionGrants).find(item =>
      item.connectionId === SYNTHETIC_MONITORING_IDS.connectionId && item.browserProfileId === profileId &&
      item.armPlan?.fixtureId === 'visa-beijing-group-v1' &&
      !((item.status === 'revoked' || item.status === 'expired') && item.reservedActionId === undefined &&
        item.settlement === undefined));
    if (overlapping) throw new Error('An existing synthetic monitored authority must be terminal before replacement.');
    const now = input.clock(); const plan = armPlan();
    const base = { id: grantId, workspaceId: input.workspaceId, ownerId: input.ownerId,
      adapter: US_VISA_CHINA_ADAPTER_ID, adapterVersion: US_VISA_CHINA_ADAPTER_VERSION,
      connectionId: SYNTHETIC_MONITORING_IDS.connectionId, connectionGeneration: 1, browserProfileId: profileId,
      subjectDigest: SYNTHETIC_MONITORING_DIGESTS.subjectDigest,
      scope: { bookingType: 'new_group_appointment', location: 'Beijing', timeZone: 'Asia/Shanghai',
        startDate: '2026-12-15', endDate: '2027-01-31', eligibleTimes: 'any_offered_working_time',
        selection: 'earliest', maximumEffects: 1, provider: 'visa-scheduling',
        providerSubject: 'synthetic-account', resourceId: 'group-appointment',
        identityDigest: SYNTHETIC_MONITORING_DIGESTS.identityDigest,
        rosterDigest: SYNTHETIC_MONITORING_DIGESTS.rosterDigest,
        termsDigest: SYNTHETIC_MONITORING_DIGESTS.termsDigest },
      maximumEffects: 1 as const, expiresAt: SYNTHETIC_MONITORING_EXPIRY, armPlan: plan,
      createdAt: now, revision: 1 };
    const grant: MonitoredActionGrant = { ...base, digest: monitoredActionGrantDigest(base), status: 'pending' };
    validateGrant(grant);
    const committed = input.store.commitMonitoringRequest({ ...identity, ownerId: input.ownerId, envelope,
      expectedVersion: state.version, events: [{ type: 'monitored_action.grant_proposed', data: { grant } }],
      monitoring: { fixtureId: 'visa-beijing-group-v1', grantId, monitorId: plan.monitorId,
        workId: plan.workId, recordIds: [] }, at: now });
    return { duplicate: committed.duplicate, receipt: committed.receipt,
      grant: structuredClone(input.store.state(input.workspaceId).monitoredActionGrants[grantId]!) };
  }

  function arm(requestId: string, grantId: string, digest: string, revision: number, beforeCommit?: () => void):
      { duplicate: boolean; receipt: ServiceReceipt; grant: MonitoredActionGrant; monitor: MonitorState } {
    const identity = { workspaceId: input.workspaceId, source: 'owner:service', requestId };
    const envelope = { kind: 'monitoring_arm' as const, grantId, digest, revision };
    const existing = input.store.findServiceReceipt(identity, envelope);
    if (existing) {
      const state = input.store.state(input.workspaceId); const grant = state.monitoredActionGrants[grantId];
      const monitor = grant?.armPlan ? state.monitors[grant.armPlan.monitorId] : undefined;
      if (!grant || !monitor) throw new Error('Synthetic monitoring arm receipt is inconsistent.');
      return { duplicate: true, receipt: existing, grant: structuredClone(grant), monitor: structuredClone(monitor) };
    }
    const state = input.store.state(input.workspaceId); const pending = state.monitoredActionGrants[grantId];
    if (!pending || pending.digest !== digest || pending.revision !== revision || pending.status !== 'pending')
      throw new Error('Synthetic monitoring grant is not armable.');
    if (!pending.armPlan) throw new Error('Synthetic monitoring arm plan is missing.');
    assertArmPlanCurrent(state, pending);
    const installationNow = input.store.monitorInstallation();
    if (!installationNow?.active || installationNow.generation !== installationGeneration)
      throw new Error('Synthetic monitoring installation is blocked.');
    const activatedAt = input.clock();
    const monitor: MonitorState = { id: pending.armPlan.monitorId, workspaceId: input.workspaceId,
      grantId, workId: pending.armPlan.workId, adapter: pending.adapter, adapterVersion: pending.adapterVersion,
      connectionId: pending.connectionId, connectionGeneration: pending.connectionGeneration,
      browserProfileId: pending.browserProfileId, subjectDigest: pending.subjectDigest,
      ...pending.armPlan.polling, status: 'active',
      nextDueAt: new Date(Date.parse(activatedAt) + pending.armPlan.polling.intervalMs).toISOString(),
      requestWindowStartedAt: activatedAt, requestsInWindow: 0, lastObservation: null,
      lastCompleteObservationAt: null, lastCompleteCoverage: null, consecutiveFailures: 0, backoffMs: 0,
      pauseReason: null, inFlightJobId: null, control: { version: 1, revision: 0, handoff: null, resume: null } };
    const events: DomainEvent[] = [
      { type: 'monitored_action.grant_activated', data: { id: grantId, digest, revision,
        ownerId: input.ownerId, installationGeneration: installationNow.generation, activatedAt } },
      { type: 'monitor.configured', data: { monitor } }
    ];
    const committed = input.store.commitMonitoringRequest({ ...identity, ownerId: input.ownerId, envelope,
      expectedVersion: state.version, events, monitoring: { grantId, monitorId: monitor.id,
        recordIds: [] }, at: activatedAt }, () => {
      const current = input.store.state(input.workspaceId);
      const currentGrant = current.monitoredActionGrants[grantId];
      if (!currentGrant || currentGrant.digest !== digest || currentGrant.revision !== revision ||
          currentGrant.status !== 'pending') throw new Error('Synthetic monitoring grant changed before arm commit.');
      assertArmPlanCurrent(current, currentGrant);
      beforeCommit?.();
    });
    const current = input.store.state(input.workspaceId);
    return { duplicate: committed.duplicate, receipt: committed.receipt,
      grant: structuredClone(current.monitoredActionGrants[grantId]!),
      monitor: structuredClone(current.monitors[monitor.id]!) };
  }

  return { service, session, binding: Object.freeze({ profileId, installationGeneration }),
    setup, propose, arm };
}
