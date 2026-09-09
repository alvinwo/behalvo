import { createHash, randomUUID } from 'node:crypto';
import type { Approval, State } from '../kernel/types.js';
import { identifier, instant, nonempty, required } from '../kernel/types.js';
import { assertOwner, commandDigest } from '../kernel/policy.js';
import type { SqliteStore } from '../storage/sqlite-store.js';
import { OperationRegistry } from './registry.js';
import type {
    ApproveOperationBatchInput, Connection, ExecuteOperationInput, OperationAction, OperationCommand,
    PrepareOperationInput, ReconcileOperationInput, RecoverOperationsInput, RegisterConnectionInput,
    RevokeConnectionInput, VerificationState, VerifyOperationInput
} from './types.js';
import {
    canonicalJson, exactObject, isOperationCommand, jsonValue, validateConnection, validateExecutionOutcome,
    validateObservationInput, validateOperationCommand, validatePreparation, validateVerdict
} from './validation.js';

export class OperationService {
    constructor(
        private readonly store: SqliteStore,
        private readonly registry: OperationRegistry,
        private readonly clock: () => string = () => new Date().toISOString()
    ) { }

    registerConnection(input: RegisterConnectionInput): Connection {
        exactObject(input, ['workspaceId', 'ownerId', 'connection'], 'register connection input');
        exactObject(input.connection, ['id', 'provider', 'subject', 'label'], 'connection input');
        const state = this.store.state(input.workspaceId);
        assertOwner(state, input.ownerId);
        const existing = state.connections[input.connection.id];
        const connection: Connection = { ...input.connection, generation: (existing?.generation ?? 0) + 1, status: 'active' };
        validateConnection(connection);
        this.store.append(input.workspaceId, state.version, [{ type: 'connection.registered', data: { connection } }],
            { actorId: input.ownerId, recordedAt: this.now() });
        return this.store.state(input.workspaceId).connections[connection.id]!;
    }

    revokeConnection(input: RevokeConnectionInput): Connection {
        exactObject(input, ['workspaceId', 'ownerId', 'connectionId'], 'revoke connection input');
        const state = this.store.state(input.workspaceId);
        assertOwner(state, input.ownerId);
        const connection = required(state.connections, input.connectionId, 'Connection');
        if (connection.status !== 'active') throw new Error('Connection already revoked');
        this.store.append(input.workspaceId, state.version,
            [{ type: 'connection.revoked', data: { id: connection.id, generation: connection.generation + 1 } }],
            { actorId: input.ownerId, recordedAt: this.now() });
        return this.store.state(input.workspaceId).connections[connection.id]!;
    }

