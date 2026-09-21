import type { ModelRef } from '../model/types.js';
import { executionDeadlineReached, OperationDeadlineError, OperationStoppedError,
  type OperationExecutionContext, type TrustedExecutionFence } from '../operations/execution-context.js';
import type { OperationService } from '../operations/service.js';
import { isFatalServiceStorageError, ServiceStorageError, type ServiceJob, type ServiceJobResult } from '../storage/service-jobs.js';
import type { SqliteStore } from '../storage/sqlite-store.js';
import type { AgentService } from './agent-service.js';

export type { TrustedExecutionFence } from '../operations/execution-context.js';

export interface ServiceRuntimeSnapshot {
  accepting: boolean;
  faulted: boolean;
  activeJobId: string | null;
  activeStartedAt: string | null;
  lastSchedulerPollAt: string | null;
  nextDueAt: string | null;
}

export interface ServiceRuntimeOptions {
  workspaceId: string;
  ownerId: string;
  instanceId: string;
  serviceGeneration: string;
  clock?: () => string;
  timeoutMs?: number;
  schedulerIntervalMs?: number;
}

export interface AdmitOwnerTurnInput {
  requestId: string;
  threadId: string;
  text: string;
  model: ModelRef;
  workId?: string;
  windowTokens?: number;
  outputReserve?: number;
  submitted?: { threadId: string; workId?: string };
}

