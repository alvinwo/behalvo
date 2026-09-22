/** Domain data is transport- and model-independent. No provider session owns it. */
import type { Connection, OperationCommand, VerificationState } from '../operations/types.js';
import type {
    MonitoredActionGrant, MonitoredActionReference, MonitorObservationSummary, MonitorPauseReason, MonitorState,
    MonitoredGrantSettlementOutcome
} from '../monitoring/types.js';

export type WorkPhase = 'open' | 'waiting_external' | 'done' | 'cancelled';
export type ActionStatus = 'proposed' | 'approved' | 'running' | 'accepted' | 'failed' | 'unknown' | 'cancelled';
export type OutcomeStatus = 'accepted' | 'failed' | 'unknown';
export interface MessageCommand {
    kind: 'message.send';
    channel: string;
    to: string;
    body: string;
}
export type Command = MessageCommand | OperationCommand;
export interface WorkItem {
    id: string;
    title: string;
    goal: string;
    phase: WorkPhase;
    revision: number;
    threadIds: string[];
    evidenceRefs: string[];
}
export interface Approval {
    ownerId: string;
    digest: string;
    expiresAt: string;
}
export interface Action {
    id: string;
    workId: string;
    key: string;
    command: Command;
    digest: string;
    workRevision: number;
    status: ActionStatus;
    approval?: Approval;
    attemptId?: string;
    evidenceRef?: string;
    verification?: VerificationState;
    monitoredGrant?: MonitoredActionReference;
    monitoredIntent?: { intentId: string; attemptId: string; evidenceRef: string };
    monitoredConfirmation?: { referenceDigest: string; attemptId: string; evidenceRef: string };
}
export interface Timer {
    id: string;
    workId: string;
    workRevision: number;
    dueAt: string;
    status: 'scheduled' | 'fired' | 'cancelled';
}
export interface Fact {
    id: string;
    subject: string;
    predicate: string;
    value: string;
    validFrom: string | null;
    validTo: string | null;
    /** When the source record was observed by this application. */
    observedAt: string;
    sourceRecordId: string;
    supersedes?: string;
}
export interface State {
    workspaceId: string;
    ownerId: string;
    version: number;
    works: Record<string, WorkItem>;
    actions: Record<string, Action>;
    timers: Record<string, Timer>;
    facts: Record<string, Fact>;
    connections: Record<string, Connection>;
    monitoredActionGrants: Record<string, MonitoredActionGrant>;
    monitors: Record<string, MonitorState>;
}
export interface MessageInput {
    source: string;
    externalId: string;
    threadId: string;
    senderId: string;
    senderRole: 'owner' | 'external' | 'agent';
    text: string;
}
export type DomainEvent = {
    type: 'workspace.created';
    data: {
        ownerId: string;
    };
} | {
    type: 'connection.registered';
    data: { connection: Connection };
} | {
    type: 'connection.revoked';
    data: { id: string; generation: number };
} | {
    type: 'monitored_action.grant_proposed';
    data: { grant: MonitoredActionGrant };
} | {
    type: 'monitored_action.grant_activated';
    data: { id: string; digest: string; revision: number; ownerId: string;
        installationGeneration: string; activatedAt: string };
} | {
    type: 'monitored_action.grant_revoked';
    data: { id: string; digest: string; revision: number; reason: 'owner_revoked' | 'material_drift'; revokedAt: string };
} | {
    type: 'monitored_action.grant_expired';
    data: { id: string; digest: string; revision: number; expiredAt: string };
} | {
    type: 'monitored_action.installation_reconciled';
    data: { id: string; digest: string; revision: number; ownerId: string;
        installationGeneration: string; reconciledAt: string };
} | {
    type: 'monitored_action.command_narrowed';
    data: { grantId: string; action: Action };
} | {
    type: 'monitored_action.grant_reserved';
    data: { id: string; digest: string; revision: number; actionId: string; attemptId: string;
        observationDigest: string; reservedAt: string };
} | {
    type: 'monitored_action.grant_settled';
    data: { id: string; actionId: string; outcome: MonitoredGrantSettlementOutcome; settledAt: string };
} | {
    type: 'monitored_action.intent_recorded';
    data: { id: string; grantId: string; attemptId: string; intentId: string; evidenceRef: string };
} | {
    type: 'monitored_action.confirmation_recorded';
    data: { id: string; grantId: string; attemptId: string; referenceDigest: string; evidenceRef: string };
} | {
    type: 'monitor.configured';
    data: { monitor: MonitorState };
} | {
    type: 'monitor.poll_started';
    data: { id: string; jobId: string; dueAt: string; startedAt: string;
        requestWindowStartedAt: string; requestsInWindow: number };
} | {
    type: 'monitor.budget_deferred';
    data: { id: string; nextDueAt: string; deferredAt: string };
} | {
    type: 'monitor.observation_recorded';
    data: { id: string; jobId: string; observation: MonitorObservationSummary; status: 'active' | 'paused';
        nextDueAt: string | null; consecutiveFailures: number; backoffMs: number;
        pauseReason: MonitorPauseReason | null; recordedAt: string };
} | {
    type: 'monitor.interrupted';
    data: { id: string; jobId: string; nextDueAt: string; interruptedAt: string };
} | {
    type: 'monitor.resumed';
    data: { id: string; ownerId: string; nextDueAt: string; resumedAt: string };
} | {
    type: 'monitor.stopped';
    data: { id: string; reason: 'grant_reserved' | 'grant_terminal' | 'owner_stopped'; stoppedAt: string };
} | {
    type: 'message.received';
    data: Omit<MessageInput, 'text'> & {
        artifactId: string;
    };
} | {
    type: 'inbox.handled';
    data: {
        recordId: string;
    };
} | {
    type: 'work.created';
    data: {
        id: string;
        title: string;
        goal: string;
        threadId: string;
    };
} | {
    type: 'work.thread_linked';
    data: {
        id: string;
        threadId: string;
    };
} | {
    type: 'work.phase_changed';
    data: {
        id: string;
        phase: WorkPhase;
        evidenceRef?: string;
    };
} | {
    type: 'action.proposed';
    data: {
        action: Action;
    };
} | {
    type: 'action.approved';
    data: {
        id: string;
        approval: Approval;
    };
} | {
    type: 'action.started';
    data: {
        id: string;
        attemptId: string;
    };
} | {
    type: 'action.finished';
    data: {
        id: string;
        attemptId: string;
        status: OutcomeStatus;
        evidenceRef: string;
    };
} | {
    type: 'action.reconciled';
    data: {
        id: string;
        status: 'accepted' | 'failed';
        evidenceRef: string;
    };
} | {
    type: 'action.verification_recorded';
    data: { id: string; verification: VerificationState };
} | {
    type: 'action.cancelled';
    data: {
        id: string;
        reason: string;
    };
} | {
    type: 'timer.scheduled';
    data: {
        timer: Timer;
    };
} | {
    type: 'timer.fired';
    data: {
        id: string;
    };
} | {
    type: 'timer.cancelled';
    data: {
        id: string;
    };
} | {
    type: 'fact.recorded';
    data: {
        fact: Fact;
    };
};
export interface JournalRecord {
    id: string;
    schemaVersion: 1;
    workspaceId: string;
    seq: number;
    recordedAt: string;
    actorId: string;
    causationId: string | null;
    event: DomainEvent;
}
export interface RecordMetadata {
    actorId?: string;
    causationId?: string;
    recordedAt?: string;
}
export interface Summary {
    id: string;
    workspaceId: string;
    threadId: string;
    sourceIds: string[];
    text: string;
    createdAt: string;
}
export function nonempty(value: unknown, label: string): asserts value is string {
    if (typeof value !== 'string' || value.trim().length === 0)
        throw new Error(`${label} must be a non-empty string`);
}
export function identifier(value: unknown, label = 'id'): asserts value is string {
    nonempty(value, label);
    if (!/^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,199}$/.test(value) || ['constructor', 'prototype', '__proto__'].includes(value))
        throw new Error(`Invalid ${label}`);
}
export function instant(value: unknown): asserts value is string {
    // Schema-v1 journals accepted variable ISO time forms. Keep replay compatible;
    // stricter admission rules belong at new untrusted-input boundaries.
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T.*Z$/.test(value) || !Number.isFinite(Date.parse(value)))
        throw new Error('Expected a UTC ISO timestamp');
}
export function required<T>(map: Record<string, T>, id: string, kind: string): T {
    identifier(id);
    if (!Object.hasOwn(map, id))
        throw new Error(`${kind} not found: ${id}`);
    return map[id]!;
}