    async prepare(input: PrepareOperationInput): Promise<OperationAction> {
        exactObject(input, ['workspaceId', 'ownerId', 'workId', 'key', 'connectionId', 'operationId', 'operationVersion',
            'resourceId', 'arguments'], 'prepare operation input');
        identifier(input.workspaceId, 'workspaceId'); identifier(input.workId, 'workId');
        identifier(input.connectionId, 'connectionId'); identifier(input.operationId, 'operationId');
        identifier(input.operationVersion, 'operationVersion'); identifier(input.resourceId, 'resourceId');
        nonempty(input.key, 'operation key');
        if (input.key.length > 200) throw new Error('Operation key too long');
        jsonValue(input.arguments, 'operation arguments');
        const initial = this.store.state(input.workspaceId);
        assertOwner(initial, input.ownerId);
        const work = required(initial.works, input.workId, 'Work');
        if (['done', 'cancelled'].includes(work.phase)) throw new Error('Work is closed');
        const connection = this.activeConnection(initial, input.connectionId);
        const handler = this.registry.resolve(connection.provider, input.operationId, input.operationVersion);
        const normalizedArguments = jsonValue(handler.validateArguments(input.arguments), 'operation arguments');
        const key = `${input.workspaceId}:${input.key}`;
        const requestFingerprint = createHash('sha256').update(canonicalJson(jsonValue([
            input.workspaceId, work.id, work.revision, key, connection.id, connection.provider, connection.subject,
            connection.generation, handler.id, handler.version, input.resourceId, normalizedArguments
        ], 'operation preparation request'))).digest('hex');
        const existing = Object.values(initial.actions).find(action => action.key === key);
        if (existing) {
            if (!isOperationCommand(existing.command) || existing.command.requestFingerprint !== requestFingerprint)
                throw new Error('Operation key collision with different request');
            return existing as OperationAction;
        }
        const initialScope = this.operationScope(initial, connection.provider, connection.subject);
        if (initialScope.blocked) throw new Error('Operation subject has an unresolved conflict barrier');
        const subject = await handler.identify({ connection: structuredClone(connection) });
        nonempty(subject, 'remote subject');
        if (subject !== connection.subject) throw new Error('Remote identity does not match connection subject');
        this.assertPreparationUnchanged(input.workspaceId, input.ownerId, work.id, work.revision, connection, initialScope.revision);
        const observationRequestedAt = this.now();
        const observed = await handler.observe({ connection: structuredClone(connection), resourceId: input.resourceId });
        const observation = validateObservationInput(observed, connection, input.resourceId, observationRequestedAt, this.now());
        this.assertPreparationUnchanged(input.workspaceId, input.ownerId, work.id, work.revision, connection, initialScope.revision);
        const preparation = validatePreparation(handler.prepare({
            connection: structuredClone(connection), arguments: normalizedArguments, observation: structuredClone(observation)
        }));
        if (!preparation.affectedResourceIds.includes(input.resourceId)) throw new Error('Primary resource missing from affected resources');
        const latest = this.assertPreparationUnchanged(input.workspaceId, input.ownerId, work.id, work.revision, connection, initialScope.revision);
        const command: OperationCommand = {
            kind: 'operation.execute', operationId: handler.id, operationVersion: handler.version,
            connectionId: connection.id, provider: connection.provider, subject: connection.subject,
            connectionGeneration: connection.generation, resourceId: input.resourceId,
            arguments: preparation.arguments, affectedResourceIds: preparation.affectedResourceIds,
            precondition: { state: observation.state, source: observation.source, observedAt: observation.observedAt,
                ...(observation.providerVersion ? { providerVersion: observation.providerVersion } : {}) },
            expectedResult: preparation.expectedResult, subjectRevision: initialScope.revision, requestFingerprint
        };
        validateOperationCommand(command);
        const digest = commandDigest(input.workspaceId, work.id, work.revision, command);
        const duplicate = Object.values(latest.actions).find(action => action.key === key);
        if (duplicate) {
            if (!isOperationCommand(duplicate.command) || duplicate.digest !== digest) throw new Error('Operation key collision with different command');
            return duplicate as OperationAction;
        }
        const action: OperationAction = { id: randomUUID(), workId: work.id, key, command, digest,
            workRevision: work.revision, status: 'proposed' };
        this.store.append(input.workspaceId, latest.version, [{ type: 'action.proposed', data: { action } }],
            { actorId: input.ownerId, recordedAt: this.now() });
        return this.operationAction(this.store.state(input.workspaceId), action.id);
    }

    approveBatch(input: ApproveOperationBatchInput): OperationAction[] {
        exactObject(input, ['workspaceId', 'ownerId', 'expiresAt', 'approvals'], 'approve operation batch input');
        const state = this.store.state(input.workspaceId);
        assertOwner(state, input.ownerId);
        const now = this.now();
        instant(input.expiresAt);
        if (Date.parse(input.expiresAt) <= Date.parse(now) || Date.parse(input.expiresAt) - Date.parse(now) > 86400000)
            throw new Error('Approval expired or exceeds 24-hour TTL');
        if (!Array.isArray(input.approvals) || input.approvals.length === 0 || input.approvals.length > 1000)
            throw new Error('Invalid approval batch');
        const seen = new Set<string>();
        const events: { type: 'action.approved'; data: { id: string; approval: Approval } }[] = [];
        for (const item of input.approvals) {
            exactObject(item, ['actionId', 'digest'], 'operation approval');
            identifier(item.actionId, 'actionId'); nonempty(item.digest, 'approval digest');
            if (seen.has(item.actionId)) throw new Error('Duplicate action approval');
            seen.add(item.actionId);
            const action = this.operationAction(state, item.actionId);
            const work = required(state.works, action.workId, 'Work');
            if (action.status !== 'proposed') throw new Error('Action not awaiting approval');
            if (item.digest !== action.digest) throw new Error('Approval digest mismatch');
            if (work.revision !== action.workRevision || ['done', 'cancelled'].includes(work.phase)) throw new Error('Stale or closed work');
            events.push({ type: 'action.approved', data: { id: action.id,
                approval: { ownerId: input.ownerId, digest: item.digest, expiresAt: input.expiresAt } } });
        }
        this.store.append(input.workspaceId, state.version, events, { actorId: input.ownerId, recordedAt: now });
        const latest = this.store.state(input.workspaceId);
        return input.approvals.map(item => this.operationAction(latest, item.actionId));
    }

