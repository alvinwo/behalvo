import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { identifier, instant, type State } from '../kernel/types.js';
import type { ModelRef } from '../model/types.js';
import type { Operator } from '../runtime/operator.js';
import type { ServiceRuntime } from '../runtime/service-runtime.js';
import { isFatalServiceStorageError, ServiceStorageError, type ServiceEnvelope, type ServiceJob,
  type ServiceReceipt } from '../storage/service-jobs.js';
import type { SqliteStore } from '../storage/sqlite-store.js';
import type { OwnerControlService } from './review-service.js';
import type { OwnerControlSessions } from './session.js';
import type { PrivateConnectionControl } from '../connections/private-connection.js';
import type { UsVisaChinaReadiness } from '../adapters/us-visa-china/types.js';
import { sanitizeUsVisaChinaReadiness, usVisaChinaDefaultReadiness } from '../adapters/us-visa-china/discovery.js';
import type { SyntheticMonitoringComposition } from '../service/synthetic-monitoring.js';
import { SYNTHETIC_MONITORING_IDS } from '../service/synthetic-monitoring.js';
import type { MonitoredActionGrant, MonitorState } from '../monitoring/types.js';
import {
  OwnerControlError,
  type ControlActionSummary,
  type ControlBinding,
  type ControlDecisionInput,
  type ControlExecutionReview,
  type ControlJobDetail,
  type ControlJobSummary,
  type ControlPrincipal,
  type ControlReminderSummary,
  type ControlServiceActionSummary,
  type ControlServiceStatus,
  type ServiceControlAdapter
} from './types.js';

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const EXECUTION_TTL = 2 * 60_000;
const MAXIMUM_CHAT_BYTES = 32 * 1024;
const ARM_TTL = 2 * 60_000;

interface Confirmation {
  principal: ControlPrincipal;
  actionId: string;
  digest: string;
  deadline: number;
  tokenDigest: Buffer;
  reserved: boolean;
}

interface ArmConfirmation {
  principal: ControlPrincipal;
  grantId: string;
  digest: string;
  revision: number;
  deadline: number;
  tokenDigest: Buffer;
  reserved: boolean;
}

export interface ServiceControlServiceOptions {
  store: SqliteStore;
  runtime: ServiceRuntime;
  reviews: OwnerControlService;
  sessions: OwnerControlSessions;
  operator: Operator;
  binding: ControlBinding;
  model?: ModelRef;
  databaseMode: 'plaintext' | 'encrypted';
  clock?: () => number;
  privateConnections?: PrivateConnectionControl;
  visaAdapterReadiness?: UsVisaChinaReadiness;
  syntheticMonitoring?: SyntheticMonitoringComposition;
}

function record(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exact(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!record(value)) throw new OwnerControlError('invalid_request');
  const keys = Object.keys(value);
  if (required.some(key => !Object.hasOwn(value, key)) ||
    keys.some(key => !required.includes(key) && !optional.includes(key)) ||
    keys.length < required.length || keys.length > required.length + optional.length)
    throw new OwnerControlError('invalid_request');
  return value;
}

function id(value: unknown, label: string): string {
  try { identifier(value, label); return value; }
  catch { throw new OwnerControlError('invalid_request'); }
}

function digest(value: unknown): string {
  if (typeof value !== 'string' || !DIGEST_PATTERN.test(value)) throw new OwnerControlError('invalid_request');
  return value;
}

function tokenDigest(value: string): Buffer {
  return createHash('sha256').update(value, 'ascii').digest();
}

function equal(left: Buffer, right: Buffer): boolean {
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}

export class ServiceControlService implements ServiceControlAdapter {
  readonly #store: SqliteStore;
  readonly #runtime: ServiceRuntime;
  readonly #reviews: OwnerControlService;
  readonly #sessions: OwnerControlSessions;
  readonly #operator: Operator;
  readonly #binding: ControlBinding;
  readonly #model: Readonly<ModelRef> | undefined;
  readonly #databaseMode: 'plaintext' | 'encrypted';
  readonly #clock: () => number;
  readonly #privateConnections: PrivateConnectionControl | undefined;
  readonly #visaAdapterReadiness: UsVisaChinaReadiness;
  readonly #confirmations = new Map<string, Confirmation>();
  readonly #armConfirmations = new Map<string, ArmConfirmation>();
  readonly #syntheticMonitoring: SyntheticMonitoringComposition | undefined;
  #closed = false;

  constructor(options: ServiceControlServiceOptions) {
    this.#store = options.store;
    this.#runtime = options.runtime;
    this.#reviews = options.reviews;
    this.#sessions = options.sessions;
    this.#operator = options.operator;
    this.#binding = Object.freeze({ ...options.binding });
    this.#model = options.model ? Object.freeze({ ...options.model }) : undefined;
    this.#databaseMode = options.databaseMode;
    this.#clock = options.clock ?? Date.now;
    this.#privateConnections = options.privateConnections;
    this.#visaAdapterReadiness = options.visaAdapterReadiness === undefined
      ? usVisaChinaDefaultReadiness() : sanitizeUsVisaChinaReadiness(options.visaAdapterReadiness);
    this.#syntheticMonitoring = options.syntheticMonitoring;
  }

