import { createHash, randomUUID } from 'node:crypto';
import type { Action, DomainEvent, State } from '../kernel/types.js';
import { identifier, required } from '../kernel/types.js';
import { assertOwner } from '../kernel/policy.js';
import { OperationStoppedError, withinExecution, type TrustedExecutionFence } from '../operations/execution-context.js';
import type { Connection, OperationCommand } from '../operations/types.js';
import { canonicalJson, exactObject, jsonValue } from '../operations/validation.js';
import { isFatalServiceStorageError } from '../storage/service-jobs.js';
import type { ServiceJob } from '../storage/service-jobs.js';
import type { SqliteStore } from '../storage/sqlite-store.js';
import {
  bindingMatches, boundedMonitorJitter, canonicalInstant, evaluateMonitoredAction, exactMonitoringObject, monitoredActionCommandDigest,
  monitoredActionGrantDigest, observationDigest, validateBinding, validateDigest, validateGrant,
  validateObservation
} from './policy.js';
import { MonitoringRegistry } from './registry.js';
import type {
  MonitorPauseReason, MonitorState, MonitoredActionBinding, MonitoredActionGrant,
  MonitoredGrantSettlementOutcome, Observation
} from './types.js';

export interface MonitoringServiceOptions {
  workspaceId: string;
  ownerId: string;
  installationGeneration: string;
  clock?: () => string;
  random?: () => number;
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

  constructor(
    private readonly store: SqliteStore,
    readonly registry: MonitoringRegistry,
    private readonly options: MonitoringServiceOptions
  ) {
    exactMonitoringObject(options, ['workspaceId', 'ownerId', 'installationGeneration'], ['clock', 'random'],
      'monitoring service options');
    identifier(options.workspaceId, 'workspaceId'); identifier(options.ownerId, 'ownerId');
    identifier(options.installationGeneration, 'installationGeneration');
    if (options.clock !== undefined && typeof options.clock !== 'function') throw new Error('Invalid monitoring clock');
    if (options.random !== undefined && typeof options.random !== 'function') throw new Error('Invalid monitoring random source');
    this.#clock = options.clock ?? (() => new Date().toISOString());
    this.#random = options.random ?? Math.random;
  }