    async execute(input: ExecuteOperationInput): Promise<OperationAction> {
        exactObject(input, ['workspaceId', 'ownerId', 'actionId'], 'execute operation input');
        const initial = this.store.state(input.workspaceId);
        assertOwner(initial, input.ownerId);
        const action = this.executable(initial, input.actionId);
        if (['running', 'accepted', 'failed', 'unknown', 'cancelled'].includes(action.status)) return action;
        const connection = this.boundConnection(initial, action.command);
        const handler = this.registry.resolve(action.command.provider, action.command.operationId, action.command.operationVersion);
        const subject = await handler.identify({ connection: structuredClone(connection) });
        nonempty(subject, 'remote subject');
        if (subject !== action.command.subject) throw new Error('Remote identity does not match approved subject');
        this.executable(this.store.state(input.workspaceId), input.actionId, action, connection);
        const observationRequestedAt = this.now();
        const observed = await handler.observe({ connection: structuredClone(connection), resourceId: action.command.resourceId });
        const observation = validateObservationInput(observed, connection, action.command.resourceId, observationRequestedAt, this.now());
        this.executable(this.store.state(input.workspaceId), input.actionId, action, connection);
        if (handler.comparePrecondition({ expected: structuredClone(action.command.precondition), actual: structuredClone(observation) }) !== true)
            throw new Error('Operation precondition is stale');
        const finalState = this.store.state(input.workspaceId);
        const final = this.executable(finalState, input.actionId, action, connection);
        const attemptId = randomUUID();
        this.store.append(input.workspaceId, finalState.version,
            [{ type: 'action.started', data: { id: final.id, attemptId } }], { recordedAt: this.now() });
        let outcome;
        try {
            outcome = validateExecutionOutcome(await handler.execute({
                connection: structuredClone(connection), command: structuredClone(action.command), actionId: action.id, attemptId,
                idempotencyKey: action.key
            }));
        } catch {
            outcome = { status: 'unknown' as const,
                evidence: 'Provider outcome unavailable or invalid. Readback or owner reconciliation required.' };
        }
        const evidenceRef = this.store.putArtifact(input.workspaceId, outcome.evidence);
        const state = this.store.state(input.workspaceId);
        this.store.append(input.workspaceId, state.version, [{ type: 'action.finished', data: {
            id: action.id, attemptId, status: outcome.status, evidenceRef
        } }], { recordedAt: this.now() });
        return this.operationAction(this.store.state(input.workspaceId), action.id);
    }

