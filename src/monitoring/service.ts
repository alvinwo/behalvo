import { createHash, randomUUID } from 'node:crypto';
import type { Action, DomainEvent, State } from '../kernel/types.js';
import { identifier, required } from '../kernel/types.js';
import { assertOwner } from '../kernel/policy.js';
import { assertExecutionActive, OperationStoppedError, withinExecution, type TrustedExecutionFence } from '../operations/execution-context.js';
import type { Connection, OperationCommand } from '../operations/types.js';
import { canonicalJson, exactObject, jsonValue } from '../operations/validation.js';
import { isFatalServiceStorageError } from '../storage/service-jobs.js';
import type { ServiceEnvelope, ServiceJob, ServiceReceipt } from '../storage/service-jobs.js';
import type { SqliteStore } from '../storage/sqlite-store.js';
import { monitoredReservationEvents } from './invariants.js';
import {
  assertArmPlanCurrent, assertArmPlanReservationLifecycle, assertArmPlanReservationReady,
  bindingMatches, boundedMonitorJitter, canonicalInstant,
  evaluateMonitoredAction, exactMonitoringObject, monitoredActionCommandDigest,
  monitoredActionGrantDigest, observationDigest, validateBinding, validateDigest, validateGrant,
  validateObservation
} from './policy.js';
import { MonitoringRegistry } from './registry.js';
import type {
  MonitorPauseReason, MonitorState, MonitoredActionBinding, MonitoredActionGrant, MonitoredArmPlanV1,
  MonitoredGrantSettlementOutcome, Observation
} from './types.js';

export interface MonitoringServiceOptions {
  workspaceId: string;
  ownerId: string;
  installationGeneration: string;
  clock?: () => string;
  random?: () => number;
  resumeHandler?: (job: ServiceJob, fence: TrustedExecutionFence,
    trustedLifecycleCommit: (evidence: import('./types.js').MonitorResumeEvidence) => void) => Promise<void>;
  checkpointBinding?: () => import('../browser/types.js').BrowserEpoch & { tabId: number };
  checkpointHandler?: (monitorId: string, reason: string, handoffId: string) => Promise<void>;
}

export class MonitorResumeRejectedError extends Error {
  constructor(readonly reason: 'binding_changed' | 'existing_appointment') {
    super(`Monitor resume rejected: ${reason}`);
    this.name = 'MonitorResumeRejectedError';
  }
}

export interface ProposeGrantInput {
  id: string;
  workspaceId: string;
  ownerId: string;
  adapter: string;
  adapterVersion: number;
  connectionId: string;
  connectionGeneration: number;
  browserProfileId: string;
  subjectDigest: string;
  scope: unknown;
  maximumEffects: number;
  expiresAt: string;
  armPlan?: MonitoredArmPlanV1;
}

class MonitoredAuthorityChangedError extends Error {
  constructor() { super('Monitored action authority changed.'); }
}

export interface ConfigureMonitorInput {
  ownerId: string;
  id: string;
  grantId: string;
  workId: string;
  nextDueAt: string;
  maxObservationAgeMs: number;
  intervalMs: number;
  jitterMs: number;
  requestBudget: number;
  requestWindowMs: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
  control?: MonitorState['control'];
}

export interface ReserveMonitoredActionInput {
  grantId: string;
  workId: string;
  observation: Observation;
  maxObservationAgeMs: number;
  binding: MonitoredActionBinding;
  actionId?: string;
  attemptId?: string;
  monitorId?: string;
  beforeCommit?: () => void;
}

export interface AdmitDueMonitorResult {
  queued: number;
  budgetDeferred: number;
  unchanged: number;
  full: boolean;
}

export class MonitoringService {
  readonly #clock: () => string;
  readonly #random: () => number;
  readonly #grantJobControllers = new Map<string, Set<AbortController>>();
  readonly #monitorJobControllers = new Map<string, Set<AbortController>>();

  constructor(
    private readonly store: SqliteStore,
    readonly registry: MonitoringRegistry,
    private readonly options: MonitoringServiceOptions
  ) {
    exactMonitoringObject(options, ['workspaceId', 'ownerId', 'installationGeneration'],
      ['clock', 'random', 'resumeHandler', 'checkpointBinding', 'checkpointHandler'],
      'monitoring service options');
    identifier(options.workspaceId, 'workspaceId'); identifier(options.ownerId, 'ownerId');
    identifier(options.installationGeneration, 'installationGeneration');
    if (options.clock !== undefined && typeof options.clock !== 'function') throw new Error('Invalid monitoring clock');
    if (options.random !== undefined && typeof options.random !== 'function') throw new Error('Invalid monitoring random source');
    if (options.resumeHandler !== undefined && typeof options.resumeHandler !== 'function')
      throw new Error('Invalid monitoring resume handler');
    if ((options.checkpointBinding === undefined) !== (options.checkpointHandler === undefined) ||
        (options.checkpointBinding !== undefined && typeof options.checkpointBinding !== 'function') ||
        (options.checkpointHandler !== undefined && typeof options.checkpointHandler !== 'function'))
      throw new Error('Invalid monitoring checkpoint handler');
    this.#clock = options.clock ?? (() => new Date().toISOString());
    this.#random = options.random ?? Math.random;
  }