export class ServiceRuntime {
  readonly #clock: () => string;
  readonly #timeoutMs: number;
  readonly #schedulerIntervalMs: number;
  #accepting = true;
  #faulted = false;
  #fatalError: unknown;
  #activeJobId: string | null = null;
  #activeStartedAt: string | null = null;
  #lastSchedulerPollAt: string | null = null;
  #nextDueAt: string | null = null;
  #activeController: AbortController | undefined;
  #draining: Promise<void> | undefined;
  #ticking: Promise<void> | undefined;
  #timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly store: SqliteStore,
    private readonly agent: AgentService,
    private readonly operations: OperationService,
    private readonly options: ServiceRuntimeOptions
  ) {
    this.#clock = options.clock ?? (() => new Date().toISOString());
    this.#timeoutMs = this.#lowerLimit(options.timeoutMs, 120000);
    this.#schedulerIntervalMs = this.#lowerLimit(options.schedulerIntervalMs, 1000);
    this.#refreshNextDue();
  }

  snapshot(): ServiceRuntimeSnapshot {
    return { accepting: this.#accepting, faulted: this.#faulted, activeJobId: this.#activeJobId,
      activeStartedAt: this.#activeStartedAt, lastSchedulerPollAt: this.#lastSchedulerPollAt,
      nextDueAt: this.#nextDueAt };
  }

  reportStorageError(error: unknown): void {
    if (isFatalServiceStorageError(error)) this.#fault(error);
  }

  start(): void {
    if (this.#timer || !this.#accepting) return;
    try {
      this.store.inspectInterruptedServiceJobs(this.options.workspaceId, this.#clock());
    } catch (error) {
      this.#rethrowIfFatal(error);
      throw error;
    }
    void this.tick().catch(() => {});
    void this.drain().catch(() => {});
    this.#timer = setInterval(() => { void this.tick().catch(() => {}); }, this.#schedulerIntervalMs);
    this.#timer.unref?.();
  }

  admitOwnerTurn(input: AdmitOwnerTurnInput) {
    const submitted = input.submitted ?? { threadId: input.threadId,
      ...(input.workId ? { workId: input.workId } : {}) };
    return this.#admit(() => this.store.admitOwnerTurnJob({
      workspaceId: this.options.workspaceId, source: 'owner:service', requestId: input.requestId,
      ownerId: this.options.ownerId,
      envelope: { kind: 'owner_turn', threadId: submitted.threadId,
        ...(submitted.workId ? { workId: submitted.workId } : {}), text: input.text },
      accepted: { threadId: input.threadId, ...(input.workId ? { workId: input.workId } : {}),
        model: input.model, windowTokens: input.windowTokens ?? 64000,
        outputReserve: input.outputReserve ?? 8000, capability: 'prepare_only' },
      instanceId: this.options.instanceId, at: this.#clock()
    }));
  }

  admitAction(input: { requestId: string; kind: 'execute' | 'readback'; actionId: string; digest: string }) {
    return this.#admit(() => this.store.admitActionJob({
      workspaceId: this.options.workspaceId, source: 'owner:service', requestId: input.requestId,
      ownerId: this.options.ownerId, envelope: { kind: input.kind, actionId: input.actionId, digest: input.digest },
      instanceId: this.options.instanceId, at: this.#clock()
    }));
  }

  scheduleReminder(input: { requestId: string; timerId: string; workId: string; dueAt: string }) {
    const result = this.#admit(() => this.store.scheduleServiceReminder({
      workspaceId: this.options.workspaceId, source: 'owner:service', requestId: input.requestId,
      ownerId: this.options.ownerId, envelope: { kind: 'schedule_reminder', workId: input.workId, dueAt: input.dueAt },
      timerId: input.timerId, at: this.#clock()
    }));
    this.#refreshNextDue();
    return result;
  }

  drain(): Promise<void> {
    if (this.#draining) return this.#draining;
    if (this.#faulted) return Promise.reject(this.#fatalError ??
      new ServiceStorageError('integrity', 'Service runtime storage is unavailable.'));
    const running = this.#drainJobs();
    this.#draining = running.finally(() => { this.#draining = undefined; });
    return this.#draining;
  }

  tick(): Promise<void> {
    if (this.#ticking) return this.#ticking;
    if (!this.#accepting || this.#faulted) return Promise.resolve();
    const running = this.#tickTimers();
    this.#ticking = running.finally(() => { this.#ticking = undefined; });
    return this.#ticking;
  }

  async shutdown(): Promise<boolean> {
    this.#accepting = false;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
    this.#activeController?.abort();
    const active = [this.#ticking, this.#draining].filter((promise): promise is Promise<void> => promise !== undefined);
    if (active.length === 0) return true;
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.allSettled(active).then(() => { settled = true; }),
        new Promise<void>(resolve => { timeout = setTimeout(resolve, 5000); })
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
    return settled;
  }

  async #drainJobs(): Promise<void> {
    while (this.#accepting && !this.#faulted) {
      let job: ServiceJob | undefined;
      try {
        job = this.store.claimServiceJob(this.options.workspaceId, this.options.instanceId, this.#clock());
      } catch (error) {
        this.#rethrowIfFatal(error);
        throw error;
      }
      if (!job) return;
      await this.#runJob(job);
    }
  }

  async #runJob(job: ServiceJob): Promise<void> {
    this.#activeJobId = job.id;
    this.#activeStartedAt = job.startedAt ?? this.#clock();
    const controller = new AbortController();
    this.#activeController = controller;
    const deadline = Date.now() + this.#timeoutMs;
    const deadlineTimer = setTimeout(() => controller.abort(new OperationDeadlineError()), Math.max(0, deadline - Date.now()));
    deadlineTimer.unref?.();
    const fence: TrustedExecutionFence = {
      serviceGeneration: this.options.serviceGeneration,
      deadline,
      signal: controller.signal,
      assertCurrent: async () => {
        if (this.#fatalError !== undefined) throw this.#fatalError;
        if (controller.signal.aborted || Date.now() >= deadline || this.#activeJobId !== job.id ||
            this.options.serviceGeneration !== fence.serviceGeneration) throw new OperationStoppedError();
      },
      assertSettlementCurrent: () => {
        if (this.#fatalError !== undefined) throw this.#fatalError;
        if (this.#activeJobId !== job.id || this.options.serviceGeneration !== fence.serviceGeneration)
          throw new OperationStoppedError();
      }
    };
    try {
      switch (job.kind) {
        case 'owner_turn':
          await this.agent.processAdmittedOwnerTurn({ workspaceId: this.options.workspaceId,
            ownerId: this.options.ownerId, job, fence });
          break;
        case 'reminder':
          this.store.completeServiceJob(this.options.workspaceId, job.claim!, 'finished', {
            reason: 'completed', recordIds: [job.parameters.kind === 'reminder' ? job.parameters.timerRecordId : ''],
            ...(job.parameters.kind === 'reminder' ? { timerId: job.parameters.timerId } : {})
          }, this.#clock());
          break;
        case 'execute':
        case 'readback':
          await this.#runActionJob(job, fence);
          break;
      }
    } catch (error) {
      if (this.#fatalError !== undefined) throw this.#fatalError;
      if (isFatalServiceStorageError(error)) {
        this.#fault(error);
        throw error;
      }
      await this.#stopJob(job, error instanceof OperationStoppedError || controller.signal.aborted
        ? executionDeadlineReached({ signal: controller.signal, deadline }, error) ? 'deadline' : 'cancelled' :
        job.kind === 'owner_turn' ? 'model_unavailable' : 'action_ineligible');
    } finally {
      clearTimeout(deadlineTimer);
      controller.abort();
      if (this.#activeJobId === job.id) {
        this.#activeJobId = null;
        this.#activeStartedAt = null;
        this.#activeController = undefined;
      }
    }
  }

  async #runActionJob(job: ServiceJob, fence: TrustedExecutionFence): Promise<void> {
    const parameters = job.parameters;
    if ((parameters.kind !== 'execute' && parameters.kind !== 'readback') || parameters.kind !== job.kind ||
        (job.kind !== 'execute' && job.kind !== 'readback'))
      throw new Error('Invalid action job');
    const before = this.store.state(this.options.workspaceId);
    const action = before.actions[parameters.actionId];
    if (!action || action.digest !== parameters.digest) throw new Error('Action request is no longer current');
    if (job.kind === 'execute' && action.status !== 'approved') throw new Error('Action is not eligible for execution');
    if (job.kind === 'readback' && !['accepted', 'unknown'].includes(action.status))
      throw new Error('Action is not eligible for readback');
    const context: OperationExecutionContext = { signal: fence.signal, deadline: fence.deadline,
      assertCurrent: () => fence.assertCurrent(), serviceClaim: job.claim! };
    const result = job.kind === 'execute'
      ? await this.operations.execute({ workspaceId: this.options.workspaceId, ownerId: this.options.ownerId,
          actionId: action.id }, context)
      : await this.operations.verify({ workspaceId: this.options.workspaceId, ownerId: this.options.ownerId,
          actionId: action.id }, context);
    let final = result;
    if (job.kind === 'execute' && result.status === 'accepted') {
      try {
        final = await this.operations.verify({ workspaceId: this.options.workspaceId, ownerId: this.options.ownerId,
          actionId: action.id }, context);
      } catch (error) {
        if (isFatalServiceStorageError(error)) throw error;
      }
    }
    fence.assertSettlementCurrent?.();
    const currentJob = this.store.serviceJob(this.options.workspaceId, job.id);
    if (job.kind === 'execute' && !currentJob.attemptId)
      throw new Error('Execution request became ineligible before action start');
    const records = this.store.journal(this.options.workspaceId);
    const actionRecord = job.kind === 'readback'
      ? records.find(record => record.id === currentJob.actionRecordId)
      : records.find(record => record.event.type === 'action.finished' &&
        record.event.data.id === action.id && record.event.data.attemptId === currentJob.attemptId);
    if (job.kind === 'readback' && (actionRecord?.event.type !== 'action.finished' || actionRecord.event.data.id !== action.id))
      throw new ServiceStorageError('integrity', 'Readback historical outcome is missing.');
    const attemptId = actionRecord?.event.type === 'action.finished' ? actionRecord.event.data.attemptId : currentJob.attemptId;
    const verificationRecord = currentJob.verificationRecordId === undefined ? undefined
      : this.store.record(this.options.workspaceId, currentJob.verificationRecordId);
    if (verificationRecord && (verificationRecord.event.type !== 'action.verification_recorded' ||
        verificationRecord.event.data.id !== action.id || verificationRecord.event.data.verification.status === 'owner_attested'))
      throw new ServiceStorageError('integrity', 'Claimed action verification is invalid.');
    let reason: ServiceJobResult['reason'];
    let status: 'finished' | 'stopped' = 'stopped';
    if (job.kind === 'readback') {
      const satisfied = verificationRecord?.event.type === 'action.verification_recorded' &&
        verificationRecord.event.data.verification.status === 'satisfied';
      reason = satisfied ? 'completed' : 'readback_unresolved';
      status = satisfied ? 'finished' : 'stopped';
    }
    else if (final.status === 'failed') reason = 'action_failed';
    else if (final.status === 'unknown') reason = 'action_unknown';
    else if (final.status === 'accepted' && verificationRecord && final.verification?.status === 'satisfied') {
      reason = 'completed'; status = 'finished';
    } else reason = 'readback_unresolved';
    const recordIds = [actionRecord?.id, verificationRecord?.id].filter((id): id is string => id !== undefined);
    this.store.completeServiceJob(this.options.workspaceId, job.claim!, status, { reason, recordIds,
      actionId: action.id, ...(attemptId ? { attemptId } : {}),
      ...(actionRecord ? { actionRecordId: actionRecord.id } : {}),
      ...(verificationRecord ? { verificationRecordId: verificationRecord.id } : {}) }, this.#clock(),
      () => fence.assertSettlementCurrent?.());
  }

  async #stopJob(job: ServiceJob, reason: ServiceJobResult['reason']): Promise<void> {
    try {
      if (job.kind === 'owner_turn' && job.parameters.kind === 'owner_turn') {
        this.store.completeOwnerTurnJob(this.options.workspaceId, job.claim!, {
          ownerRecordId: job.parameters.ownerRecordId, expectedVersion: this.store.state(this.options.workspaceId).version,
          events: [], reply: { text: 'Service job stopped safely. No automatic retry was started.',
            source: 'agent:application', externalId: `service-stop-${job.id}`, threadId: job.parameters.threadId },
          status: 'stopped', reason, at: this.#clock()
        });
      } else {
        const recordIds = job.kind === 'reminder' && job.parameters.kind === 'reminder'
          ? [job.parameters.timerRecordId] : [];
        this.store.completeServiceJob(this.options.workspaceId, job.claim!, 'stopped', { reason, recordIds,
          ...(job.parameters.kind === 'reminder' ? { timerId: job.parameters.timerId } : {}) }, this.#clock());
      }
    } catch (error) {
      this.#rethrowIfFatal(error);
      if (!(error instanceof ServiceStorageError && error.code === 'conflict')) throw error;
    }
  }

  async #tickTimers(): Promise<void> {
    const at = this.#clock();
    this.#lastSchedulerPollAt = at;
    try {
      const due = Object.values(this.store.state(this.options.workspaceId).timers)
        .filter(timer => timer.status === 'scheduled' && Date.parse(timer.dueAt) <= Date.parse(at))
        .sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt) || a.id.localeCompare(b.id)).slice(0, 100);
      for (const timer of due) {
        if (!this.#accepting || this.#faulted) break;
        const result = this.store.admitDueTimerJob(this.options.workspaceId, timer.id, this.options.instanceId, at);
        if (result.kind === 'full') break;
      }
      this.#refreshNextDue();
      if (this.#accepting && !this.#faulted) void this.drain().catch(() => {});
    } catch (error) {
      this.#rethrowIfFatal(error);
      if (!(error instanceof ServiceStorageError && ['invalid', 'conflict', 'full'].includes(error.code))) throw error;
    }
  }

  #refreshNextDue(): void {
    try {
      const due = Object.values(this.store.state(this.options.workspaceId).timers)
        .filter(timer => timer.status === 'scheduled').map(timer => timer.dueAt).sort();
      this.#nextDueAt = due[0] ?? null;
    } catch (error) {
      if (isFatalServiceStorageError(error)) this.#fault(error);
      else throw error;
    }
  }

  #admit<T>(callback: () => T): T {
    if (!this.#accepting || this.#faulted) throw new Error('Service runtime is unavailable and not accepting work.');
    try {
      return callback();
    } catch (error) {
      this.#rethrowIfFatal(error);
      throw error;
    }
  }

  #rethrowIfFatal(error: unknown): void {
    if (!isFatalServiceStorageError(error)) return;
    this.#fault(error);
    throw error;
  }

  #fault(error: unknown): void {
    if (this.#fatalError === undefined) this.#fatalError = error;
    this.#faulted = true;
    this.#accepting = false;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
    this.#activeController?.abort();
  }

  #lowerLimit(value: number | undefined, maximum: number): number {
    if (value === undefined) return maximum;
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error('Invalid runtime limit');
    return value;
  }
}