    async verify(input: VerifyOperationInput): Promise<OperationAction> {
        exactObject(input, ['workspaceId', 'ownerId', 'actionId'], 'verify operation input');
        const initial = this.store.state(input.workspaceId);
        assertOwner(initial, input.ownerId);
        const action = this.operationAction(initial, input.actionId);
        if (!['accepted', 'unknown'].includes(action.status)) throw new Error('Action is not ready for verification');
        if (action.verification?.status === 'satisfied' || action.verification?.status === 'owner_attested') return action;
        const connection = this.boundConnection(initial, action.command);
        const handler = this.registry.resolve(action.command.provider, action.command.operationId, action.command.operationVersion);
        const subject = await handler.identify({ connection: structuredClone(connection) });
        nonempty(subject, 'remote subject');
        if (subject !== action.command.subject) throw new Error('Remote identity does not match operation subject');
        this.assertVerificationUnchanged(input.workspaceId, input.ownerId, action, connection);
        const observationRequestedAt = this.now();
        const observed = await handler.observe({ connection: structuredClone(connection), resourceId: action.command.resourceId });
        const observation = validateObservationInput(observed, connection, action.command.resourceId, observationRequestedAt, this.now());
        this.assertVerificationUnchanged(input.workspaceId, input.ownerId, action, connection);
        const verdict = validateVerdict(handler.verify({ connection: structuredClone(connection),
            command: structuredClone(action.command), observation: structuredClone(observation) }));
        const state = this.assertVerificationUnchanged(input.workspaceId, input.ownerId, action, connection);
        const verification: VerificationState = { status: verdict.status, observation, recordedAt: this.now() };
        const events = [];
        if (verdict.status === 'satisfied' && action.status === 'unknown') {
            const evidenceRef = this.store.putArtifact(input.workspaceId, 'Trusted readback observed the expected operation result.');
            events.push({ type: 'action.reconciled' as const, data: { id: action.id, status: 'accepted' as const, evidenceRef } });
        }
        events.push({ type: 'action.verification_recorded' as const, data: { id: action.id, verification } });
        this.store.append(input.workspaceId, state.version, events, { actorId: input.ownerId, recordedAt: this.now() });
        return this.operationAction(this.store.state(input.workspaceId), action.id);
    }

    reconcile(input: ReconcileOperationInput): OperationAction {
        exactObject(input, ['workspaceId', 'ownerId', 'actionId', 'status', 'evidence'], 'reconcile operation input');
        const state = this.store.state(input.workspaceId);
        assertOwner(state, input.ownerId);
        const action = this.operationAction(state, input.actionId);
        const acceptedUnresolved = action.status === 'accepted' && action.verification?.status !== 'satisfied' &&
            action.verification?.status !== 'owner_attested';
        if (action.status !== 'unknown' && !acceptedUnresolved) throw new Error('Only unknown or accepted unresolved actions can be reconciled');
        if (!['accepted', 'failed'].includes(input.status)) throw new Error('Invalid reconciliation status');
        if (action.status === 'accepted' && input.status !== 'accepted') throw new Error('Accepted action can only be owner-attested as accepted');
        nonempty(input.evidence, 'owner reconciliation evidence');
        if (Buffer.byteLength(input.evidence, 'utf8') > 262144) throw new Error('Owner evidence too large');
        const evidenceRef = this.store.putArtifact(input.workspaceId, input.evidence);
        const recordedAt = this.now();
        this.store.append(input.workspaceId, state.version, [
            { type: 'action.reconciled', data: { id: action.id, status: input.status, evidenceRef } },
            { type: 'action.verification_recorded', data: { id: action.id, verification: {
                status: 'owner_attested', resolution: input.status, evidenceRef, recordedAt
            } } }
        ], { actorId: input.ownerId, recordedAt });
        return this.operationAction(this.store.state(input.workspaceId), action.id);
    }

    recoverInterrupted(input: RecoverOperationsInput): number {
        exactObject(input, ['workspaceId', 'exclusiveMaintenance'], 'recover operations input');
        if (input.exclusiveMaintenance !== true) throw new Error('Exclusive maintenance required; all operation workers must be stopped');
        const running = Object.values(this.store.state(input.workspaceId).actions)
            .filter((action): action is OperationAction => action.status === 'running' && isOperationCommand(action.command));
        for (const action of running) {
            const evidenceRef = this.store.putArtifact(input.workspaceId, 'Interrupted execution; remote outcome is unknown. No automatic retry.');
            const state = this.store.state(input.workspaceId);
            this.store.append(input.workspaceId, state.version, [{ type: 'action.finished', data: {
                id: action.id, attemptId: action.attemptId!, status: 'unknown', evidenceRef
            } }], { recordedAt: this.now() });
        }
        return running.length;
    }

    private now(): string { const now = this.clock(); instant(now); return now; }

    private activeConnection(state: State, id: string): Connection {
        const connection = required(state.connections, id, 'Connection');
        validateConnection(connection);
        if (connection.status !== 'active') throw new Error('Connection is revoked');
        return connection;
    }