  proposeGrant(input: ProposeGrantInput): MonitoredActionGrant {
    exactMonitoringObject(input, ['id', 'workspaceId', 'ownerId', 'adapter', 'adapterVersion', 'connectionId',
      'connectionGeneration', 'browserProfileId', 'subjectDigest', 'scope', 'maximumEffects', 'expiresAt'],
      ['armPlan'], 'monitored action proposal');
    if (input.workspaceId !== this.options.workspaceId || input.ownerId !== this.options.ownerId)
      throw new Error('Monitored action workspace or owner binding mismatch');
    const state = this.#state(); assertOwner(state, input.ownerId);
    for (const [item, label] of [[input.id, 'grantId'], [input.adapter, 'adapter'],
      [input.connectionId, 'connectionId'], [input.browserProfileId, 'browserProfileId']] as const) identifier(item, label);
    if (!Number.isSafeInteger(input.adapterVersion) || input.adapterVersion < 1 ||
        !Number.isSafeInteger(input.connectionGeneration) || input.connectionGeneration < 1 || input.maximumEffects !== 1)
      throw new Error('V1 monitored action maximum effects must equal one');
    if (!/^[a-f0-9]{64}$/.test(input.subjectDigest)) throw new Error('Invalid monitored subject digest');
    const now = this.#now(); canonicalInstant(input.expiresAt, 'expiry');
    if (Date.parse(input.expiresAt) <= Date.parse(now)) throw new Error('Monitored action expiry must be in the future');
    const adapter = this.registry.resolve(input.adapter, input.adapterVersion);
    const scope = jsonValue(adapter.validateScope(input.scope), 'monitored action scope');
    const base = { id: input.id, workspaceId: input.workspaceId, ownerId: input.ownerId, adapter: input.adapter,
      adapterVersion: input.adapterVersion, connectionId: input.connectionId,
      connectionGeneration: input.connectionGeneration, browserProfileId: input.browserProfileId,
      subjectDigest: input.subjectDigest, scope, maximumEffects: 1 as const, expiresAt: input.expiresAt,
      createdAt: now, revision: 1, ...(input.armPlan ? { armPlan: structuredClone(input.armPlan) } : {}) };
    const grant: MonitoredActionGrant = { ...base, digest: monitoredActionGrantDigest(base), status: 'pending' };
    validateGrant(grant);
    this.store.append(input.workspaceId, state.version,
      [{ type: 'monitored_action.grant_proposed', data: { grant } }], { actorId: input.ownerId, recordedAt: now });
    return structuredClone(this.#state().monitoredActionGrants[grant.id]!);
  }

  activateGrant(input: { ownerId: string; grantId: string; digest: string; revision: number }): MonitoredActionGrant {
    exactObject(input, ['ownerId', 'grantId', 'digest', 'revision'], 'grant activation');
    const state = this.#state(); assertOwner(state, input.ownerId); const grant = this.#storedGrant(state, input.grantId);
    this.#exactReference(grant, input.digest, input.revision);
    const installation = this.#activeInstallation();
    const at = this.#now();
    this.store.append(this.options.workspaceId, state.version, [{ type: 'monitored_action.grant_activated', data: {
      id: grant.id, digest: grant.digest, revision: grant.revision, ownerId: input.ownerId,
      installationGeneration: installation.generation, activatedAt: at
    } }], { actorId: input.ownerId, recordedAt: at });
    return this.grant(grant.id);
  }

  revokeGrant(input: { ownerId: string; grantId: string; digest: string; revision: number;
      reason: 'owner_revoked' | 'material_drift' }): MonitoredActionGrant {
    exactObject(input, ['ownerId', 'grantId', 'digest', 'revision', 'reason'], 'grant revocation');
    const state = this.#state(); assertOwner(state, input.ownerId); const grant = this.#storedGrant(state, input.grantId);
    this.#exactReference(grant, input.digest, input.revision);
    if (!['owner_revoked', 'material_drift'].includes(input.reason)) throw new Error('Invalid grant revocation reason');
    if (grant.revokedAt !== undefined || grant.status === 'expired') return this.grant(grant.id);
    const at = this.#now();
    this.store.terminalizeMonitoredGrant(this.options.workspaceId, state.version, { type: 'monitored_action.grant_revoked', data: {
      id: grant.id, digest: grant.digest, revision: grant.revision, reason: input.reason, revokedAt: at
    } }, { actorId: input.ownerId, recordedAt: at });
    this.#abortGrantJobs(grant.id);
    return this.grant(grant.id);
  }

  revokeGrantForOwner(input: { ownerId: string; source: string; requestId: string; grantId: string;
      digest: string; revision: number; kind: 'monitoring_revoke' } | { ownerId: string; source: string;
      requestId: string; grantId: string; monitorId: string; digest: string; revision: number;
      controlRevision: number; kind: 'monitoring_stop' }):
      { grant: MonitoredActionGrant; receipt: ServiceReceipt; duplicate: boolean } {
    const requiredKeys = input.kind === 'monitoring_stop'
      ? ['ownerId', 'source', 'requestId', 'grantId', 'monitorId', 'digest', 'revision', 'controlRevision', 'kind']
      : ['ownerId', 'source', 'requestId', 'grantId', 'digest', 'revision', 'kind'];
    exactMonitoringObject(input, requiredKeys, [], 'owner grant revocation');
    const envelope: Extract<ServiceEnvelope, { kind: 'monitoring_revoke' | 'monitoring_stop' }> = input.kind === 'monitoring_stop'
      ? { kind: input.kind, grantId: input.grantId, monitorId: input.monitorId, digest: input.digest,
          revision: input.revision, controlRevision: input.controlRevision }
      : { kind: input.kind, grantId: input.grantId, digest: input.digest, revision: input.revision };
    const identity = { workspaceId: this.options.workspaceId, source: input.source, requestId: input.requestId };
    const prior = this.store.findServiceReceipt(identity, envelope);
    if (prior) return { grant: this.grant(input.grantId), receipt: prior, duplicate: true };
    const state = this.#state(); assertOwner(state, input.ownerId); const grant = this.#storedGrant(state, input.grantId);
    this.#exactReference(grant, input.digest, input.revision);
    let monitorId: string | undefined;
    if (input.kind === 'monitoring_stop') {
      const monitor = required(state.monitors, input.monitorId, 'Monitor');
      if (monitor.grantId !== grant.id || !monitor.control || monitor.control.revision !== input.controlRevision)
        throw new Error('Monitor stop reference changed');
      monitorId = monitor.id;
    }
    if (grant.revokedAt !== undefined || grant.status === 'expired') throw new Error('Grant is already terminal');
    const at = this.#now();
    this.store.terminalizeMonitoredGrant(this.options.workspaceId, state.version,
      { type: 'monitored_action.grant_revoked', data: { id: grant.id, digest: grant.digest,
        revision: grant.revision, reason: 'owner_revoked', revokedAt: at } },
      { actorId: input.ownerId, recordedAt: at }, { ...identity, ownerId: input.ownerId, envelope,
        monitoring: { grantId: grant.id, ...(monitorId ? { monitorId } : {}), recordIds: [] } });
    this.#abortGrantJobs(grant.id);
    const receipt = this.store.findServiceReceipt(identity, envelope);
    if (!receipt) throw new Error('Monitoring terminal receipt was not committed');
    return { grant: this.grant(grant.id), receipt, duplicate: false };
  }

  reconcileInstallation(input: { ownerId: string; grantId: string; digest: string; revision: number }): MonitoredActionGrant {
    exactObject(input, ['ownerId', 'grantId', 'digest', 'revision'], 'installation reconciliation');
    const state = this.#state(); assertOwner(state, input.ownerId); const grant = this.#storedGrant(state, input.grantId);
    this.#exactReference(grant, input.digest, input.revision);
    const installation = this.store.monitorInstallation();
    if (!installation || (installation.active &&
        !(grant.status === 'active' && grant.installationGeneration !== installation.generation)))
      throw new Error('Monitored installation does not require reconciliation');
    const at = this.#now();
    this.store.reconcileMonitoredInstallation(this.options.workspaceId, state.version,
      { id: grant.id, digest: grant.digest, revision: grant.revision, ownerId: input.ownerId,
        reconciledAt: at }, { actorId: input.ownerId, recordedAt: at });
    return this.grant(grant.id);
  }

  grant(id: string): MonitoredActionGrant {
    const grant = structuredClone(this.#storedGrant(this.#state(), id));
    const installation = this.store.monitorInstallation();
    if (grant.status === 'active' && (!installation?.active || grant.installationGeneration !== installation.generation))
      grant.status = 'blocked';
    return grant;
  }

  configureMonitor(input: ConfigureMonitorInput): MonitorState {
    exactMonitoringObject(input, ['ownerId', 'id', 'grantId', 'workId', 'nextDueAt', 'maxObservationAgeMs', 'intervalMs',
      'jitterMs', 'requestBudget', 'requestWindowMs', 'backoffBaseMs', 'backoffMaxMs'], ['control'], 'monitor configuration');
    const state = this.#state(); assertOwner(state, input.ownerId);
    if (!this.store.monitorJobsEnabled()) throw new Error('Storage upgrade is required before enabling monitor jobs');
    const grant = this.#usableGrant(input.grantId, state); required(state.works, input.workId, 'Work');
    canonicalInstant(input.nextDueAt, 'monitor due time');
    const monitor: MonitorState = {
      id: input.id, workspaceId: this.options.workspaceId, grantId: grant.id, workId: input.workId,
      adapter: grant.adapter, adapterVersion: grant.adapterVersion, connectionId: grant.connectionId,
      connectionGeneration: grant.connectionGeneration, browserProfileId: grant.browserProfileId,
      subjectDigest: grant.subjectDigest, maxObservationAgeMs: input.maxObservationAgeMs,
      intervalMs: input.intervalMs, jitterMs: input.jitterMs, requestBudget: input.requestBudget,
      requestWindowMs: input.requestWindowMs, backoffBaseMs: input.backoffBaseMs, backoffMaxMs: input.backoffMaxMs,
      status: 'active', nextDueAt: input.nextDueAt, requestWindowStartedAt: this.#now(), requestsInWindow: 0,
      lastObservation: null, lastCompleteObservationAt: null, lastCompleteCoverage: null,
      consecutiveFailures: 0, backoffMs: 0, pauseReason: null, inFlightJobId: null
      , ...(input.control ? { control: structuredClone(input.control) } : {})
    };
    assertArmPlanCurrent(state, grant, monitor);
    this.store.append(this.options.workspaceId, state.version,
      [{ type: 'monitor.configured', data: { monitor } }], { actorId: input.ownerId, recordedAt: this.#now() });
    return structuredClone(this.#state().monitors[monitor.id]!);
  }

  pauseMonitor(input: { ownerId: string; monitorId: string; digest: string; revision: number;
      controlRevision: number; reason: 'owner_paused' | 'owner_takeover'; binding: import('../browser/types.js').BrowserEpoch &
        { tabId: number }; handoffId?: string }): MonitorState {
    exactMonitoringObject(input, ['ownerId', 'monitorId', 'digest', 'revision', 'controlRevision', 'reason', 'binding'],
      ['handoffId'], 'monitor pause');
    const state = this.#state(); assertOwner(state, input.ownerId);
    const item = required(state.monitors, input.monitorId, 'Monitor');
    const grant = this.#storedGrant(state, item.grantId); this.#exactReference(grant, input.digest, input.revision);
    if (!item.control || item.control.revision !== input.controlRevision || item.inFlightJobId !== null ||
        item.status !== 'active' || grant.reservedActionId !== undefined) throw new Error('Monitor cannot be paused');
    const at = this.#now();
    this.store.append(this.options.workspaceId, state.version, [{ type: 'monitor.paused', data: {
      id: item.id, expectedControlRevision: input.controlRevision, ownerId: input.ownerId, reason: input.reason,
      jobId: null, handoffId: input.handoffId ?? randomUUID(), binding: structuredClone(input.binding), pausedAt: at
    } }], { actorId: input.ownerId, recordedAt: at });
    this.releaseMonitorWorker(item.id);
    return structuredClone(this.#state().monitors[item.id]!);
  }

  pauseMonitorForOwner(input: { ownerId: string; source: string; requestId: string; monitorId: string;
      digest: string; revision: number; controlRevision: number; reason: 'owner_paused' | 'owner_takeover';
      binding: import('../browser/types.js').BrowserEpoch & { tabId: number } }):
      { monitor: MonitorState; receipt: ServiceReceipt; duplicate: boolean } {
    exactMonitoringObject(input, ['ownerId', 'source', 'requestId', 'monitorId', 'digest', 'revision',
      'controlRevision', 'reason', 'binding'], [], 'owner monitor pause');
    const kind = input.reason === 'owner_paused' ? 'monitoring_pause' as const : 'monitoring_takeover' as const;
    const initial = this.#state(); assertOwner(initial, input.ownerId);
    const initialMonitor = required(initial.monitors, input.monitorId, 'Monitor');
    const envelope: Extract<ServiceEnvelope, { kind: 'monitoring_pause' | 'monitoring_takeover' }> = {
      kind, grantId: initialMonitor.grantId, monitorId: input.monitorId, digest: input.digest,
      revision: input.revision, controlRevision: input.controlRevision
    };
    const identity = { workspaceId: this.options.workspaceId, source: input.source, requestId: input.requestId };
    const duplicate = this.store.findServiceReceipt(identity, envelope);
    if (duplicate) return { monitor: structuredClone(initialMonitor), receipt: duplicate, duplicate: true };
    const at = this.#now(), handoffId = randomUUID();
    const committed = this.store.pauseMonitorForOwner({ ...identity, ownerId: input.ownerId, envelope,
      reason: input.reason, handoffId, binding: structuredClone(input.binding), at });
    this.releaseMonitorWorker(initialMonitor.id);
    return { monitor: committed.monitor,
      receipt: committed.receipt, duplicate: committed.duplicate };
  }

  settleMonitorHandoff(input: { monitorId: string; handoffId: string; state: 'confirmed' | 'failed' }): MonitorState {
    exactObject(input, ['monitorId', 'handoffId', 'state'], 'monitor handoff settlement');
    const current = this.#state(); const monitor = required(current.monitors, input.monitorId, 'Monitor');
    if (monitor.control?.handoff?.id === input.handoffId && monitor.control.handoff.state === input.state)
      return structuredClone(monitor);
    const at = this.#now(); this.store.append(this.options.workspaceId, current.version,
      [{ type: 'monitor.handoff_settled', data: { id: monitor.id, handoffId: input.handoffId,
        state: input.state, settledAt: at } }], { recordedAt: at });
    return structuredClone(this.#state().monitors[monitor.id]!);
  }

  recordResumeRetirementFailure(job: ServiceJob,
      candidate: import('../browser/types.js').BrowserEpoch & { tabId: number }): MonitorState {
    if (job.kind !== 'monitor' || job.parameters.kind !== 'monitor' || job.parameters.purpose !== 'resume' || !job.claim)
      throw new Error('Invalid resume retirement failure job');
    const state = this.#state(), monitor = required(state.monitors, job.parameters.monitorId, 'Monitor');
    if (monitor.inFlightJobId !== job.id || monitor.control?.resume?.jobId !== job.id)
      throw new Error('Resume retirement failure is no longer current');
    const at = this.#now();
    this.store.append(this.options.workspaceId, state.version, [{ type: 'monitor.resume_retirement_failed', data: {
      id: monitor.id, jobId: job.id, handoffId: randomUUID(), candidate: structuredClone(candidate), failedAt: at
    } }], { recordedAt: at });
    return structuredClone(this.#state().monitors[monitor.id]!);
  }

  evaluate(grantId: string, observation: Observation, input: {
    maxObservationAgeMs: number; binding: MonitoredActionBinding;
  }): OperationCommand | undefined {
    exactObject(input, ['maxObservationAgeMs', 'binding'], 'monitored evaluation'); validateObservation(observation);
    const state = this.#state(); const stored = this.#storedGrant(state, grantId);
    if (!bindingMatches(stored, input.binding)) {
      if (['pending', 'active'].includes(stored.status)) this.revokeGrant({ ownerId: this.options.ownerId,
        grantId: stored.id, digest: stored.digest, revision: stored.revision, reason: 'material_drift' });
      throw new Error('Material monitored action drift revoked the grant');
    }
    const grant = this.#usableGrant(grantId);
    let connection: Connection;
    try { connection = this.#connection(this.#state(), grant); }
    catch {
      this.revokeGrant({ ownerId: this.options.ownerId, grantId: grant.id, digest: grant.digest,
        revision: grant.revision, reason: 'material_drift' });
      throw new Error('Material monitored action connection drift revoked the grant');
    }
    return evaluateMonitoredAction(grant, observation, this.registry.resolve(grant.adapter, grant.adapterVersion), {
      now: this.#now(), maxObservationAgeMs: input.maxObservationAgeMs, connection
    });
  }

  reserve(input: ReserveMonitoredActionInput): Action {
    exactMonitoringObject(input, ['grantId', 'workId', 'observation', 'maxObservationAgeMs', 'binding'],
      ['actionId', 'attemptId', 'monitorId', 'beforeCommit'], 'monitored action reservation');
    if (input.beforeCommit !== undefined && typeof input.beforeCommit !== 'function') throw new Error('Invalid reservation guard');
    validateBinding(input.binding); validateObservation(input.observation);
    const initial = this.#state();
    assertArmPlanReservationLifecycle(initial, this.#storedGrant(initial, input.grantId));
    const command = this.evaluate(input.grantId, input.observation,
      { maxObservationAgeMs: input.maxObservationAgeMs, binding: input.binding });
    if (!command) throw new Error('Observation contains no eligible monitored action candidate');
    const state = this.#state(); const grant = this.#usableGrant(input.grantId, state);
    if (grant.armPlan) {
      const plan = grant.armPlan;
      if (input.workId !== plan.workId || input.monitorId !== plan.monitorId ||
          input.maxObservationAgeMs !== plan.polling.maxObservationAgeMs)
        throw new Error('Reservation no longer matches reviewed arm plan');
      assertArmPlanReservationReady(state, grant);
    }
    const actionId = input.actionId ?? randomUUID(), attemptId = input.attemptId ?? randomUUID();
    identifier(actionId, 'actionId'); identifier(attemptId, 'attemptId');
    const action = this.#narrowedAction(state, grant, input.workId, input.observation, command, actionId);
    const evidenceDigest = observationDigest(input.observation);
    const at = this.#now();
    const events = monitoredReservationEvents({ grant, action, attemptId, observationDigest: evidenceDigest,
      reservedAt: at, ...(input.monitorId ? { monitorId: input.monitorId } : {}) });
    this.store.append(this.options.workspaceId, state.version, events, { recordedAt: at }, input.beforeCommit);
    return structuredClone(this.#state().actions[actionId]!);
  }

  settleGrant(input: { grantId: string; actionId: string; outcome: MonitoredGrantSettlementOutcome }): MonitoredActionGrant {
    exactObject(input, ['grantId', 'actionId', 'outcome'], 'grant settlement');
    const state = this.#state(); const grant = this.#storedGrant(state, input.grantId);
    if (grant.settlement?.actionId === input.actionId && grant.settlement.outcome === input.outcome)
      return this.grant(grant.id);
    const at = this.#now();
    this.store.append(this.options.workspaceId, state.version, [{ type: 'monitored_action.grant_settled', data: {
      id: grant.id, actionId: input.actionId, outcome: input.outcome, settledAt: at
    } }], { recordedAt: at });
    return this.grant(grant.id);
  }

  recordObservation(monitorId: string, observation: Observation, input: { jobId: string; observedAt: string }): MonitorState {
    exactObject(input, ['jobId', 'observedAt'], 'monitor observation context');
    validateObservation(observation); identifier(input.jobId, 'jobId'); canonicalInstant(input.observedAt, 'recorded observation time');
    const state = this.#state(); const item = required(state.monitors, monitorId, 'Monitor');
    const now = this.#now();
    const events: DomainEvent[] = [];
    if (item.inFlightJobId === null) events.push({ type: 'monitor.poll_started', data: {
      id: item.id, jobId: input.jobId, dueAt: item.nextDueAt!, startedAt: now,
      requestWindowStartedAt: item.requestWindowStartedAt, requestsInWindow: item.requestsInWindow + 1
    } });
    events.push(this.#observationEvent(item, input.jobId, observation, now));
    this.store.append(this.options.workspaceId, state.version, events, { recordedAt: now });
    return structuredClone(this.#state().monitors[monitorId]!);
  }

  // Storage/runtime integration is implemented below the policy surface; these declarations keep callers exact.
  admitDueMonitors(input: { instanceId: string; at: string; limit: number }): AdmitDueMonitorResult {
    exactObject(input, ['instanceId', 'at', 'limit'], 'monitor admission');
    identifier(input.instanceId, 'instanceId'); canonicalInstant(input.at, 'monitor scheduler time');
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100) throw new Error('Invalid monitor admission limit');
    const result: AdmitDueMonitorResult = { queued: 0, budgetDeferred: 0, unchanged: 0, full: false };
    const due = Object.values(this.#state().monitors)
      .filter(item => item.status === 'active' && item.inFlightJobId === null && item.nextDueAt !== null &&
        Date.parse(item.nextDueAt) <= Date.parse(input.at))
      .sort((left, right) => Date.parse(left.nextDueAt!) - Date.parse(right.nextDueAt!) || left.id.localeCompare(right.id))
      .slice(0, input.limit);
    for (const item of due) {
      const state = this.#state();
      const grant = state.monitoredActionGrants[item.grantId];
      const installation = this.store.monitorInstallation();
      if (!grant || grant.status !== 'active' || !installation?.active ||
          grant.installationGeneration !== installation.generation) {
        result.unchanged++;
        continue;
      }
      try { assertArmPlanCurrent(state, grant, item); }
      catch { result.unchanged++; continue; }
      const admitted = this.store.admitDueMonitorJob(this.options.workspaceId, item.id, input.instanceId, input.at);
      if (admitted.kind === 'queued') result.queued++;
      else if (admitted.kind === 'budget') result.budgetDeferred++;
      else if (admitted.kind === 'full') { result.full = true; break; }
      else result.unchanged++;
    }
    return result;
  }

  async runJob(job: ServiceJob, fence: TrustedExecutionFence): Promise<void> {
    if (job.kind !== 'monitor' || job.parameters.kind !== 'monitor') throw new Error('Invalid monitor service job');
    const controller = new AbortController();
    const controllers = this.#grantJobControllers.get(job.parameters.grantId) ?? new Set<AbortController>();
    controllers.add(controller); this.#grantJobControllers.set(job.parameters.grantId, controllers);
    const monitorControllers = this.#monitorJobControllers.get(job.parameters.monitorId) ?? new Set<AbortController>();
    monitorControllers.add(controller); this.#monitorJobControllers.set(job.parameters.monitorId, monitorControllers);
    const currentFence: TrustedExecutionFence = {
      serviceGeneration: fence.serviceGeneration,
      deadline: fence.deadline,
      signal: AbortSignal.any([fence.signal, controller.signal]),
      assertCurrent: async () => {
        if (controller.signal.aborted) throw new OperationStoppedError();
        await fence.assertCurrent();
        if (controller.signal.aborted) throw new OperationStoppedError();
      },
      assertSettlementCurrent: () => {
        if (controller.signal.aborted) throw new OperationStoppedError();
        fence.assertSettlementCurrent?.();
      }
    };
    try {
      if (job.parameters.purpose === 'resume') await this.#runResumeJob(job, currentFence);
      else await this.#runMonitoredJob(job, currentFence);
    }
    finally {
      controllers.delete(controller);
      if (controllers.size === 0) this.#grantJobControllers.delete(job.parameters.grantId);
      monitorControllers.delete(controller);
      if (monitorControllers.size === 0) this.#monitorJobControllers.delete(job.parameters.monitorId);
    }
  }

  /** Cancels only continuations belonging to the captured monitor; never waits on the runtime drain. */
  releaseMonitorWorker(monitorId: string): void {
    identifier(monitorId, 'monitorId');
    for (const controller of this.#monitorJobControllers.get(monitorId) ?? [])
      controller.abort(new OperationStoppedError());
  }

  async runReservedActionJob(job: ServiceJob, fence: TrustedExecutionFence): Promise<Action> {
    if (job.kind !== 'execute' || job.parameters.kind !== 'execute') return this.#runReservedActionJob(job, fence);
    const action = required(this.#state().actions, job.parameters.actionId, 'Action');
    if (!action.monitoredGrant) throw new Error('Monitored action binding is missing');
    const grantId = action.monitoredGrant.id;
    const controller = new AbortController();
    const controllers = this.#grantJobControllers.get(grantId) ?? new Set<AbortController>();
    controllers.add(controller); this.#grantJobControllers.set(grantId, controllers);
    const currentFence: TrustedExecutionFence = {
      serviceGeneration: fence.serviceGeneration, deadline: fence.deadline,
      signal: AbortSignal.any([fence.signal, controller.signal]),
      assertCurrent: async () => {
        if (controller.signal.aborted) throw new OperationStoppedError();
        await fence.assertCurrent();
        if (controller.signal.aborted) throw new OperationStoppedError();
      },
      ...(fence.assertSettlementCurrent ? { assertSettlementCurrent: () => fence.assertSettlementCurrent!() } : {})
    };
    try { return await this.#runReservedActionJob(job, currentFence); }
    catch (error) {
      if (isFatalServiceStorageError(error)) throw error;
      const state = this.#state();
      const current = state.actions[action.id];
      if (controller.signal.aborted && state.monitoredActionGrants[grantId]?.revokedAt !== undefined &&
          current && current.attemptId === action.attemptId && current.status !== 'running') return structuredClone(current);
      const currentJob = this.store.serviceJob(this.options.workspaceId, job.id);
      if (job.claim && current?.status === 'running' && current.attemptId === action.attemptId &&
          currentJob.status === 'running' && currentJob.claim?.claimId === job.claim.claimId &&
          currentJob.attemptId === undefined) {
        return this.store.stopMonitoredActionJobBeforeIntent(this.options.workspaceId, job.claim, {
          actionId: action.id, attemptId: action.attemptId!,
          evidence: 'Monitored execution became ineligible before intent; no booking submission was authorized.',
          at: this.#now()
        }).action;
      }
      throw error;
    } finally {
      controllers.delete(controller);
      if (controllers.size === 0) this.#grantJobControllers.delete(grantId);
    }
  }

  async #runReservedActionJob(job: ServiceJob, fence: TrustedExecutionFence): Promise<Action> {
    if ((job.kind !== 'execute' && job.kind !== 'readback') || job.parameters.kind !== job.kind ||
        job.status !== 'running' || !job.claim) throw new Error('Invalid monitored action service job');
    const initial = this.#state();
    const action = required(initial.actions, job.parameters.actionId, 'Action');
    if (!action.monitoredGrant || action.digest !== job.parameters.digest || !action.attemptId)
      throw new Error('Monitored action request is no longer current');
    const grant = this.#storedGrant(initial, action.monitoredGrant.id);
    const connection = this.#connection(initial, grant);
    const installation = this.store.monitorInstallation();
    if (!installation?.active || installation.generation !== grant.installationGeneration)
      throw new Error('Monitored installation binding changed');
    const adapter = this.registry.resolve(grant.adapter, grant.adapterVersion);
    const executionFence = this.#reservedActionFence(fence, action, grant, connection, job.kind === 'execute');
    if (job.kind === 'readback') {
      if (!['accepted', 'unknown'].includes(action.status) || !adapter.verifyReserved)
        throw new Error('Monitored action is not eligible for readback');
      const result = await withinExecution(() => adapter.verifyReserved!({ action: structuredClone(action) as never,
        grant: structuredClone(grant), connection: structuredClone(connection), fence: executionFence }), executionFence);
      if (result.status !== 'satisfied') return structuredClone(this.#state().actions[action.id]!);
      const at = this.#now(); const state = this.#state(); const current = required(state.actions, action.id, 'Action');
      const events: DomainEvent[] = [];
      if (current.status === 'unknown') {
        const evidenceRef = this.store.putArtifact(this.options.workspaceId,
          'Authoritative visa appointment readback reconciled the uncertain attempt.');
        events.push({ type: 'action.reconciled', data: { id: action.id, status: 'accepted', evidenceRef } });
      }
      events.push({ type: 'action.verification_recorded', data: { id: action.id, verification: {
        status: 'satisfied', observation: this.#receiptObservation(connection, action, result.receipt, at), recordedAt: at
      } } });
      this.store.recordActionVerification(this.options.workspaceId, state.version, action.id, events,
        { recordedAt: at }, undefined, job.claim);
      this.settleGrant({ grantId: grant.id, actionId: action.id, outcome: 'accepted_verified' });
      return structuredClone(this.#state().actions[action.id]!);
    }
    if (action.status !== 'running' || grant.status !== 'blocked' || !adapter.executeReserved)
      throw new Error('Monitored action is not eligible for execution');
    await executionFence.assertCurrent();
    const intentId = createIntentId(action.id, action.attemptId);
    const intent = canonicalJson(jsonValue({ version: 1, actionId: action.id, attemptId: action.attemptId,
      actionDigest: action.digest, grant: action.monitoredGrant, connectionId: connection.id,
      connectionGeneration: connection.generation, browserProfileId: grant.browserProfileId,
      installationGeneration: grant.installationGeneration!, intentId, command: action.command }, 'visa monitored intent'));
    await executionFence.assertCurrent();
    this.store.recordMonitoredActionIntent(this.options.workspaceId, job.claim, { actionId: action.id,
      grantId: grant.id, attemptId: action.attemptId, intentId, evidence: intent, at: this.#now() });
    let result;
    try {
      await executionFence.assertCurrent();
      result = await withinExecution(() => adapter.executeReserved!({
        action: structuredClone(this.#state().actions[action.id]!) as never,
        grant: structuredClone(grant), connection: structuredClone(connection), fence: executionFence, intentId,
        recordConfirmation: async receipt => {
          await executionFence.assertCurrent();
          const confirmation = jsonValue(receipt, 'visa confirmation receipt');
          if (!confirmation || typeof confirmation !== 'object' || Array.isArray(confirmation) ||
              typeof confirmation.referenceDigest !== 'string')
            throw new Error('Invalid visa confirmation receipt');
          this.store.recordMonitoredActionConfirmation(this.options.workspaceId, job.claim!, {
            actionId: action.id, grantId: grant.id, attemptId: action.attemptId!,
            referenceDigest: confirmation.referenceDigest, evidence: canonicalJson(confirmation), at: this.#now()
          });
        } }), executionFence);
    } catch (error) {
      if (isFatalServiceStorageError(error)) throw error;
      result = { status: 'unknown' as const, verificationOnly: true as const };
    }
    const status = result.status === 'accepted' ? 'accepted' : result.status === 'failed' ? 'failed' : 'unknown';
    const evidence = status === 'accepted' ? 'Visa submission confirmed; authoritative appointment readback matched.' :
      status === 'failed' ? 'Visa pre-submit contract changed; no booking submission was authorized.' :
      'Visa submission outcome is uncertain. Verification-only recovery is required; no automatic retry.';
    if (!this.store.finishActionAttempt(this.options.workspaceId, action.id, action.attemptId, status, evidence,
      { recordedAt: this.#now() })) return structuredClone(this.#state().actions[action.id]!);
    if (result.status === 'accepted') {
      const state = this.#state(); const at = this.#now();
      this.store.recordActionVerification(this.options.workspaceId, state.version, action.id,
        [{ type: 'action.verification_recorded', data: { id: action.id, verification: {
          status: 'satisfied', observation: this.#receiptObservation(connection, action, result.receipt, at), recordedAt: at
        } } }], { recordedAt: at }, undefined, job.claim);
    }
    this.settleGrant({ grantId: grant.id, actionId: action.id, outcome: result.status === 'accepted'
      ? 'accepted_verified' : result.status === 'failed' ? 'failed' : 'unknown' });
    return structuredClone(this.#state().actions[action.id]!);
  }

  #receiptObservation(connection: Connection, action: Action, receipt: unknown, at: string) {
    if (!('resourceId' in action.command)) throw new Error('Invalid monitored operation command');
    return { connectionId: connection.id, provider: connection.provider, subject: connection.subject,
      connectionGeneration: connection.generation, resourceId: action.command.resourceId,
      source: 'us-visa-china:authoritative-readback', observedAt: at,
      state: jsonValue(receipt, 'visa appointment receipt') };
  }

  #reservedActionFence(lifecycle: TrustedExecutionFence, action: Action, grant: MonitoredActionGrant,
      connection: Connection, mutation: boolean): TrustedExecutionFence {
    const assertCurrent = async () => {
      await lifecycle.assertCurrent();
      const state = this.#state();
      const currentAction = state.actions[action.id];
      const currentGrant = state.monitoredActionGrants[grant.id];
      const currentConnection = state.connections[connection.id];
      const currentWork = state.works[action.workId];
      const currentInstallation = this.store.monitorInstallation();
      const actionStatus = mutation ? currentAction?.status === 'running' :
        currentAction !== undefined && ['accepted', 'unknown'].includes(currentAction.status);
      if (!actionStatus || currentAction?.digest !== action.digest || currentAction.attemptId !== action.attemptId ||
          currentAction.monitoredGrant?.id !== grant.id || currentAction.monitoredGrant.digest !== grant.digest ||
          currentAction.monitoredGrant.revision !== grant.revision || !currentGrant || currentGrant.status !== 'blocked' ||
          currentGrant.digest !== grant.digest || currentGrant.revision !== grant.revision ||
          currentGrant.reservedActionId !== action.id || currentGrant.reservationAttemptId !== action.attemptId ||
          currentGrant.connectionId !== connection.id || currentGrant.connectionGeneration !== connection.generation ||
          currentGrant.browserProfileId !== grant.browserProfileId ||
          currentGrant.installationGeneration !== grant.installationGeneration || !currentConnection ||
          currentConnection.status !== 'active' || currentConnection.generation !== connection.generation ||
          currentConnection.provider !== connection.provider || currentConnection.subject !== connection.subject ||
          !currentInstallation?.active || currentInstallation.generation !== grant.installationGeneration ||
          (mutation && (!currentWork || currentWork.revision !== action.workRevision ||
            ['done', 'cancelled'].includes(currentWork.phase))) ||
          (mutation && (currentGrant.revokedAt !== undefined || Date.parse(this.#now()) >= Date.parse(currentGrant.expiresAt))))
        throw new MonitoredAuthorityChangedError();
      await lifecycle.assertCurrent();
    };
    return { serviceGeneration: lifecycle.serviceGeneration, deadline: lifecycle.deadline,
      signal: lifecycle.signal, assertCurrent,
      ...(lifecycle.assertSettlementCurrent
        ? { assertSettlementCurrent: () => lifecycle.assertSettlementCurrent!() } : {}) };
  }

  async #runMonitoredJob(job: ServiceJob, fence: TrustedExecutionFence): Promise<void> {
    if (job.kind !== 'monitor' || job.parameters.kind !== 'monitor' || job.parameters.purpose === 'resume' ||
        job.status !== 'running' || !job.claim)
      throw new Error('Invalid monitor service job');
    await fence.assertCurrent();
    const state = this.#state();
    const item = required(state.monitors, job.parameters.monitorId, 'Monitor');
    if (item.inFlightJobId !== job.id || item.grantId !== job.parameters.grantId)
      throw new Error('Monitor job is no longer current');
    const grant = this.#usableGrant(item.grantId, state);
    assertArmPlanCurrent(state, grant, item);
    const adapter = this.registry.resolve(grant.adapter, grant.adapterVersion);
    if (!adapter.inspect) throw new Error('Monitoring adapter has no inspection implementation');
    let connection: Connection;
    try { connection = this.#connection(state, grant); }
    catch {
      const at = this.#now();
      const changed: Observation = { observedAt: at, complete: false, coverage: {}, candidates: [], result: 'contract_changed' };
      this.store.completeMonitorJob(this.options.workspaceId, job.claim, this.#observationEvent(item, job.id, changed, at), at);
      this.revokeGrant({ ownerId: this.options.ownerId, grantId: grant.id, digest: grant.digest,
        revision: grant.revision, reason: 'material_drift' });
      return;
    }
    let observation: Observation;
    try {
      observation = await withinExecution(() => adapter.inspect!({ monitor: structuredClone(item),
        grant: structuredClone(grant), connection: structuredClone(connection), fence }), fence);
    } catch (error) {
      if (error instanceof OperationStoppedError || fence.signal.aborted) throw error;
      await fence.assertCurrent();
      observation = { observedAt: this.#now(), complete: false, coverage: {}, candidates: [],
        result: 'provider_unavailable' };
    }
    await fence.assertCurrent();
    validateObservation(observation);
    const postInspection = this.#state();
    const postInspectionMonitor = required(postInspection.monitors, item.id, 'Monitor');
    const postInspectionGrant = this.#usableGrant(item.grantId, postInspection);
    assertArmPlanCurrent(postInspection, postInspectionGrant, postInspectionMonitor);
    if (observation.result === 'complete' && observation.complete && observation.candidates.length > 0) {
      const command = this.evaluate(grant.id, observation, { maxObservationAgeMs: item.maxObservationAgeMs,
        binding: this.#binding(grant) });
      await fence.assertCurrent();
      if (command) {
        const now = this.#now();
        const age = Date.parse(now) - Date.parse(observation.observedAt);
        if (age < 0 || age > item.maxObservationAgeMs) throw new Error('Stale or non-fresh monitor observation');
        const event = this.#observationEvent(item, job.id, observation, now);
        const current = this.#state();
        const currentGrant = this.#usableGrant(grant.id, current);
        const currentMonitor = required(current.monitors, item.id, 'Monitor');
        assertArmPlanCurrent(current, currentGrant, currentMonitor);
        const evidenceDigest = observationDigest(observation);
        const actionId = this.#scheduledIdentifier('action', job.id, evidenceDigest);
        const attemptId = this.#scheduledIdentifier('attempt', job.id, evidenceDigest);
        const action = this.#narrowedAction(current, currentGrant, item.workId, observation, command, actionId);
        this.store.completeMonitorJobAndAdmitAction(this.options.workspaceId, job.claim, {
          expectedVersion: current.version, event, observation, action, attemptId, observationDigest: evidenceDigest,
          binding: { monitorId: item.id, grantId: currentGrant.id, grantDigest: currentGrant.digest,
            grantRevision: currentGrant.revision, adapter: currentGrant.adapter,
            adapterVersion: currentGrant.adapterVersion, connectionId: currentGrant.connectionId,
            connectionGeneration: currentGrant.connectionGeneration, browserProfileId: currentGrant.browserProfileId,
            subjectDigest: currentGrant.subjectDigest,
            installationGeneration: currentGrant.installationGeneration!, workId: item.workId,
            workRevision: action.workRevision },
          maxObservationAgeMs: item.maxObservationAgeMs,
          at: now
        }, () => {
          assertExecutionActive({ signal: fence.signal, deadline: fence.deadline });
          fence.assertSettlementCurrent?.();
          assertExecutionActive({ signal: fence.signal, deadline: fence.deadline });
          const commitAge = Date.parse(this.#now()) - Date.parse(observation.observedAt);
          if (commitAge < 0 || commitAge > item.maxObservationAgeMs)
            throw new Error('Stale or non-fresh monitor observation at commit');
        });
        return;
      }
    }
    const now = this.#now();
    const event = this.#observationEvent(item, job.id, observation, now);
    if (event.data.status === 'paused' && item.control && this.options.checkpointBinding && this.options.checkpointHandler) {
      const handoffId = randomUUID();
      this.store.completeMonitorJob(this.options.workspaceId, job.claim, event, now, { type: 'monitor.paused', data: {
        id: item.id, expectedControlRevision: item.control.revision, ownerId: null,
        reason: event.data.pauseReason as 'session_expired' | 'needs_human' | 'rate_limited' | 'contract_changed',
        jobId: job.id, handoffId, binding: this.options.checkpointBinding(), pausedAt: now
      } });
      try {
        await this.options.checkpointHandler(item.id, event.data.pauseReason!, handoffId);
        this.settleMonitorHandoff({ monitorId: item.id, handoffId, state: 'confirmed' });
      } catch {
        this.settleMonitorHandoff({ monitorId: item.id, handoffId, state: 'failed' });
      }
      return;
    }
    this.store.completeMonitorJob(this.options.workspaceId, job.claim, event, now);
  }

  async #runResumeJob(job: ServiceJob, fence: TrustedExecutionFence): Promise<void> {
    if (job.kind !== 'monitor' || job.parameters.kind !== 'monitor' || job.parameters.purpose !== 'resume' ||
        job.status !== 'running' || !job.claim || !this.options.resumeHandler)
      throw new Error('Invalid monitor resume job');
    let committed = false;
    let admissionCurrent = false;
    try {
      await fence.assertCurrent();
      const state = this.#state(); const item = required(state.monitors, job.parameters.monitorId, 'Monitor');
      const grant = this.#usableGrant(item.grantId, state); const installation = this.store.monitorInstallation();
      const work = required(state.works, item.workId, 'Work');
      assertArmPlanCurrent(state, grant, item);
      if (item.inFlightJobId !== job.id || item.control?.resume?.jobId !== job.id ||
          grant.id !== job.parameters.grantId || grant.digest !== job.parameters.digest ||
          grant.revision !== job.parameters.revision || item.control.revision !== job.parameters.controlRevision + 1 ||
          job.parameters.serviceGeneration !== fence.serviceGeneration ||
          installation?.generation !== job.parameters.installationGeneration || work.revision !== job.parameters.workRevision)
        throw new Error('Monitor resume job is no longer current');
      admissionCurrent = true;
      await withinExecution(() => this.options.resumeHandler!(job, fence, evidence => {
        if (committed) throw new Error('Monitor resume lifecycle was already committed');
        const at = this.#now();
        this.store.completeMonitorResumeJob(this.options.workspaceId, job.claim!, { outcome: 'resumed',
          reason: 'preflight_passed', evidence, nextDueAt: iso(Date.parse(at) + item.intervalMs), at }, () => {
          assertExecutionActive({ signal: fence.signal, deadline: fence.deadline });
          fence.assertSettlementCurrent?.();
        });
        committed = true;
      }), fence);
      if (!committed) throw new Error('Monitor resume lifecycle was not committed');
    } catch (error) {
      if (isFatalServiceStorageError(error)) throw error;
      const currentJob = this.store.serviceJob(this.options.workspaceId, job.id);
      if (currentJob.status !== 'running' || currentJob.claim?.claimId !== job.claim.claimId) return;
      this.store.completeMonitorResumeJob(this.options.workspaceId, job.claim, { outcome: 'rejected',
        reason: !admissionCurrent ? 'binding_changed' :
          error instanceof OperationStoppedError || fence.signal.aborted ? 'cancelled' :
          error instanceof MonitorResumeRejectedError ? error.reason : 'provider_unavailable',
        evidence: null, nextDueAt: null, at: this.#now() });
    }
  }

  #narrowedAction(state: State, grant: MonitoredActionGrant, workId: string, observation: Observation,
      command: OperationCommand, actionId: string): Action {
    const work = required(state.works, workId, 'Work');
    if (['done', 'cancelled'].includes(work.phase)) throw new Error('Monitored action work is closed');
    return { id: actionId, workId: work.id, key: `monitor:${grant.id}:${observationDigest(observation)}`,
      command, digest: monitoredActionCommandDigest(this.options.workspaceId, work.id, work.revision, grant, command),
      workRevision: work.revision, status: 'approved',
      monitoredGrant: { id: grant.id, digest: grant.digest, revision: grant.revision } };
  }

  #scheduledIdentifier(kind: 'action' | 'attempt', jobId: string, evidenceDigest: string): string {
    return `monitor-${kind}-${createHash('sha256').update(canonicalJson({ workspaceId: this.options.workspaceId,
      jobId, evidenceDigest, kind })).digest('hex')}`;
  }

  #observationEvent(item: MonitorState, jobId: string, observation: Observation, now: string): Extract<DomainEvent,
      { type: 'monitor.observation_recorded' }> {
    const paused = ['session_expired', 'needs_human', 'rate_limited', 'contract_changed'].includes(observation.result);
    const successful = observation.result === 'complete' && observation.complete;
    const failures = successful ? 0 : item.consecutiveFailures + 1;
    const backoff = successful ? 0 : Math.min(item.backoffMaxMs,
      item.backoffMs === 0 ? item.backoffBaseMs : item.backoffMs * 2);
    const delay = successful ? item.intervalMs : backoff;
    return { type: 'monitor.observation_recorded', data: { id: item.id, jobId,
      observation: { observedAt: observation.observedAt, complete: observation.complete,
        coverage: structuredClone(observation.coverage), result: observation.result },
      status: paused ? 'paused' : 'active', nextDueAt: paused ? null :
        iso(Date.parse(now) + delay + this.#jitter(boundedMonitorJitter(delay, item.jitterMs))),
      consecutiveFailures: failures, backoffMs: backoff,
      pauseReason: paused ? observation.result as MonitorPauseReason : null, recordedAt: now } };
  }

  #usableGrant(id: string, supplied?: State): MonitoredActionGrant {
    const state = supplied ?? this.#state(); const grant = this.#storedGrant(state, id); const now = this.#now();
    if (grant.status === 'active' && Date.parse(now) >= Date.parse(grant.expiresAt)) {
      this.store.terminalizeMonitoredGrant(this.options.workspaceId, state.version, { type: 'monitored_action.grant_expired', data: {
        id: grant.id, digest: grant.digest, revision: grant.revision, expiredAt: now
      } }, { recordedAt: now });
      this.#abortGrantJobs(grant.id);
      throw new Error('Monitored action grant expired');
    }
    if (grant.status !== 'active') throw new Error('Monitored action grant is not active or its allowance is blocked');
    const installation = this.store.monitorInstallation();
    if (!installation?.active || grant.installationGeneration !== installation.generation)
      throw new Error('Restored installation is blocked pending owner reconciliation');
    return grant;
  }

  #storedGrant(state: State, id: string): MonitoredActionGrant {
    identifier(id, 'grantId'); const grant = required(state.monitoredActionGrants, id, 'Monitored action grant');
    validateGrant(grant); return grant;
  }

  #connection(state: State, grant: MonitoredActionGrant): Connection {
    const connection = required(state.connections, grant.connectionId, 'Connection');
    if (connection.status !== 'active' || connection.generation !== grant.connectionGeneration)
      throw new Error('Monitored connection binding changed');
    return connection;
  }

  #binding(grant: MonitoredActionGrant): MonitoredActionBinding {
    return { adapter: grant.adapter, adapterVersion: grant.adapterVersion, connectionId: grant.connectionId,
      connectionGeneration: grant.connectionGeneration, browserProfileId: grant.browserProfileId,
      subjectDigest: grant.subjectDigest };
  }

  #exactReference(grant: MonitoredActionGrant, digest: string, revision: number): void {
    validateDigest(digest, 'grant digest');
    if (digest !== grant.digest || revision !== grant.revision) throw new Error('Monitored grant digest or revision binding mismatch');
  }

  #state(): State {
    const state = this.store.state(this.options.workspaceId);
    if (state.ownerId !== this.options.ownerId) throw new Error('Monitoring service owner binding mismatch');
    return state;
  }

  #now(): string { const value = this.#clock(); canonicalInstant(value, 'monitoring clock'); return value; }

  #activeInstallation(): { generation: string; active: boolean } {
    const installation = this.store.monitorInstallation();
    if (!installation?.active) throw new Error('Monitored installation requires owner reconciliation');
    return installation;
  }

  #abortGrantJobs(grantId: string): void {
    for (const controller of this.#grantJobControllers.get(grantId) ?? []) controller.abort(new OperationStoppedError());
  }

  #jitter(limit: number): number {
    const value = this.#random();
    if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error('Invalid monitoring random value');
    if (limit === 0) return 0;
    return Math.max(-limit, Math.min(limit, Math.round((value * 2 - 1) * limit)));
  }
}

function iso(milliseconds: number): string { return new Date(milliseconds).toISOString(); }
function createIntentId(actionId: string, attemptId: string): string {
  return createHash('sha256').update(`${actionId}\0${attemptId}`).digest('hex');
}

export { MonitoringService as MonitoredActionService };
