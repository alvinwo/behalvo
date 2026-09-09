import type { DomainEvent, Fact, State } from './types.js';
import { identifier, instant, nonempty, required } from './types.js';
import { isOperationCommand, validateConnection, validateOperationCommand, validateStoredObservation } from '../operations/validation.js';
export function emptyState(workspaceId: string): State {
    return { workspaceId, ownerId: '', version: 0, works: {}, actions: {}, timers: {}, facts: {}, connections: {} };
}
/** Pure replay: no clock reads, random IDs, network, authorization reevaluation or LLM. */
export function reduce(previous: State, event: DomainEvent, seq: number): State {
    if (seq !== previous.version + 1)
        throw new Error('Non-contiguous journal sequence');
    const s = structuredClone(previous);
    s.connections ??= {};
    switch (event.type) {
        case 'workspace.created': {
            if (s.ownerId)
                throw new Error('Workspace already exists');
            identifier(event.data.ownerId, 'ownerId');
            s.ownerId = event.data.ownerId;
            break;
        }
        case 'message.received': {
            const d = event.data;
            identifier(d.threadId, 'threadId');
            identifier(d.artifactId, 'artifactId');
            identifier(d.senderId, 'senderId');
            nonempty(d.source, 'source');
            nonempty(d.externalId, 'externalId');
            if (!['owner', 'external', 'agent'].includes(d.senderRole))
                throw new Error('Invalid sender role');
            break;
        }
        case 'inbox.handled':
            identifier(event.data.recordId);
            break;
        case 'connection.registered': {
            const connection = event.data.connection;
            validateConnection(connection);
            const existing = s.connections[connection.id];
            if (connection.status !== 'active' || connection.generation !== (existing?.generation ?? 0) + 1)
                throw new Error('Invalid connection generation');
            s.connections[connection.id] = structuredClone(connection);
            break;
        }
        case 'connection.revoked': {
            const connection = required(s.connections, event.data.id, 'Connection');
            if (connection.status !== 'active' || event.data.generation !== connection.generation + 1)
                throw new Error('Invalid connection revocation');
            connection.status = 'revoked';
            connection.generation = event.data.generation;
            break;
        }
        case 'work.created': {
            const d = event.data;
            identifier(d.id);
            identifier(d.threadId);
            nonempty(d.title, 'title');
            nonempty(d.goal, 'goal');
            if (Object.hasOwn(s.works, d.id))
                throw new Error('Work already exists');
            s.works[d.id] = { id: d.id, title: d.title, goal: d.goal, phase: 'open', revision: 1, threadIds: [d.threadId], evidenceRefs: [] };
            break;
        }
        case 'work.thread_linked': {
            const w = required(s.works, event.data.id, 'Work');
            identifier(event.data.threadId);
            if (!w.threadIds.includes(event.data.threadId)) {
                w.threadIds.push(event.data.threadId);
                w.revision++;
            }
            break;
        }
        case 'work.phase_changed': {
            const w = required(s.works, event.data.id, 'Work');
            const d = event.data;
            if (!['open', 'waiting_external', 'done', 'cancelled'].includes(d.phase))
                throw new Error('Invalid work phase');
            if (['done', 'cancelled'].includes(w.phase))
                throw new Error('Work is already closed');
            if (d.phase === 'done')
                nonempty(d.evidenceRef, 'Completion evidence');
            w.phase = d.phase;
            w.revision++;
            if (d.evidenceRef)
                w.evidenceRefs.push(d.evidenceRef);
            break;
        }
        case 'action.proposed': {
            const a = event.data.action;
            identifier(a.id);
            nonempty(a.key, 'operation key');
            nonempty(a.digest, 'digest');
            const w = required(s.works, a.workId, 'Work');
            if (a.status !== 'proposed' || a.approval || a.attemptId || a.evidenceRef)
                throw new Error('Invalid initial action state');
            if (a.verification) throw new Error('Invalid initial action verification');
            if (isOperationCommand(a.command)) validateOperationCommand(a.command);
            if (a.workRevision !== w.revision)
                throw new Error('Stale work revision');
            if (Object.hasOwn(s.actions, a.id) || Object.values(s.actions).some(x => x.key === a.key))
                throw new Error('Duplicate action key');
            s.actions[a.id] = structuredClone(a);
            break;
        }
        case 'action.approved': {
            const a = required(s.actions, event.data.id, 'Action');
            if (a.status !== 'proposed')
                throw new Error('Action not awaiting approval');
            if (event.data.approval.digest !== a.digest || event.data.approval.ownerId !== s.ownerId)
                throw new Error('Approval binding mismatch');
            instant(event.data.approval.expiresAt);
            a.approval = structuredClone(event.data.approval);
            a.status = 'approved';
            break;
        }
        case 'action.started': {
            const a = required(s.actions, event.data.id, 'Action');
            if (a.status !== 'approved')
                throw new Error('Action requires approval');
            const work = required(s.works, a.workId, 'Work');
            if (work.revision !== a.workRevision || ['done', 'cancelled'].includes(work.phase))
                throw new Error('Stale or closed work authorization');
            if (isOperationCommand(a.command)) {
                validateOperationCommand(a.command);
                const command = a.command;
                const connection = required(s.connections, command.connectionId, 'Connection');
                if (connection.status !== 'active' || connection.provider !== command.provider || connection.subject !== command.subject ||
                    connection.generation !== command.connectionGeneration) throw new Error('Operation connection binding changed');
                const sameScope = Object.values(s.actions).filter(other => {
                    if (other.id === a.id || !isOperationCommand(other.command)) return false;
                    return other.command.provider === command.provider && other.command.subject === command.subject;
                });
                if (sameScope.some(other => other.status === 'running' || other.status === 'unknown' ||
                    (other.status === 'accepted' && other.verification?.status !== 'satisfied' && other.verification?.status !== 'owner_attested')))
                    throw new Error('Operation subject conflict barrier');
                if (command.subjectRevision !== sameScope.filter(other => Boolean(other.attemptId)).length)
                    throw new Error('Stale operation subject revision');
            }
            identifier(event.data.attemptId);
            a.attemptId = event.data.attemptId;
            a.status = 'running';
            break;
        }
        case 'action.finished': {
            const a = required(s.actions, event.data.id, 'Action');
            const d = event.data;
            if (a.status !== 'running' || a.attemptId !== d.attemptId)
                throw new Error('Attempt state mismatch');
            if (!['accepted', 'failed', 'unknown'].includes(d.status))
                throw new Error('Invalid outcome');
            nonempty(d.evidenceRef, 'evidence');
            a.status = d.status;
            a.evidenceRef = d.evidenceRef;
            break;
        }
        case 'action.reconciled': {
            const a = required(s.actions, event.data.id, 'Action');
            const acceptedOperationResolution = isOperationCommand(a.command) && a.status === 'accepted' &&
                event.data.status === 'accepted' && a.verification?.status !== 'satisfied' && a.verification?.status !== 'owner_attested';
            if (a.status !== 'unknown' && !acceptedOperationResolution)
                throw new Error('Only unknown or accepted actions can be reconciled');
            if (!['accepted', 'failed'].includes(event.data.status))
                throw new Error('Invalid reconciliation');
            nonempty(event.data.evidenceRef, 'evidence');
            a.status = event.data.status;
            a.evidenceRef = event.data.evidenceRef;
            break;
        }
        case 'action.verification_recorded': {
            const a = required(s.actions, event.data.id, 'Action');
            if (!isOperationCommand(a.command)) throw new Error('Verification requires an operation action');
            const verification = event.data.verification;
            instant(verification.recordedAt);
            if (a.verification?.status === 'satisfied' || a.verification?.status === 'owner_attested')
                throw new Error('Operation verification is already settled');
            if (verification.status === 'owner_attested') {
                if (!['accepted', 'failed'].includes(verification.resolution)) throw new Error('Invalid owner attestation');
                nonempty(verification.evidenceRef, 'owner attestation evidence');
                if (a.status !== verification.resolution) throw new Error('Owner attestation resolution mismatch');
            } else {
                if (!['satisfied', 'not_satisfied', 'unknown'].includes(verification.status)) throw new Error('Invalid verification');
                validateStoredObservation(verification.observation);
                if (verification.observation.provider !== a.command.provider || verification.observation.subject !== a.command.subject ||
                    verification.observation.connectionId !== a.command.connectionId || verification.observation.connectionGeneration !== a.command.connectionGeneration ||
                    verification.observation.resourceId !== a.command.resourceId)
                    throw new Error('Verification observation scope mismatch');
            }
            a.verification = structuredClone(verification);
            break;
        }
        case 'action.cancelled': {
            const a = required(s.actions, event.data.id, 'Action');
            if (!['proposed', 'approved'].includes(a.status))
                throw new Error('Action cannot be cancelled at this stage');
            nonempty(event.data.reason, 'cancellation reason');
            a.status = 'cancelled';
            break;
        }
        case 'timer.scheduled': {
            const timer = event.data.timer;
            identifier(timer.id);
            instant(timer.dueAt);
            const w = required(s.works, timer.workId, 'Work');
            if (Object.hasOwn(s.timers, timer.id))
                throw new Error('Timer already exists');
            if (timer.status !== 'scheduled' || timer.workRevision !== w.revision)
                throw new Error('Invalid timer');
            s.timers[timer.id] = structuredClone(timer);
            break;
        }
        case 'timer.fired':
        case 'timer.cancelled': {
            const timer = required(s.timers, event.data.id, 'Timer');
            if (timer.status !== 'scheduled')
                throw new Error('Timer already handled');
            timer.status = event.type === 'timer.fired' ? 'fired' : 'cancelled';
            break;
        }
        case 'fact.recorded': {
            const f = event.data.fact;
            identifier(f.id);
            nonempty(f.subject, 'subject');
            nonempty(f.predicate, 'predicate');
            nonempty(f.value, 'value');
            nonempty(f.sourceRecordId, 'sourceRecordId');
            instant(f.validFrom);
            if (f.validTo !== null) {
                instant(f.validTo);
                if (Date.parse(f.validTo) <= Date.parse(f.validFrom))
                    throw new Error('Invalid validity range');
            }
            if (Object.hasOwn(s.facts, f.id))
                throw new Error('Fact already exists');
            if (f.supersedes) {
                const old = required(s.facts, f.supersedes, 'Superseded fact');
                if (old.subject !== f.subject || old.predicate !== f.predicate)
                    throw new Error('Fact supersession scope mismatch');
            }
            s.facts[f.id] = structuredClone(f);
            break;
        }
        default: throw new Error(`Unknown or unsupported event: ${(event as {
            type: string;
        }).type}`);
    }
    s.version = seq;
    return s;
}
export function resolveFact(state: State, subject: string, predicate: string, at: string): {
    status: 'missing' | 'resolved' | 'conflict';
    facts: Fact[];
} {
    instant(at);
    const time = Date.parse(at);
    const claims = Object.values(state.facts).filter(f => f.subject === subject && f.predicate === predicate);
    // A supersession starts when its replacement becomes effective, not when recorded.
    const superseded = new Set(claims.filter(f => f.supersedes && Date.parse(f.validFrom) <= time).map(f => f.supersedes!));
    const active = claims.filter(f => !superseded.has(f.id) && Date.parse(f.validFrom) <= time && (f.validTo === null || time < Date.parse(f.validTo)));
    return { status: active.length === 0 ? 'missing' : active.length === 1 ? 'resolved' : 'conflict', facts: structuredClone(active) };
}