  list(principal: ControlPrincipal, after?: string) {
    try {
      const page = this.#reviews.list(principal, after);
      const state = this.#state(principal);
      return { ...page, items: page.items.map(summary => this.#actionSummary(state, summary)) };
    }
    catch (error) { this.#serviceError(error); }
  }

  review(principal: ControlPrincipal, actionId: string): ControlExecutionReview {
    this.#assertPrincipal(principal);
    let review;
    try {
      const value = this.#reviews.review(principal, actionId);
      review = { ...value, action: this.#actionSummary(this.#state(principal), value.action) };
    }
    catch (error) { this.#serviceError(error); }
    const key = this.#confirmationKey(principal, actionId);
    this.#deleteConfirmation(key);
    if (review.action.status !== 'approved' || review.approvalExpiresAt === null ||
      Date.parse(review.approvalExpiresAt) <= this.#now()) return { ...review, canExecute: false };
    const executionToken = randomBytes(32).toString('base64url');
    const deadline = Math.min(this.#now() + EXECUTION_TTL, Date.parse(review.approvalExpiresAt));
    this.#confirmations.set(key, { principal, actionId, digest: review.action.digest, deadline,
      tokenDigest: tokenDigest(executionToken), reserved: false });
    return { ...review, executionToken, executionExpiresAt: new Date(deadline).toISOString(), canExecute: true };
  }

  approve(principal: ControlPrincipal, actionId: string, input: ControlDecisionInput) {
    try {
      const summary = this.#reviews.approve(principal, actionId, input);
      return this.#actionSummary(this.#state(principal), summary);
    }
    catch (error) { this.#serviceError(error); }
  }

  cancel(principal: ControlPrincipal, actionId: string, input: ControlDecisionInput) {
    this.#deleteConfirmation(this.#confirmationKey(principal, actionId));
    try {
      const summary = this.#reviews.cancel(principal, actionId, input);
      return this.#actionSummary(this.#state(principal), summary);
    }
    catch (error) { this.#serviceError(error); }
  }

  logout(principal: ControlPrincipal): void {
    this.#clearPrincipal(principal);
    this.#reviews.logout(principal);
  }

  status(principal: ControlPrincipal): ControlServiceStatus {
    const state = this.#state(principal);
    const runtime = this.#runtime.snapshot();
    let queue;
    let activeActionId: string | undefined;
    try {
      queue = this.#store.serviceQueueCounts(this.#binding.workspaceId);
      if (runtime.activeJobId) {
        const active = this.#store.serviceJob(this.#binding.workspaceId, runtime.activeJobId);
        if (active.parameters.kind === 'execute' || active.parameters.kind === 'readback')
          activeActionId = active.parameters.actionId;
      }
    } catch (error) { this.#serviceError(error); }
    const unresolvedActions: ControlServiceStatus['unresolvedActions'] = [];
    for (const action of Object.values(state.actions)) {
      if (action.status === 'running') unresolvedActions.push({ actionId: action.id, status: action.status,
        kind: action.id === activeActionId ? 'active_execution' : 'crash_preserved_execution' });
      else if (action.status === 'unknown') unresolvedActions.push({ actionId: action.id, status: action.status,
        kind: 'unknown_outcome' });
      else if (action.status === 'accepted' && action.verification?.status !== 'satisfied' &&
        action.verification?.status !== 'owner_attested') unresolvedActions.push({ actionId: action.id,
          status: action.status, kind: 'accepted_unverified' });
    }
    unresolvedActions.sort((left, right) => left.actionId.localeCompare(right.actionId));
    const unresolvedActionIds = unresolvedActions.map(action => action.actionId);
    return {
      lifecycle: runtime.faulted ? 'faulted' : runtime.accepting ? 'running' : 'stopping',
      databaseMode: this.#databaseMode,
      model: { configured: this.#model !== undefined, selection: this.#model ? { ...this.#model } : null },
      queue, runtime, unresolvedActionIds, unresolvedActions,
      connections: this.#connectionSummaries(),
      monitoredAdapters: [structuredClone(this.#visaAdapterReadiness)],
      limits: { foreground: true, awakeOnly: true, supervised: false },
      ...(this.#syntheticMonitoring ? { monitoring: { mode: 'synthetic' as const, configured: true as const,
        fixtureId: 'visa-beijing-group-v1' as const,
        installation: this.#store.monitorInstallation()?.active ? 'active' as const : 'blocked' as const,
        limitsProfile: 'synthetic-visa-one-effect-v1' as const } } : {})
    };
  }

  setupSyntheticMonitoring(principal: ControlPrincipal, input: unknown) {
    this.#state(principal); const monitoring = this.#requireSyntheticMonitoring();
    const body = exact(input, ['requestId', 'fixtureId']); id(body.requestId, 'requestId');
    if (body.fixtureId !== 'visa-beijing-group-v1') throw new OwnerControlError('invalid_request');
    try { const result = monitoring.setup(body.requestId as string); return { duplicate: result.duplicate,
      receipt: result.receipt, fixtureId: body.fixtureId,
      connectionId: SYNTHETIC_MONITORING_IDS.connectionId, workId: SYNTHETIC_MONITORING_IDS.workId }; }
    catch (error) { this.#monitoringError(error); }
  }

  grants(principal: ControlPrincipal, after?: string) {
    const state = this.#state(principal); if (!this.#syntheticMonitoring) throw new OwnerControlError('not_found');
    if (after !== undefined) id(after, 'after');
    const items = Object.values(state.monitoredActionGrants).sort((a, b) => a.id.localeCompare(b.id))
      .filter(item => after === undefined || item.id > after).slice(0, 100).map(item => this.#grantView(item));
    return { items, nextAfter: items.length === 100 ? items[99]!.id : null };
  }

  grant(principal: ControlPrincipal, grantId: string) {
    const state = this.#state(principal); this.#requireSyntheticMonitoring(); id(grantId, 'grantId');
    const grant = state.monitoredActionGrants[grantId];
    if (!grant?.armPlan) throw new OwnerControlError('not_found');
    return this.#grantView(grant);
  }

  proposeGrant(principal: ControlPrincipal, input: unknown) {
    this.#state(principal); const monitoring = this.#requireSyntheticMonitoring();
    const body = exact(input, ['requestId', 'fixtureId']); const requestId = id(body.requestId, 'requestId');
    if (body.fixtureId !== 'visa-beijing-group-v1') throw new OwnerControlError('invalid_request');
    const grantId = `synthetic-visa-grant-${createHash('sha256').update(requestId).digest('hex')}`;
    try { const proposed = monitoring.propose(requestId, grantId);
      return { duplicate: proposed.duplicate, receipt: proposed.receipt, grant: this.#grantView(proposed.grant) }; }
    catch (error) { this.#monitoringError(error); }
  }

  reviewGrant(principal: ControlPrincipal, grantId: string, input: unknown) {
    exact(input, []); const grant = this.#grantRecord(principal, grantId);
    const key = this.#armKey(principal, grantId); this.#deleteArmConfirmation(key);
    if (this.#armConfirmations.size >= 100) throw new OwnerControlError('rate_limited');
    const canArm = grant.status === 'pending' && Date.parse(grant.expiresAt) > this.#now();
    if (!canArm) return { grant: this.#grantView(grant), canArm: false };
    const armToken = randomBytes(32).toString('base64url');
    const deadline = Math.min(this.#now() + ARM_TTL, Date.parse(grant.expiresAt));
    this.#armConfirmations.set(key, { principal, grantId, digest: grant.digest, revision: grant.revision,
      deadline, tokenDigest: tokenDigest(armToken), reserved: false });
    return { grant: this.#grantView(grant), canArm: true, armToken,
      armExpiresAt: new Date(deadline).toISOString() };
  }

  armGrant(principal: ControlPrincipal, grantId: string, input: unknown) {
    this.#state(principal); const monitoring = this.#requireSyntheticMonitoring(); id(grantId, 'grantId');
    const body = exact(input, ['requestId', 'digest', 'revision', 'armToken']); id(body.requestId, 'requestId');
    const expectedDigest = digest(body.digest);
    if (!Number.isSafeInteger(body.revision) || (body.revision as number) < 1 ||
        typeof body.armToken !== 'string' || !TOKEN_PATTERN.test(body.armToken)) throw new OwnerControlError('invalid_request');
    const envelope: ServiceEnvelope = { kind: 'monitoring_arm', grantId, digest: expectedDigest,
      revision: body.revision as number };
    const existing = this.#store.findServiceReceipt({ workspaceId: this.#binding.workspaceId,
      source: 'owner:service', requestId: body.requestId as string }, envelope);
    if (existing) {
      const state = this.#store.state(this.#binding.workspaceId); const current = state.monitoredActionGrants[grantId];
      const monitor = current?.armPlan ? state.monitors[current.armPlan.monitorId] : undefined;
      if (!current || !monitor) throw new ServiceStorageError('integrity', 'Monitoring arm receipt is inconsistent.');
      return { duplicate: true, receipt: existing, grant: this.#grantView(current), monitor: this.#monitorView(monitor) };
    }
    const key = this.#armKey(principal, grantId); const confirmation = this.#armConfirmations.get(key);
    const supplied = tokenDigest(body.armToken);
    if (!confirmation || confirmation.reserved || confirmation.principal !== principal ||
        confirmation.digest !== expectedDigest || confirmation.revision !== body.revision ||
        this.#now() >= confirmation.deadline || !equal(supplied, confirmation.tokenDigest))
      throw new OwnerControlError('conflict');
    confirmation.reserved = true;
    try {
      const result = monitoring.arm(body.requestId as string, grantId, expectedDigest, body.revision as number, () => {
        if (this.#closed || !confirmation.reserved || confirmation.principal !== principal ||
            this.#now() >= confirmation.deadline || !equal(supplied, confirmation.tokenDigest))
          throw new OwnerControlError('conflict');
      });
      this.#deleteArmConfirmation(key);
      return { duplicate: result.duplicate, receipt: result.receipt,
        grant: this.#grantView(result.grant), monitor: this.#monitorView(result.monitor) };
    } catch (error) { confirmation.reserved = false; this.#monitoringError(error); }
  }

  revokeGrant(principal: ControlPrincipal, grantId: string, input: unknown) {
    const grant = this.#grantRecord(principal, grantId); const body = exact(input, ['requestId', 'digest', 'revision']);
    const requestId = id(body.requestId, 'requestId'); if (digest(body.digest) !== grant.digest || body.revision !== grant.revision)
      throw new OwnerControlError('conflict');
    try { const value = this.#requireSyntheticMonitoring().service.revokeGrantForOwner({ ownerId: principal.ownerId,
      source: 'owner:service', requestId, grantId, digest: grant.digest, revision: grant.revision,
      kind: 'monitoring_revoke' });
      return { grant: this.#grantView(value.grant), receipt: value.receipt, duplicate: value.duplicate }; }
    catch (error) { this.#monitoringError(error); }
  }

  monitors(principal: ControlPrincipal, after?: string) {
    const state = this.#state(principal); this.#requireSyntheticMonitoring(); if (after !== undefined) id(after, 'after');
    const items = Object.values(state.monitors).sort((a, b) => a.id.localeCompare(b.id))
      .filter(item => after === undefined || item.id > after).slice(0, 100).map(item => this.#monitorView(item));
    return { items, nextAfter: items.length === 100 ? items[99]!.id : null };
  }

  monitor(principal: ControlPrincipal, monitorId: string) {
    const state = this.#state(principal); this.#requireSyntheticMonitoring(); id(monitorId, 'monitorId');
    const monitor = state.monitors[monitorId]; if (!monitor) throw new OwnerControlError('not_found');
    return this.#monitorView(monitor);
  }

  async pauseMonitor(principal: ControlPrincipal, monitorId: string, input: unknown) {
    return this.#pauseMonitor(principal, monitorId, input, 'owner_paused');
  }
  async takeoverMonitor(principal: ControlPrincipal, monitorId: string, input: unknown) {
    return this.#pauseMonitor(principal, monitorId, input, 'owner_takeover');
  }
  resumeMonitor(principal: ControlPrincipal, monitorId: string, input: unknown) {
    const monitor = this.#monitorRecord(principal, monitorId);
    const body = exact(input, ['requestId', 'digest', 'revision', 'controlRevision', 'recoverHandoff']);
    const requestId = id(body.requestId, 'requestId'); const expectedDigest = digest(body.digest);
    if (!Number.isSafeInteger(body.revision) || (body.revision as number) < 1 ||
        !Number.isSafeInteger(body.controlRevision) || (body.controlRevision as number) < 0 ||
        typeof body.recoverHandoff !== 'boolean') throw new OwnerControlError('invalid_request');
    const envelope: Extract<ServiceEnvelope, { kind: 'monitor'; purpose: 'resume' }> = { kind: 'monitor',
      purpose: 'resume', monitorId, grantId: monitor.grantId, digest: expectedDigest,
      revision: body.revision as number, controlRevision: body.controlRevision as number,
      recoverHandoff: body.recoverHandoff };
    const identity = { workspaceId: this.#binding.workspaceId, source: 'owner:service', requestId };
    try {
      const receipt = this.#store.findServiceReceipt(identity, envelope);
      if (receipt?.jobId) return { receipt,
        job: this.#jobSummary(this.#store.serviceJob(this.#binding.workspaceId, receipt.jobId), receipt), duplicate: true };
      const installationGeneration = this.#requireSyntheticMonitoring().binding.installationGeneration;
      const admitted = this.#runtime.admitMonitorResume({ requestId, monitorId, grantId: monitor.grantId,
        digest: expectedDigest, revision: body.revision as number,
        controlRevision: body.controlRevision as number, recoverHandoff: body.recoverHandoff as boolean,
        installationGeneration });
      void this.#runtime.drain().catch(() => {});
      return { ...admitted, job: this.#jobSummary(admitted.job, admitted.receipt) };
    } catch (error) { this.#serviceError(error); }
  }
  stopMonitor(principal: ControlPrincipal, monitorId: string, input: unknown) {
    const monitor = this.#monitorRecord(principal, monitorId);
    const grant = this.#grantRecord(principal, monitor.grantId);
    const body = exact(input, ['requestId', 'digest', 'revision', 'controlRevision']);
    const requestId = id(body.requestId, 'requestId'); const expectedDigest = digest(body.digest);
    if (!Number.isSafeInteger(body.revision) || (body.revision as number) < 1 ||
        !Number.isSafeInteger(body.controlRevision) || (body.controlRevision as number) < 0)
      throw new OwnerControlError('invalid_request');
    try {
      const value = this.#requireSyntheticMonitoring().service.revokeGrantForOwner({ ownerId: principal.ownerId,
        source: 'owner:service', requestId, grantId: grant.id, monitorId, digest: expectedDigest,
        revision: body.revision as number, controlRevision: body.controlRevision as number, kind: 'monitoring_stop' });
      return { grant: this.#grantView(value.grant), receipt: value.receipt, duplicate: value.duplicate };
    } catch (error) { this.#monitoringError(error); }
  }

  async disconnectConnection(principal: ControlPrincipal, connectionId: string, input: unknown) {
    this.#state(principal);
    id(connectionId, 'connectionId');
    const body = exact(input, ['deletePurposes']);
    if (!Array.isArray(body.deletePurposes) || body.deletePurposes.some(value => typeof value !== 'string'))
      throw new OwnerControlError('invalid_request');
    const purposes = [...new Set(body.deletePurposes.map(value => id(value, 'purpose')))];
    const connection = this.#connectionSummaries().find(item => item.id === connectionId);
    if (!connection) throw new OwnerControlError('not_found');
    if (purposes.some(purpose => !connection.secretPurposes.includes(purpose)))
      throw new OwnerControlError('invalid_request');
    try {
      const result = await this.#privateConnections!.disconnect({ connectionId, deletePurposes: purposes });
      if (!result || result.connectionId !== connectionId || result.state !== 'disconnected' ||
          result.profileRemovalOffered !== true || typeof result.profilePath !== 'string' ||
          !Array.isArray(result.deletedPurposes) || result.deletedPurposes.some(value => typeof value !== 'string'))
        throw new Error();
      return { connectionId, state: 'disconnected' as const, profileRemovalOffered: true as const,
        profilePath: result.profilePath, deletedPurposes: result.deletedPurposes.map(value => id(value, 'purpose')) };
    }
    catch { throw new OwnerControlError('unavailable'); }
  }

  jobs(principal: ControlPrincipal, after = 0) {
    this.#state(principal);
    try {
      const page = this.#store.serviceJobs(this.#binding.workspaceId, after);
      return { items: page.items.map(job => this.#jobSummary(job, this.#store.serviceJobReceipt(
        this.#binding.workspaceId, job.id))), nextAfter: page.nextAfter };
    }
    catch (error) { this.#serviceError(error); }
  }

  job(principal: ControlPrincipal, jobId: string) {
    this.#state(principal);
    id(jobId, 'jobId');
    try {
      const job = this.#store.serviceJob(this.#binding.workspaceId, jobId);
      const receipt = this.#store.serviceJobReceipt(this.#binding.workspaceId, jobId);
      return this.#jobDetail(job, receipt);
    }
    catch (error) {
      if (error instanceof ServiceStorageError && error.code === 'invalid') throw new OwnerControlError('not_found');
      this.#serviceError(error);
    }
  }

  reminders(principal: ControlPrincipal, after = 0) {
    const state = this.#state(principal);
    try {
      const page = this.#store.serviceReminderRequests(this.#binding.workspaceId, after);
      return { items: page.items.map(request => this.#reminderSummary(state, request)), nextAfter: page.nextAfter };
    } catch (error) { this.#serviceError(error); }
  }

  chat(principal: ControlPrincipal, input: unknown) {
    this.#assertPrincipal(principal);
    const body = exact(input, ['requestId', 'threadId', 'text'], ['workId']);
    const requestId = id(body.requestId, 'requestId');
    const submittedThreadId = id(body.threadId, 'threadId');
    const text = body.text;
    if (typeof text !== 'string' || text.trim().length === 0 || Buffer.byteLength(text, 'utf8') > MAXIMUM_CHAT_BYTES)
      throw new OwnerControlError('invalid_request');
    const submittedWorkId = body.workId === undefined ? undefined : id(body.workId, 'workId');
    const envelope: ServiceEnvelope = { kind: 'owner_turn', threadId: submittedThreadId,
      ...(submittedWorkId ? { workId: submittedWorkId } : {}), text };
    try {
      const receipt = this.#store.findServiceReceipt({ workspaceId: this.#binding.workspaceId,
        source: 'owner:service', requestId }, envelope);
      if (receipt) {
        if (!receipt.jobId) throw new ServiceStorageError('integrity', 'Service owner receipt has no job.');
        return { receipt, job: this.#jobSummary(this.#store.serviceJob(this.#binding.workspaceId, receipt.jobId), receipt),
          duplicate: true };
      }
    } catch (error) { this.#serviceError(error); }
    const state = this.#state(principal);
    if (!this.#model) throw new OwnerControlError('unavailable');
    let threadId = submittedThreadId;
    if (submittedWorkId) {
      const work = state.works[submittedWorkId];
      if (!work || ['done', 'cancelled'].includes(work.phase)) throw new OwnerControlError('not_found');
      threadId = work.threadIds[0] ?? submittedThreadId;
      if (work.threadIds.length === 0) {
        try { this.#operator.linkThread(this.#binding.workspaceId, this.#binding.ownerId, work.id, threadId); }
        catch { throw new OwnerControlError('conflict'); }
      }
    }
    try {
      const admitted = this.#runtime.admitOwnerTurn({ requestId, threadId,
        ...(submittedWorkId ? { workId: submittedWorkId } : {}),
        text, model: this.#model, submitted: { threadId: submittedThreadId,
          ...(submittedWorkId ? { workId: submittedWorkId } : {}) } });
      return { ...admitted, job: this.#jobSummary(admitted.job, admitted.receipt) };
    } catch (error) { this.#serviceError(error); }
  }

  reminder(principal: ControlPrincipal, input: unknown) {
    this.#assertPrincipal(principal);
    const body = exact(input, ['requestId', 'workId', 'dueAt']);
    const requestId = id(body.requestId, 'requestId');
    const workId = id(body.workId, 'workId');
    try { instant(body.dueAt); }
    catch { throw new OwnerControlError('invalid_request'); }
    const dueAt = body.dueAt as string;
    const envelope: ServiceEnvelope = { kind: 'schedule_reminder', workId, dueAt };
    try {
      const receipt = this.#store.findServiceReceipt({ workspaceId: this.#binding.workspaceId,
        source: 'owner:service', requestId }, envelope);
      if (receipt) return { receipt, duplicate: true };
    } catch (error) { this.#serviceError(error); }
    this.#state(principal);
    if (Date.parse(dueAt) <= this.#clock()) throw new OwnerControlError('invalid_request');
    try { return this.#runtime.scheduleReminder({ requestId, timerId: randomUUID(), workId, dueAt }); }
    catch (error) { this.#serviceError(error); }
  }

  execute(principal: ControlPrincipal, actionId: string, input: unknown) {
    this.#state(principal);
    id(actionId, 'actionId');
    const body = exact(input, ['requestId', 'digest', 'confirmationToken']);
    const requestId = id(body.requestId, 'requestId');
    const actionDigest = digest(body.digest);
    if (typeof body.confirmationToken !== 'string' || !TOKEN_PATTERN.test(body.confirmationToken))
      throw new OwnerControlError('invalid_request');
    const envelope: ServiceEnvelope = { kind: 'execute', actionId, digest: actionDigest };
    const identity = { workspaceId: this.#binding.workspaceId, source: 'owner:service', requestId };
    try {
      const receipt = this.#store.findServiceReceipt(identity, envelope);
      if (receipt?.jobId) return { receipt,
        job: this.#jobSummary(this.#store.serviceJob(this.#binding.workspaceId, receipt.jobId), receipt), duplicate: true };
    } catch (error) { this.#serviceError(error); }

    const key = this.#confirmationKey(principal, actionId);
    const confirmation = this.#confirmations.get(key);
    const supplied = tokenDigest(body.confirmationToken);
    if (!confirmation || confirmation.reserved || confirmation.principal !== principal ||
      confirmation.actionId !== actionId || confirmation.digest !== actionDigest || this.#now() >= confirmation.deadline ||
      !equal(supplied, confirmation.tokenDigest)) {
      if (confirmation && this.#now() >= confirmation.deadline) this.#deleteConfirmation(key);
      throw new OwnerControlError('conflict');
    }
    confirmation.reserved = true;
    try {
      const admitted = this.#runtime.admitAction({ requestId, kind: 'execute', actionId, digest: actionDigest });
      this.#deleteConfirmation(key);
      return { ...admitted, job: this.#jobSummary(admitted.job, admitted.receipt) };
    } catch (error) {
      confirmation.reserved = false;
      this.#serviceError(error);
    }
  }

  readback(principal: ControlPrincipal, actionId: string, input: unknown) {
    this.#state(principal);
    id(actionId, 'actionId');
    const body = exact(input, ['requestId', 'digest']);
    try {
      const admitted = this.#runtime.admitAction({ requestId: id(body.requestId, 'requestId'), kind: 'readback',
        actionId, digest: digest(body.digest) });
      return { ...admitted, job: this.#jobSummary(admitted.job, admitted.receipt) };
    }
    catch (error) { this.#serviceError(error); }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const key of [...this.#confirmations.keys()]) this.#deleteConfirmation(key);
    for (const key of [...this.#armConfirmations.keys()]) this.#deleteArmConfirmation(key);
  }

  #requireSyntheticMonitoring(): SyntheticMonitoringComposition {
    if (!this.#syntheticMonitoring) throw new OwnerControlError('not_found');
    return this.#syntheticMonitoring;
  }

  #grantRecord(principal: ControlPrincipal, grantId: string): MonitoredActionGrant {
    const state = this.#state(principal); this.#requireSyntheticMonitoring(); id(grantId, 'grantId');
    const grant = state.monitoredActionGrants[grantId];
    if (!grant?.armPlan) throw new OwnerControlError('not_found');
    return grant;
  }

  #monitorRecord(principal: ControlPrincipal, monitorId: string): MonitorState {
    const state = this.#state(principal); this.#requireSyntheticMonitoring(); id(monitorId, 'monitorId');
    const monitor = state.monitors[monitorId]; if (!monitor) throw new OwnerControlError('not_found');
    return monitor;
  }

  #grantView(grant: MonitoredActionGrant) {
    return { id: grant.id, digest: grant.digest, revision: grant.revision, status: grant.status,
      adapter: grant.adapter, adapterVersion: grant.adapterVersion, connectionId: grant.connectionId,
      connectionGeneration: grant.connectionGeneration, browserProfileId: grant.browserProfileId,
      subjectDigest: grant.subjectDigest, scope: structuredClone(grant.scope), maximumEffects: grant.maximumEffects,
      expiresAt: grant.expiresAt, armPlan: grant.armPlan ? structuredClone(grant.armPlan) : null,
      allowance: { reservedActionId: grant.reservedActionId ?? null,
        settlement: grant.settlement ? structuredClone(grant.settlement) : null },
      revokedAt: grant.revokedAt ?? null };
  }

  #monitorView(monitor: MonitorState) {
    const state = this.#store.state(this.#binding.workspaceId);
    const grant = state.monitoredActionGrants[monitor.grantId];
    const action = grant?.reservedActionId ? state.actions[grant.reservedActionId] : undefined;
    return { id: monitor.id, grantId: monitor.grantId, workId: monitor.workId, status: monitor.status,
      nextDueAt: monitor.nextDueAt, pauseReason: monitor.pauseReason, inFlightJobId: monitor.inFlightJobId,
      polling: { maxObservationAgeMs: monitor.maxObservationAgeMs, intervalMs: monitor.intervalMs,
        jitterMs: monitor.jitterMs, requestBudget: monitor.requestBudget, requestWindowMs: monitor.requestWindowMs,
        backoffBaseMs: monitor.backoffBaseMs, backoffMaxMs: monitor.backoffMaxMs },
      requestsInWindow: monitor.requestsInWindow, requestWindowStartedAt: monitor.requestWindowStartedAt,
      lastObservation: monitor.lastObservation ? structuredClone(monitor.lastObservation) : null,
      controlRevision: monitor.control?.revision ?? null,
      handoff: monitor.control?.handoff ? { id: monitor.control.handoff.id,
        state: monitor.control.handoff.state } : null,
      resume: monitor.control?.resume ? { jobId: monitor.control.resume.jobId,
        state: monitor.control.resume.candidate ? 'resuming' as const : 'queued' as const } : null,
      action: action ? { id: action.id, digest: action.digest, status: action.status,
        readbackEligible: ['accepted', 'unknown'].includes(action.status) } : null,
      limits: { foreground: true as const, awakeOnly: true as const, supervised: false as const } };
  }

  async #pauseMonitor(principal: ControlPrincipal, monitorId: string, input: unknown,
    reason: 'owner_paused' | 'owner_takeover') {
    const current = this.#monitorRecord(principal, monitorId);
    const body = exact(input, ['requestId', 'digest', 'revision', 'controlRevision']);
    id(body.requestId, 'requestId'); const expectedDigest = digest(body.digest);
    if (!Number.isSafeInteger(body.revision) || (body.revision as number) < 1 ||
        !Number.isSafeInteger(body.controlRevision) || (body.controlRevision as number) < 0)
      throw new OwnerControlError('invalid_request');
    const monitoring = this.#requireSyntheticMonitoring();
    const binding = current.control?.resume?.candidate ? { ...current.control.resume.candidate } :
      current.status === 'paused' && current.control?.handoff ? { ...current.control.handoff.binding } :
      { ...monitoring.session.epoch, tabId: monitoring.session.tabId };
    try {
      const paused = monitoring.service.pauseMonitorForOwner({ ownerId: principal.ownerId,
        source: 'owner:service', requestId: body.requestId as string, monitorId,
        digest: expectedDigest, revision: body.revision as number,
        controlRevision: body.controlRevision as number, reason,
        binding });
      if (paused.duplicate) return { monitor: this.#monitorView(paused.monitor), receipt: paused.receipt, duplicate: true };
      const handoffId = paused.monitor.control?.handoff?.id;
      if (!handoffId) throw new Error('Monitor handoff was not recorded.');
      try {
        await monitoring.session.transferToHuman(reason);
        const settled = monitoring.service.settleMonitorHandoff({ monitorId, handoffId, state: 'confirmed' });
        return { monitor: this.#monitorView(settled), receipt: paused.receipt, duplicate: false };
      } catch (error) {
        const settled = monitoring.service.settleMonitorHandoff({ monitorId, handoffId, state: 'failed' });
        return { monitor: this.#monitorView(settled), receipt: paused.receipt,
          duplicate: false, unavailable: true as const };
      }
    } catch (error) { this.#monitoringError(error); }
  }

  #monitoringError(error: unknown): never {
    if (error instanceof OwnerControlError) throw error;
    if (isFatalServiceStorageError(error)) this.#serviceError(error);
    throw new OwnerControlError('conflict');
  }

  #armKey(principal: ControlPrincipal, grantId: string): string {
    return `${principal.sessionId}\u0000${grantId}`;
  }

  #deleteArmConfirmation(key: string): void {
    const confirmation = this.#armConfirmations.get(key); if (!confirmation) return;
    this.#armConfirmations.delete(key); confirmation.tokenDigest.fill(0);
  }

  #connectionSummaries() {
    if (!this.#privateConnections) return [];
    try {
      const values = this.#privateConnections.list();
      if (!Array.isArray(values)) throw new Error();
      return values.map(value => {
        if (!value || !Number.isSafeInteger(value.generation) || value.generation < 1 ||
            (value.mode !== 'synthetic' && value.mode !== 'live') ||
            !['connected', 'disconnecting', 'disconnect_failed', 'disconnected'].includes(value.state) ||
            !Array.isArray(value.secretPurposes)) throw new Error();
        return { id: id(value.id, 'connectionId'), service: id(value.service, 'service'),
          generation: value.generation, profileId: id(value.profileId, 'profileId'), mode: value.mode,
          state: value.state, secretPurposes: value.secretPurposes.map(purpose => id(purpose, 'purpose')).sort() };
      });
    }
    catch { throw new OwnerControlError('unavailable'); }
  }

  #state(principal: ControlPrincipal): State {
    this.#assertPrincipal(principal);
    try {
      const state = this.#store.state(this.#binding.workspaceId);
      if (state.ownerId !== this.#binding.ownerId) throw new OwnerControlError('forbidden');
      return state;
    } catch (error) { this.#serviceError(error); }
  }

  #jobSummary(job: ServiceJob, receipt: ServiceReceipt): ControlJobSummary {
    if (receipt.jobId !== job.id || receipt.id !== job.receiptId || receipt.workspaceId !== this.#binding.workspaceId)
      throw new ServiceStorageError('integrity', 'Service job receipt does not match its job.');
    const focus = job.parameters.kind === 'owner_turn'
      ? { threadId: job.parameters.threadId, workId: job.parameters.workId ?? null } : null;
    const actionId = job.parameters.kind === 'execute' || job.parameters.kind === 'readback'
      ? job.parameters.actionId : null;
    let monitoring: ControlJobSummary['monitoring'];
    if (job.parameters.kind === 'monitor') {
      let resumeReason: NonNullable<ControlJobSummary['monitoring']>['resumeReason'] = null;
      let resumeEvidence: NonNullable<ControlJobSummary['monitoring']>['resumeEvidence'] = null;
      if (job.parameters.purpose === 'resume' && job.result) {
        const record = job.result.recordIds.map(recordId => this.#store.record(this.#binding.workspaceId, recordId))
          .find(item => item.event.type === 'monitor.resume_finished');
        if (record?.event.type === 'monitor.resume_finished') {
          resumeReason = record.event.data.reason;
          resumeEvidence = record.event.data.evidence ? structuredClone(record.event.data.evidence) : null;
        }
      }
      monitoring = { monitorId: job.parameters.monitorId,
        purpose: job.parameters.purpose === 'resume' ? 'resume' : 'observe', resumeReason, resumeEvidence };
    }
    return {
      id: job.id, position: job.position, requestId: receipt.requestId, kind: job.kind, status: job.status,
      admittedAt: job.admittedAt, startedAt: job.startedAt ?? null, finishedAt: job.finishedAt ?? null,
      focus, actionId, resultReason: job.result?.reason ?? null, ...(monitoring ? { monitoring } : {})
    };
  }

  #actionSummary(state: State, summary: ControlActionSummary): ControlServiceActionSummary {
    const action = state.actions[summary.actionId];
    if (!action || action.digest !== summary.digest) throw new ServiceStorageError('integrity',
      'Control action summary does not match durable state.');
    return { ...summary,
      outcome: { status: action.status, evidenceRef: action.evidenceRef ?? null },
      verification: action.verification ? {
        status: action.verification.status, recordedAt: action.verification.recordedAt,
        evidenceRef: action.verification.status === 'owner_attested' ? action.verification.evidenceRef : null
      } : null };
  }

  #jobDetail(job: ServiceJob, receipt: ServiceReceipt): ControlJobDetail {
    const summary = this.#jobSummary(job, receipt);
    if (!job.result) return { ...summary, result: null };
    const result: ControlJobDetail['result'] = { reason: job.result.reason };
    try {
      if (job.parameters.kind === 'owner_turn' && job.result.assistantRecordId) {
        const owner = this.#store.record(this.#binding.workspaceId, job.parameters.ownerRecordId);
        const assistant = this.#store.record(this.#binding.workspaceId, job.result.assistantRecordId);
        if (owner.event.type !== 'message.received' || owner.event.data.senderRole !== 'owner' ||
          owner.event.data.externalId !== receipt.requestId || owner.event.data.threadId !== job.parameters.threadId ||
          assistant.event.type !== 'message.received' || assistant.event.data.senderRole !== 'agent' ||
          assistant.event.data.threadId !== job.parameters.threadId || !job.result.recordIds.includes(assistant.id))
          throw new Error('Invalid conversation result provenance.');
        result.conversation = { threadId: job.parameters.threadId,
          ownerText: this.#store.readArtifact(this.#binding.workspaceId, owner.event.data.artifactId),
          assistantText: this.#store.readArtifact(this.#binding.workspaceId, assistant.event.data.artifactId) };
        result.works = job.result.recordIds.map(recordId => this.#store.record(this.#binding.workspaceId, recordId))
          .filter(record => record.event.type === 'work.created')
          .map(record => {
            if (record.event.type !== 'work.created') throw new Error('Invalid work result provenance.');
            return { id: record.event.data.id, title: record.event.data.title,
              goal: record.event.data.goal, phase: 'open' as const };
          });
      }
      if ((job.parameters.kind === 'execute' || job.parameters.kind === 'readback') && job.result.actionId) {
        if (job.result.actionId !== job.parameters.actionId) throw new Error('Invalid action result provenance.');
        const state = this.#store.state(this.#binding.workspaceId);
        const action = state.actions[job.parameters.actionId];
        if (!action || action.digest !== job.parameters.digest) throw new Error('Invalid action result binding.');
        if (!job.result.actionRecordId || !job.result.attemptId ||
          (job.kind === 'readback' && job.actionRecordId !== job.result.actionRecordId))
          throw new Error('Missing action outcome provenance.');
        const record = this.#store.record(this.#binding.workspaceId, job.result.actionRecordId);
        if (!job.result.recordIds.includes(record.id) || record.event.type !== 'action.finished' ||
          record.event.data.id !== action.id || record.event.data.attemptId !== job.result.attemptId)
          throw new Error('Invalid action outcome provenance.');
        const outcomeStatus = record.event.data.status;
        const outcomeEvidenceRef = record.event.data.evidenceRef;
        const outcomeEvidence = outcomeEvidenceRef
          ? this.#store.readArtifact(this.#binding.workspaceId, outcomeEvidenceRef) : null;
        let verification: NonNullable<NonNullable<ControlJobDetail['result']>['action']>['verification'] = null;
        if (job.result.verificationRecordId) {
          const record = this.#store.record(this.#binding.workspaceId, job.result.verificationRecordId);
          if (!job.result.recordIds.includes(record.id) || record.event.type !== 'action.verification_recorded' ||
            record.event.data.id !== action.id) throw new Error('Invalid verification result provenance.');
          const value = record.event.data.verification;
          const evidenceRef = value.status === 'owner_attested' ? value.evidenceRef : null;
          verification = { status: value.status, recordedAt: value.recordedAt, evidenceRef,
            evidence: evidenceRef ? this.#store.readArtifact(this.#binding.workspaceId, evidenceRef) : null };
        }
        result.action = { actionId: action.id,
          outcome: { status: outcomeStatus, evidenceRef: outcomeEvidenceRef, evidence: outcomeEvidence },
          verification };
      }
      if (job.parameters.kind === 'reminder') {
        if (job.result.timerId !== job.parameters.timerId || !job.result.recordIds.includes(job.parameters.timerRecordId))
          throw new Error('Invalid reminder result provenance.');
        const request = this.#store.serviceReminderRequest(this.#binding.workspaceId, job.parameters.timerId);
        if (!request) throw new Error('Reminder scheduling record is missing.');
        result.reminder = this.#reminderSummary(this.#store.state(this.#binding.workspaceId), request);
      }
      return { ...summary, result };
    } catch (error) {
      if (isFatalServiceStorageError(error)) throw error;
      throw new ServiceStorageError('integrity', 'Invalid service job result projection.');
    }
  }

  #reminderSummary(state: State, request: ReturnType<SqliteStore['serviceReminderRequests']>['items'][number]): ControlReminderSummary {
    if (request.receipt && (request.receipt.workspaceId !== this.#binding.workspaceId || request.receipt.source !== 'owner:service' ||
      request.receipt.kind !== 'schedule_reminder' || request.receipt.timerId !== request.timerId))
      throw new ServiceStorageError('integrity', 'Reminder request is not owner scoped.');
    const timer = state.timers[request.timerId];
    const work = state.works[request.workId];
    if (!timer || !work || timer.workId !== work.id || timer.dueAt !== request.dueAt)
      throw new ServiceStorageError('integrity', 'Reminder projection does not match durable state.');
    return { timerId: timer.id, requestId: request.receipt?.requestId ?? null, admittedAt: request.receipt?.admittedAt ?? null,
      work: { id: work.id, title: work.title }, dueAt: timer.dueAt, status: timer.status };
  }

  #serviceError(error: unknown): never {
    if (isFatalServiceStorageError(error)) {
      this.#runtime.reportStorageError(error);
      throw new OwnerControlError('unavailable');
    }
    if (error instanceof OwnerControlError) throw error;
    if (error instanceof ServiceStorageError) {
      if (error.code === 'conflict') throw new OwnerControlError('conflict');
      if (error.code === 'full') throw new OwnerControlError('rate_limited');
      if (error.code === 'invalid') throw new OwnerControlError('invalid_request');
      throw new OwnerControlError('unavailable');
    }
    throw error;
  }

  #assertPrincipal(principal: ControlPrincipal): void {
    if (this.#closed) throw new OwnerControlError('unavailable');
    this.#sessions.assertActive(principal);
    if (principal.workspaceId !== this.#binding.workspaceId || principal.ownerId !== this.#binding.ownerId ||
      principal.instanceId !== this.#sessions.instanceId) throw new OwnerControlError('forbidden');
  }

  #confirmationKey(principal: ControlPrincipal, actionId: string): string {
    return `${principal.sessionId}\u0000${actionId}`;
  }

  #clearPrincipal(principal: ControlPrincipal): void {
    for (const [key, confirmation] of this.#confirmations) {
      if (confirmation.principal === principal) this.#deleteConfirmation(key);
    }
    for (const [key, confirmation] of this.#armConfirmations) {
      if (confirmation.principal === principal) this.#deleteArmConfirmation(key);
    }
  }

  #deleteConfirmation(key: string): void {
    const confirmation = this.#confirmations.get(key);
    if (!confirmation) return;
    this.#confirmations.delete(key);
    confirmation.tokenDigest.fill(0);
  }

  #now(): number {
    const value = this.#clock();
    if (!Number.isFinite(value)) throw new OwnerControlError('unavailable');
    return value;
  }
}
