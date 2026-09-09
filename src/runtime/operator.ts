import { randomUUID } from 'node:crypto';
import type { SqliteStore } from '../storage/sqlite-store.js';
import type { Action, Fact, WorkItem, WorkPhase } from '../kernel/types.js';
import { identifier, instant, nonempty, required } from '../kernel/types.js';
import { assertOwner, commandDigest, validateCommand } from '../kernel/policy.js';
import { isOperationCommand } from '../operations/validation.js';
import type { EffectDriver, EffectOutcome, EffectRequest, Proposal } from '../ports.js';
/** Trusted application service. Model/adapter code gets ports, not this administrative object. */
export class Operator {
    constructor(private readonly store: SqliteStore, private readonly clock: () => string = () => new Date().toISOString(), private readonly allowedChannels: readonly string[] = ['mock-email', 'mock-im']) { }
    createWork(workspaceId: string, ownerId: string, input: {
        id: string;
        title: string;
        goal: string;
        threadId: string;
    }): WorkItem {
        const s = this.store.state(workspaceId);
        assertOwner(s, ownerId);
        this.store.append(workspaceId, s.version, [{ type: 'work.created', data: input }], { actorId: ownerId, recordedAt: this.clock() });
        return this.store.state(workspaceId).works[input.id]!;
    }
    linkThread(workspaceId: string, ownerId: string, workId: string, threadId: string): void {
        const s = this.store.state(workspaceId);
        assertOwner(s, ownerId);
        this.store.append(workspaceId, s.version, [{ type: 'work.thread_linked', data: { id: workId, threadId } }], { actorId: ownerId, recordedAt: this.clock() });
    }
    setWorkPhase(workspaceId: string, ownerId: string, workId: string, phase: WorkPhase, evidenceRef?: string): void {
        const s = this.store.state(workspaceId);
        assertOwner(s, ownerId);
        if (evidenceRef)
            this.store.readArtifact(workspaceId, evidenceRef);
        this.store.append(workspaceId, s.version, [{ type: 'work.phase_changed', data: { id: workId, phase, ...(evidenceRef ? { evidenceRef } : {}) } }], { actorId: ownerId, recordedAt: this.clock() });
    }
    recordFact(workspaceId: string, ownerId: string, fact: Fact): void {
        const s = this.store.state(workspaceId);
        assertOwner(s, ownerId);
        this.store.record(workspaceId, fact.sourceRecordId);
        this.store.append(workspaceId, s.version, [{ type: 'fact.recorded', data: { fact } }], { actorId: ownerId, causationId: fact.sourceRecordId, recordedAt: this.clock() });
    }
    propose(workspaceId: string, input: Proposal): Action {
        const s = this.store.state(workspaceId);
        validateCommand(input.command, this.allowedChannels);
        nonempty(input.key, 'operation key');
        if (input.key.length > 200)
            throw new Error('Operation key too long');
        const key = `${workspaceId}:${input.key}`;
        const existing = Object.values(s.actions).find(a => a.key === key);
        if (existing) {
            if (existing.digest !== commandDigest(workspaceId, input.workId, existing.workRevision, input.command))
                throw new Error('Operation key collision with different command');
            return existing;
        }
        const w = required(s.works, input.workId, 'Work');
        if (['done', 'cancelled'].includes(w.phase))
            throw new Error('Work is closed');
        const a: Action = { id: randomUUID(), workId: w.id, key, command: structuredClone(input.command),
            digest: commandDigest(workspaceId, w.id, w.revision, input.command), workRevision: w.revision, status: 'proposed' };
        this.store.append(workspaceId, s.version, [{ type: 'action.proposed', data: { action: a } }], { actorId: 'agent', recordedAt: this.clock() });
        return this.store.state(workspaceId).actions[a.id]!;
    }
    approve(workspaceId: string, ownerId: string, actionId: string, digest: string, expiresAt: string): Action {
        const s = this.store.state(workspaceId);
        assertOwner(s, ownerId);
        instant(expiresAt);
        const now = this.clock();
        instant(now);
        if (Date.parse(expiresAt) <= Date.parse(now) || Date.parse(expiresAt) - Date.parse(now) > 86400000)
            throw new Error('Approval expired or exceeds 24-hour TTL');
        const a = required(s.actions, actionId, 'Action');
        const w = required(s.works, a.workId, 'Work');
        if (digest !== a.digest)
            throw new Error('Approval digest mismatch');
        if (w.revision !== a.workRevision || ['done', 'cancelled'].includes(w.phase))
            throw new Error('Stale or closed work');
        this.store.append(workspaceId, s.version, [{ type: 'action.approved', data: { id: a.id, approval: { ownerId, digest, expiresAt } } }], { actorId: ownerId, recordedAt: now });
        return this.store.state(workspaceId).actions[a.id]!;
    }
    cancelAction(workspaceId: string, ownerId: string, actionId: string, reason: string): void {
        const s = this.store.state(workspaceId);
        assertOwner(s, ownerId);
        this.store.append(workspaceId, s.version, [{ type: 'action.cancelled', data: { id: actionId, reason } }], { actorId: ownerId, recordedAt: this.clock() });
    }
    startEffect(workspaceId: string, actionId: string, driverChannel: string): EffectRequest | null {
        const s = this.store.state(workspaceId);
        const a = required(s.actions, actionId, 'Action');
        if (['running', 'accepted', 'failed', 'unknown', 'cancelled'].includes(a.status))
            return null;
        if (a.status !== 'approved' || !a.approval)
            throw new Error('Effect requires owner approval');
        validateCommand(a.command, this.allowedChannels);
        if (driverChannel !== a.command.channel)
            throw new Error('Effect driver channel mismatch');
        const w = required(s.works, a.workId, 'Work');
        if (w.revision !== a.workRevision || ['done', 'cancelled'].includes(w.phase))
            throw new Error('Stale or closed work authorization');
        const now = this.clock();
        instant(now);
        if (Date.parse(a.approval.expiresAt) <= Date.parse(now))
            throw new Error('Approval expired');
        if (a.approval.ownerId !== s.ownerId || a.approval.digest !== commandDigest(workspaceId, a.workId, a.workRevision, a.command))
            throw new Error('Approval digest binding mismatch');
        const attemptId = randomUUID();
        this.store.append(workspaceId, s.version, [{ type: 'action.started', data: { id: a.id, attemptId } }], { recordedAt: now });
        return { workspaceId, actionId: a.id, attemptId, idempotencyKey: a.key, command: structuredClone(a.command) };
    }
    async runEffect(workspaceId: string, actionId: string, driver: EffectDriver): Promise<Action> {
        const request = this.startEffect(workspaceId, actionId, driver.channel);
        if (!request)
            return this.store.state(workspaceId).actions[actionId]!;
        let outcome: EffectOutcome;
        try {
            outcome = await driver.execute(request);
            if (!outcome || !['accepted', 'failed', 'unknown'].includes(outcome.status))
                throw new Error('Invalid provider outcome');
            nonempty(outcome.evidence, 'provider evidence');
            if (Buffer.byteLength(outcome.evidence, 'utf8') > 262144)
                throw new Error('Provider evidence too large');
        }
        catch {
            // An exception cannot establish that the remote change did not occur.
            // Do not persist raw exception strings, which can contain credentials.
            outcome = { status: 'unknown', evidence: 'Provider outcome unavailable or invalid. Readback or owner reconciliation required.' };
        }
        const evidenceRef = this.store.putArtifact(workspaceId, outcome.evidence);
        const s = this.store.state(workspaceId);
        this.store.append(workspaceId, s.version, [{ type: 'action.finished', data: { id: actionId, attemptId: request.attemptId, status: outcome.status, evidenceRef } }], { recordedAt: this.clock() });
        return this.store.state(workspaceId).actions[actionId]!;
    }
    recoverInterrupted(workspaceId: string, exclusiveMaintenance: boolean): number {
        if (exclusiveMaintenance !== true)
            throw new Error('Exclusive maintenance required; all effect workers must be stopped');
        const running = Object.values(this.store.state(workspaceId).actions).filter(a => a.status === 'running');
        for (const a of running) {
            const evidenceRef = this.store.putArtifact(workspaceId, 'Interrupted execution; remote outcome is unknown. No automatic retry.');
            const s = this.store.state(workspaceId);
            this.store.append(workspaceId, s.version, [{ type: 'action.finished', data: { id: a.id, attemptId: a.attemptId!, status: 'unknown', evidenceRef } }], { recordedAt: this.clock() });
        }
        return running.length;
    }
    reconcile(workspaceId: string, ownerId: string, actionId: string, status: 'accepted' | 'failed', evidence: string): void {
        const s = this.store.state(workspaceId);
        assertOwner(s, ownerId);
        const action = required(s.actions, actionId, 'Action');
        if (isOperationCommand(action.command)) throw new Error('Operation reconciliation requires OperationService');
        const evidenceRef = this.store.putArtifact(workspaceId, evidence);
        this.store.append(workspaceId, s.version, [{ type: 'action.reconciled', data: { id: actionId, status, evidenceRef } }], { actorId: ownerId, recordedAt: this.clock() });
    }
    schedule(workspaceId: string, ownerId: string, input: {
        id: string;
        workId: string;
        dueAt: string;
    }): void {
        const s = this.store.state(workspaceId);
        assertOwner(s, ownerId);
        identifier(input.id);
        instant(input.dueAt);
        const w = required(s.works, input.workId, 'Work');
        if (['done', 'cancelled'].includes(w.phase))
            throw new Error('Work is closed');
        this.store.append(workspaceId, s.version, [{ type: 'timer.scheduled', data: { timer: { ...input, workRevision: w.revision, status: 'scheduled' } } }], { actorId: ownerId, recordedAt: this.clock() });
    }
    fireDue(workspaceId: string): number {
        const now = this.clock();
        instant(now);
        let fired = 0;
        const timers = Object.values(this.store.state(workspaceId).timers).filter(t => t.status === 'scheduled' && Date.parse(t.dueAt) <= Date.parse(now));
        for (const timer of timers) {
            const s = this.store.state(workspaceId);
            const w = required(s.works, timer.workId, 'Work');
            if (['done', 'cancelled'].includes(w.phase) || w.revision !== timer.workRevision) {
                this.store.append(workspaceId, s.version, [{ type: 'timer.cancelled', data: { id: timer.id } }], { recordedAt: now });
            }
            else {
                this.store.enqueueTimer(workspaceId, s.version, timer.id, now);
                fired++;
            }
        }
        return fired;
    }
}
