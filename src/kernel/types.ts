/** Domain data is transport- and model-independent. No provider session owns it. */
import type { Connection, OperationCommand, VerificationState } from '../operations/types.js';

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
    validFrom: string;
    validTo: string | null;
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
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T.*Z$/.test(value) || !Number.isFinite(Date.parse(value)))
        throw new Error('Expected a UTC ISO timestamp');
}
export function required<T>(map: Record<string, T>, id: string, kind: string): T {
    identifier(id);
    if (!Object.hasOwn(map, id))
        throw new Error(`${kind} not found: ${id}`);
    return map[id]!;
}