    private boundConnection(state: State, command: Pick<OperationCommand, 'connectionId' | 'provider' | 'subject' | 'connectionGeneration'>): Connection {
        const connection = this.activeConnection(state, command.connectionId);
        if (connection.provider !== command.provider || connection.subject !== command.subject ||
            connection.generation !== command.connectionGeneration) throw new Error('Operation connection binding or generation changed');
        return connection;
    }

    private operationAction(state: State, id: string): OperationAction {
        const action = required(state.actions, id, 'Action');
        if (!isOperationCommand(action.command)) throw new Error('Action is not a general operation');
        validateOperationCommand(action.command);
        return action as OperationAction;
    }

    private assertUnchanged(workspaceId: string, ownerId: string, workId: string, workRevision: number, connection: Connection): State {
        const state = this.store.state(workspaceId);
        assertOwner(state, ownerId);
        const work = required(state.works, workId, 'Work');
        if (work.revision !== workRevision || ['done', 'cancelled'].includes(work.phase)) throw new Error('Work changed during operation preparation');
        this.boundConnection(state, { connectionId: connection.id, provider: connection.provider, subject: connection.subject,
            connectionGeneration: connection.generation });
        return state;
    }

    private executable(state: State, id: string, expected?: OperationAction, connection?: Connection): OperationAction {
        const action = this.operationAction(state, id);
        if (expected && (action.digest !== expected.digest || action.status !== expected.status)) throw new Error('Operation action changed during preflight');
        if (connection) this.boundConnection(state, action.command);
        if (['running', 'accepted', 'failed', 'unknown', 'cancelled'].includes(action.status)) return action;
        if (action.status !== 'approved' || !action.approval) throw new Error('Operation requires owner approval');
        const work = required(state.works, action.workId, 'Work');
        if (work.revision !== action.workRevision || ['done', 'cancelled'].includes(work.phase)) throw new Error('Stale or closed work authorization');
        const now = this.now();
        if (Date.parse(action.approval.expiresAt) <= Date.parse(now)) throw new Error('Approval expired');
        if (action.approval.ownerId !== state.ownerId || action.approval.digest !== action.digest ||
            action.digest !== commandDigest(state.workspaceId, action.workId, action.workRevision, action.command))
            throw new Error('Approval digest binding mismatch');
        this.boundConnection(state, action.command);
        const scope = this.operationScope(state, action.command.provider, action.command.subject, action.id);
        if (scope.blocked) throw new Error('Operation subject conflict barrier');
        if (scope.revision !== action.command.subjectRevision) throw new Error('Stale operation subject revision');
        return action;
    }

    private assertVerificationUnchanged(workspaceId: string, ownerId: string, expected: OperationAction, connection: Connection): State {
        const state = this.store.state(workspaceId);
        assertOwner(state, ownerId);
        const action = this.operationAction(state, expected.id);
        if (action.digest !== expected.digest || action.status !== expected.status ||
            JSON.stringify(action.verification) !== JSON.stringify(expected.verification))
            throw new Error('Operation action changed during verification');
        this.boundConnection(state, action.command);
        if (connection.generation !== action.command.connectionGeneration) throw new Error('Connection generation changed');
        return state;
    }

    private assertPreparationUnchanged(workspaceId: string, ownerId: string, workId: string, workRevision: number,
        connection: Connection, subjectRevision: number): State {
        const state = this.assertUnchanged(workspaceId, ownerId, workId, workRevision, connection);
        const scope = this.operationScope(state, connection.provider, connection.subject);
        if (scope.blocked || scope.revision !== subjectRevision) throw new Error('Operation subject scope changed during preparation; prepare again');
        return state;
    }

    private operationScope(state: State, provider: string, subject: string, excludeActionId?: string): { revision: number; blocked: boolean } {
        const actions = Object.values(state.actions).filter(action => action.id !== excludeActionId &&
            isOperationCommand(action.command) && action.command.provider === provider && action.command.subject === subject);
        return {
            revision: actions.filter(action => Boolean(action.attemptId)).length,
            blocked: actions.some(action => action.status === 'running' || action.status === 'unknown' ||
                (action.status === 'accepted' && action.verification?.status !== 'satisfied' && action.verification?.status !== 'owner_attested'))
        };
    }
}