  proposeGrant(input: ProposeGrantInput): MonitoredActionGrant {
    exactObject(input, ['id', 'workspaceId', 'ownerId', 'adapter', 'adapterVersion', 'connectionId',
      'connectionGeneration', 'browserProfileId', 'subjectDigest', 'scope', 'maximumEffects', 'expiresAt'],
    'monitored action proposal');
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
      createdAt: now, revision: 1 };
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
    const at = this.#now();
    this.store.terminalizeMonitoredGrant(this.options.workspaceId, state.version, { type: 'monitored_action.grant_revoked', data: {
      id: grant.id, digest: grant.digest, revision: grant.revision, reason: input.reason, revokedAt: at
    } }, { actorId: input.ownerId, recordedAt: at });
    this.#abortGrantJobs(grant.id);
    return this.grant(grant.id);
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
    exactObject(input, ['ownerId', 'id', 'grantId', 'workId', 'nextDueAt', 'maxObservationAgeMs', 'intervalMs',
      'jitterMs', 'requestBudget', 'requestWindowMs', 'backoffBaseMs', 'backoffMaxMs'], 'monitor configuration');
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
    };
    this.store.append(this.options.workspaceId, state.version,
      [{ type: 'monitor.configured', data: { monitor } }], { actorId: input.ownerId, recordedAt: this.#now() });
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
    const command = this.evaluate(input.grantId, input.observation,
      { maxObservationAgeMs: input.maxObservationAgeMs, binding: input.binding });
    if (!command) throw new Error('Observation contains no eligible monitored action candidate');
    const state = this.#state(); const grant = this.#usableGrant(input.grantId, state);
    const work = required(state.works, input.workId, 'Work');
    if (['done', 'cancelled'].includes(work.phase)) throw new Error('Monitored action work is closed');
    const actionId = input.actionId ?? randomUUID(), attemptId = input.attemptId ?? randomUUID();
    identifier(actionId, 'actionId'); identifier(attemptId, 'attemptId');
    const digest = monitoredActionCommandDigest(this.options.workspaceId, work.id, work.revision, grant, command);
    const action: Action = { id: actionId, workId: work.id, key: `monitor:${grant.id}:${observationDigest(input.observation)}`,
      command, digest, workRevision: work.revision, status: 'approved',
      monitoredGrant: { id: grant.id, digest: grant.digest, revision: grant.revision } };
    const at = this.#now();
    const events: DomainEvent[] = [
      { type: 'monitored_action.command_narrowed', data: { grantId: grant.id, action } },
      { type: 'monitored_action.grant_reserved', data: { id: grant.id, digest: grant.digest, revision: grant.revision,
        actionId, attemptId, observationDigest: observationDigest(input.observation), reservedAt: at } },
      { type: 'action.started', data: { id: actionId, attemptId } }
    ];
    if (input.monitorId) events.push({ type: 'monitor.stopped', data: {
      id: input.monitorId, reason: 'grant_reserved', stoppedAt: at
    } });
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
    try { await this.#runMonitoredJob(job, currentFence); }
    finally {
      controllers.delete(controller);
      if (controllers.size === 0) this.#grantJobControllers.delete(job.parameters.grantId);
    }
  }

  async runReservedActionJob(job: ServiceJob, fence: TrustedExecutionFence): Promise<Action> {
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
    try { await executionFence.assertCurrent(); }
    catch (error) {
      if (!(error instanceof MonitoredAuthorityChangedError)) throw error;
      this.store.finishActionAttempt(this.options.workspaceId, action.id, action.attemptId, 'failed',
        'Visa execution authority changed before dispatch; no booking submission was authorized.',
        { recordedAt: this.#now() });
      this.settleGrant({ grantId: grant.id, actionId: action.id, outcome: 'failed' });
      return structuredClone(this.#state().actions[action.id]!);
    }
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
    this.store.finishActionAttempt(this.options.workspaceId, action.id, action.attemptId, status, evidence,
      { recordedAt: this.#now() });
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
          (mutation && Date.parse(this.#now()) >= Date.parse(currentGrant.expiresAt)))
        throw new MonitoredAuthorityChangedError();
      await lifecycle.assertCurrent();
    };
    return { serviceGeneration: lifecycle.serviceGeneration, deadline: lifecycle.deadline,
      signal: lifecycle.signal, assertCurrent,
      ...(lifecycle.assertSettlementCurrent
        ? { assertSettlementCurrent: () => lifecycle.assertSettlementCurrent!() } : {}) };
  }

  async #runMonitoredJob(job: ServiceJob, fence: TrustedExecutionFence): Promise<void> {
    if (job.kind !== 'monitor' || job.parameters.kind !== 'monitor' || job.status !== 'running' || !job.claim)
      throw new Error('Invalid monitor service job');
    await fence.assertCurrent();
    const state = this.#state();
    const item = required(state.monitors, job.parameters.monitorId, 'Monitor');
    if (item.inFlightJobId !== job.id || item.grantId !== job.parameters.grantId)
      throw new Error('Monitor job is no longer current');
    const grant = this.#usableGrant(item.grantId, state);
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
    this.#usableGrant(item.grantId);
    const now = this.#now();
    const event = this.#observationEvent(item, job.id, observation, now);
    this.store.completeMonitorJob(this.options.workspaceId, job.claim, event, now);
    if (observation.result === 'complete' && observation.complete && observation.candidates.length > 0) {
      const command = this.evaluate(grant.id, observation, { maxObservationAgeMs: item.maxObservationAgeMs,
        binding: this.#binding(grant) });
      if (command) this.reserve({ grantId: grant.id, workId: item.workId, observation,
        maxObservationAgeMs: item.maxObservationAgeMs, binding: this.#binding(grant), monitorId: item.id });
    }
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
