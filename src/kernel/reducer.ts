import type { DomainEvent, Fact, State } from './types.js';
import { identifier, instant, nonempty, required } from './types.js';
import { exactObject, isOperationCommand, jsonValue, validateConnection, validateOperationCommand, validateStoredObservation } from '../operations/validation.js';
import { boundedMonitorJitter, canonicalInstant, monitoredActionCommandDigest, validateDigest, validateGrant } from '../monitoring/policy.js';
import type { MonitorState } from '../monitoring/types.js';
export function emptyState(workspaceId: string): State {
    return { workspaceId, ownerId: '', version: 0, works: {}, actions: {}, timers: {}, facts: {}, connections: {},
        monitoredActionGrants: {}, monitors: {} };
}

function monitoredGrant(state: State, id: string) {
    return required(state.monitoredActionGrants, id, 'Monitored action grant');
}

function monitor(state: State, id: string) { return required(state.monitors, id, 'Monitor'); }

function validateMonitor(value: MonitorState): void {
    exactObject(value, ['id', 'workspaceId', 'grantId', 'workId', 'adapter', 'adapterVersion', 'connectionId',
        'connectionGeneration', 'browserProfileId', 'subjectDigest', 'maxObservationAgeMs', 'intervalMs', 'jitterMs',
        'requestBudget', 'requestWindowMs', 'backoffBaseMs', 'backoffMaxMs', 'status', 'nextDueAt',
        'requestWindowStartedAt', 'requestsInWindow', 'lastObservation', 'lastCompleteObservationAt',
        'lastCompleteCoverage', 'consecutiveFailures', 'backoffMs', 'pauseReason', 'inFlightJobId'], 'monitor');
    for (const [item, label] of [[value.id, 'monitorId'], [value.workspaceId, 'workspaceId'], [value.grantId, 'grantId'],
        [value.workId, 'workId'], [value.adapter, 'adapter'], [value.connectionId, 'connectionId'],
        [value.browserProfileId, 'browserProfileId']] as const) identifier(item, label);
    if (!/^[a-f0-9]{64}$/.test(value.subjectDigest) || !Number.isSafeInteger(value.adapterVersion) || value.adapterVersion < 1 ||
        !Number.isSafeInteger(value.connectionGeneration) || value.connectionGeneration < 1 ||
        !Number.isSafeInteger(value.maxObservationAgeMs) || value.maxObservationAgeMs < 1 || value.maxObservationAgeMs > 300000 ||
        !Number.isSafeInteger(value.intervalMs) || value.intervalMs < 1000 || value.intervalMs > 86400000 ||
        !Number.isSafeInteger(value.jitterMs) || value.jitterMs < 0 || value.jitterMs > value.intervalMs ||
        !Number.isSafeInteger(value.requestBudget) || value.requestBudget < 1 || value.requestBudget > 1000 ||
        !Number.isSafeInteger(value.requestWindowMs) || value.requestWindowMs < value.intervalMs || value.requestWindowMs > 86400000 ||
        !Number.isSafeInteger(value.backoffBaseMs) || value.backoffBaseMs < 1000 ||
        !Number.isSafeInteger(value.backoffMaxMs) || value.backoffMaxMs < value.backoffBaseMs || value.backoffMaxMs > 86400000 ||
        !Number.isSafeInteger(value.requestsInWindow) || value.requestsInWindow < 0 || value.requestsInWindow > value.requestBudget ||
        !Number.isSafeInteger(value.consecutiveFailures) || value.consecutiveFailures < 0 ||
        !Number.isSafeInteger(value.backoffMs) || value.backoffMs < 0 || value.backoffMs > value.backoffMaxMs)
        throw new Error('Invalid monitor limits');
    if (!['active', 'paused', 'stopped'].includes(value.status)) throw new Error('Invalid monitor status');
    canonicalInstant(value.requestWindowStartedAt, 'request window');
    if (value.nextDueAt !== null) canonicalInstant(value.nextDueAt, 'monitor due time');
    if (value.lastCompleteObservationAt !== null) canonicalInstant(value.lastCompleteObservationAt, 'complete observation time');
    if (value.lastCompleteCoverage !== null) jsonValue(value.lastCompleteCoverage, 'complete observation coverage');
    if (value.inFlightJobId !== null) identifier(value.inFlightJobId, 'jobId');
    if (value.pauseReason !== null && !['session_expired', 'needs_human', 'rate_limited', 'contract_changed',
        'installation_changed', 'grant_unavailable'].includes(value.pauseReason)) throw new Error('Invalid monitor pause reason');
    if (value.lastObservation !== null) {
        exactObject(value.lastObservation, ['observedAt', 'complete', 'coverage', 'result'], 'monitor observation summary');
        canonicalInstant(value.lastObservation.observedAt, 'observation time');
        if (typeof value.lastObservation.complete !== 'boolean' ||
            !['complete', 'session_expired', 'needs_human', 'rate_limited', 'provider_unavailable', 'contract_changed']
                .includes(value.lastObservation.result)) throw new Error('Invalid monitor observation summary');
        jsonValue(value.lastObservation.coverage, 'observation coverage');
    }
}
/** Pure replay: no clock reads, random IDs, network, authorization reevaluation or LLM. */
export function reduce(previous: State, event: DomainEvent, seq: number, legacyFactObservedAt?: string): State {
    if (seq !== previous.version + 1)
        throw new Error('Non-contiguous journal sequence');
    const s = structuredClone(previous);
    s.connections ??= {};
    s.monitoredActionGrants ??= {};
    s.monitors ??= {};
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
        case 'monitored_action.grant_proposed': {
            exactObject(event.data, ['grant'], 'grant proposed event');
            const grant = event.data.grant;
            validateGrant(grant);
            if (grant.workspaceId !== s.workspaceId || grant.ownerId !== s.ownerId || grant.status !== 'pending' ||
                grant.activatedAt || grant.installationGeneration || grant.reservedActionId || grant.settlement)
                throw new Error('Invalid proposed monitored action grant');
            if (Object.hasOwn(s.monitoredActionGrants, grant.id)) throw new Error('Monitored action grant already exists');
            s.monitoredActionGrants[grant.id] = structuredClone(grant);
            break;
        }
        case 'monitored_action.grant_activated': {
            exactObject(event.data, ['id', 'digest', 'revision', 'ownerId', 'installationGeneration', 'activatedAt'], 'grant activation event');
            const grant = monitoredGrant(s, event.data.id);
            validateDigest(event.data.digest, 'grant digest'); identifier(event.data.ownerId, 'ownerId');
            identifier(event.data.installationGeneration, 'installationGeneration');
            canonicalInstant(event.data.activatedAt, 'activation time');
            if (grant.status !== 'pending' || event.data.ownerId !== s.ownerId || event.data.ownerId !== grant.ownerId ||
                event.data.digest !== grant.digest || event.data.revision !== grant.revision ||
                Date.parse(event.data.activatedAt) >= Date.parse(grant.expiresAt))
                throw new Error('Monitored action activation binding mismatch');
            grant.status = 'active'; grant.activatedAt = event.data.activatedAt;
            grant.installationGeneration = event.data.installationGeneration;
            break;
        }
        case 'monitored_action.grant_revoked': {
            exactObject(event.data, ['id', 'digest', 'revision', 'reason', 'revokedAt'], 'grant revocation event');
            const grant = monitoredGrant(s, event.data.id);
            validateDigest(event.data.digest, 'grant digest'); canonicalInstant(event.data.revokedAt, 'revocation time');
            if (!['owner_revoked', 'material_drift'].includes(event.data.reason) || event.data.digest !== grant.digest ||
                event.data.revision !== grant.revision || !['pending', 'active'].includes(grant.status))
                throw new Error('Invalid monitored action revocation');
            grant.status = 'revoked'; grant.revokedAt = event.data.revokedAt; grant.revocationReason = event.data.reason;
            for (const item of Object.values(s.monitors).filter(item => item.grantId === grant.id && item.status !== 'stopped')) {
                item.status = 'stopped'; item.nextDueAt = null;
            }
            break;
        }
        case 'monitored_action.grant_expired': {
            exactObject(event.data, ['id', 'digest', 'revision', 'expiredAt'], 'grant expiry event');
            const grant = monitoredGrant(s, event.data.id);
            validateDigest(event.data.digest, 'grant digest'); canonicalInstant(event.data.expiredAt, 'expiry event time');
            if (event.data.digest !== grant.digest || event.data.revision !== grant.revision ||
                !['pending', 'active'].includes(grant.status) || Date.parse(event.data.expiredAt) < Date.parse(grant.expiresAt))
                throw new Error('Invalid monitored action expiry');
            grant.status = 'expired';
            for (const item of Object.values(s.monitors).filter(item => item.grantId === grant.id && item.status !== 'stopped')) {
                item.status = 'stopped'; item.nextDueAt = null;
            }
            break;
        }
        case 'monitored_action.installation_reconciled': {
            exactObject(event.data, ['id', 'digest', 'revision', 'ownerId', 'installationGeneration', 'reconciledAt'], 'installation reconciliation event');
            const grant = monitoredGrant(s, event.data.id);
            validateDigest(event.data.digest, 'grant digest'); identifier(event.data.ownerId, 'ownerId');
            identifier(event.data.installationGeneration, 'installationGeneration');
            canonicalInstant(event.data.reconciledAt, 'reconciliation time');
            if (!['pending', 'active'].includes(grant.status) || (grant.status === 'active' && grant.reservedActionId) ||
                event.data.ownerId !== s.ownerId ||
                event.data.digest !== grant.digest || event.data.revision !== grant.revision)
                throw new Error('Installation reconciliation binding mismatch');
            if (grant.status === 'active') grant.installationGeneration = event.data.installationGeneration;
            break;
        }
        case 'monitored_action.command_narrowed': {
            exactObject(event.data, ['grantId', 'action'], 'monitored command event');
            const grant = monitoredGrant(s, event.data.grantId);
            const action = event.data.action;
            exactObject(action, ['id', 'workId', 'key', 'command', 'digest', 'workRevision', 'status',
                'monitoredGrant'], 'narrowed monitored action');
            identifier(action.id, 'actionId'); nonempty(action.key, 'operation key'); nonempty(action.digest, 'digest');
            if (!action.monitoredGrant || action.monitoredGrant.id !== grant.id || action.monitoredGrant.digest !== grant.digest ||
                action.monitoredGrant.revision !== grant.revision || action.status !== 'approved' || action.approval ||
                action.attemptId || action.evidenceRef || action.verification || grant.status !== 'active')
                throw new Error('Invalid narrowed monitored action');
            exactObject(action.monitoredGrant, ['id', 'digest', 'revision'], 'monitored grant reference');
            validateOperationCommand(action.command);
            const work = required(s.works, action.workId, 'Work');
            if (work.revision !== action.workRevision || ['done', 'cancelled'].includes(work.phase))
                throw new Error('Stale monitored action work');
            const actionKeyPrefix = `monitor:${grant.id}:`;
            if (!action.key.startsWith(actionKeyPrefix) || !/^[a-f0-9]{64}$/.test(action.key.slice(actionKeyPrefix.length)) ||
                action.digest !== monitoredActionCommandDigest(s.workspaceId, work.id, work.revision, grant, action.command))
                throw new Error('Monitored action command digest mismatch');
            if (Object.hasOwn(s.actions, action.id) || Object.values(s.actions).some(existing => existing.key === action.key))
                throw new Error('Duplicate action key');
            s.actions[action.id] = structuredClone(action);
            break;
        }
        case 'monitored_action.grant_reserved': {
            exactObject(event.data, ['id', 'digest', 'revision', 'actionId', 'attemptId', 'observationDigest', 'reservedAt'], 'grant reservation event');
            const grant = monitoredGrant(s, event.data.id);
            const action = required(s.actions, event.data.actionId, 'Action');
            validateDigest(event.data.digest, 'grant digest'); validateDigest(event.data.observationDigest, 'observation digest');
            identifier(event.data.attemptId, 'attemptId'); canonicalInstant(event.data.reservedAt, 'reservation time');
            if (grant.status !== 'active' || grant.reservedActionId || event.data.digest !== grant.digest ||
                event.data.revision !== grant.revision || Date.parse(event.data.reservedAt) >= Date.parse(grant.expiresAt) ||
                action.monitoredGrant?.id !== grant.id || action.monitoredGrant.digest !== grant.digest ||
                action.monitoredGrant.revision !== grant.revision ||
                action.key !== `monitor:${grant.id}:${event.data.observationDigest}`)
                throw new Error('Monitored action allowance is unavailable');
            grant.status = 'blocked'; grant.reservedActionId = action.id; grant.reservationAttemptId = event.data.attemptId;
            grant.reservationObservationDigest = event.data.observationDigest;
            break;
        }
        case 'monitored_action.grant_settled': {
            exactObject(event.data, ['id', 'actionId', 'outcome', 'settledAt'], 'grant settlement event');
            const grant = monitoredGrant(s, event.data.id);
            const action = required(s.actions, event.data.actionId, 'Action');
            canonicalInstant(event.data.settledAt, 'settlement time');
            const upgrading = grant.status === 'blocked' && grant.reservedActionId === action.id &&
                ['accepted_unverified', 'unknown', 'not_satisfied'].includes(grant.settlement?.outcome ?? '') &&
                event.data.outcome === 'accepted_verified';
            if (!['accepted_verified', 'accepted_unverified', 'failed', 'unknown', 'not_satisfied'].includes(event.data.outcome) ||
                grant.status !== 'blocked' || grant.reservedActionId !== action.id || (grant.settlement && !upgrading))
                throw new Error('Invalid monitored grant settlement');
            if (event.data.outcome === 'accepted_verified') {
                if (action.status !== 'accepted' || action.verification?.status !== 'satisfied')
                    throw new Error('Verified acceptance evidence is required');
                if (grant.settlement?.outcome === 'not_satisfied' &&
                    (Date.parse(action.verification.recordedAt) <= Date.parse(grant.settlement.settledAt) ||
                     Date.parse(action.verification.observation.observedAt) <= Date.parse(grant.settlement.settledAt)))
                    throw new Error('Later verified acceptance evidence is required');
                grant.status = 'consumed';
            } else if (event.data.outcome === 'unknown' && action.status !== 'unknown') throw new Error('Unknown settlement mismatch');
            else if (event.data.outcome === 'failed' && action.status !== 'failed') throw new Error('Failed settlement mismatch');
            else if (event.data.outcome === 'accepted_unverified' && action.status !== 'accepted') throw new Error('Acceptance settlement mismatch');
            else if (event.data.outcome === 'not_satisfied' && action.verification?.status !== 'not_satisfied')
                throw new Error('Not-satisfied settlement requires readback evidence');
            grant.settlement = { actionId: action.id, outcome: event.data.outcome, settledAt: event.data.settledAt };
            break;
        }
        case 'monitored_action.intent_recorded': {
            exactObject(event.data, ['id', 'grantId', 'attemptId', 'intentId', 'evidenceRef'], 'monitored intent event');
            const action = required(s.actions, event.data.id, 'Action');
            const grant = monitoredGrant(s, event.data.grantId);
            identifier(event.data.attemptId, 'attemptId'); identifier(event.data.intentId, 'intentId');
            nonempty(event.data.evidenceRef, 'intent evidence');
            if (action.status !== 'running' || action.attemptId !== event.data.attemptId || action.monitoredIntent ||
                action.monitoredGrant?.id !== grant.id || grant.status !== 'blocked' ||
                grant.reservedActionId !== action.id || grant.reservationAttemptId !== event.data.attemptId)
                throw new Error('Monitored intent binding mismatch');
            action.monitoredIntent = { intentId: event.data.intentId, attemptId: event.data.attemptId,
                evidenceRef: event.data.evidenceRef };
            break;
        }
        case 'monitored_action.confirmation_recorded': {
            exactObject(event.data, ['id', 'grantId', 'attemptId', 'referenceDigest', 'evidenceRef'],
                'monitored confirmation event');
            const action = required(s.actions, event.data.id, 'Action');
            const grant = monitoredGrant(s, event.data.grantId);
            identifier(event.data.attemptId, 'attemptId'); validateDigest(event.data.referenceDigest, 'confirmation reference');
            nonempty(event.data.evidenceRef, 'confirmation evidence');
            if (action.status !== 'running' || action.attemptId !== event.data.attemptId ||
                !action.monitoredIntent || action.monitoredConfirmation || action.monitoredGrant?.id !== grant.id ||
                grant.status !== 'blocked' || grant.reservedActionId !== action.id)
                throw new Error('Monitored confirmation binding mismatch');
            action.monitoredConfirmation = { referenceDigest: event.data.referenceDigest,
                attemptId: event.data.attemptId, evidenceRef: event.data.evidenceRef };
            break;
        }
        case 'monitor.configured': {
            exactObject(event.data, ['monitor'], 'monitor configured event');
            const configured = event.data.monitor;
            validateMonitor(configured);
            const grant = monitoredGrant(s, configured.grantId);
            const work = required(s.works, configured.workId, 'Work');
            if (configured.workspaceId !== s.workspaceId || configured.status !== 'active' || configured.inFlightJobId !== null ||
                configured.nextDueAt === null || configured.pauseReason !== null || configured.requestsInWindow !== 0 ||
                configured.lastObservation !== null || configured.lastCompleteObservationAt !== null ||
                configured.lastCompleteCoverage !== null || configured.consecutiveFailures !== 0 || configured.backoffMs !== 0 ||
                configured.adapter !== grant.adapter || configured.adapterVersion !== grant.adapterVersion ||
                configured.connectionId !== grant.connectionId || configured.connectionGeneration !== grant.connectionGeneration ||
                configured.browserProfileId !== grant.browserProfileId || configured.subjectDigest !== grant.subjectDigest ||
                grant.status !== 'active' || ['done', 'cancelled'].includes(work.phase) || Object.hasOwn(s.monitors, configured.id))
                throw new Error('Invalid monitor configuration');
            s.monitors[configured.id] = structuredClone(configured);
            break;
        }
        case 'monitor.poll_started': {
            exactObject(event.data, ['id', 'jobId', 'dueAt', 'startedAt', 'requestWindowStartedAt', 'requestsInWindow'], 'monitor poll event');
            const item = monitor(s, event.data.id);
            identifier(event.data.jobId, 'jobId'); canonicalInstant(event.data.dueAt, 'due time');
            canonicalInstant(event.data.startedAt, 'poll start'); canonicalInstant(event.data.requestWindowStartedAt, 'request window');
            const resetWindow = Date.parse(event.data.startedAt) >=
                Date.parse(item.requestWindowStartedAt) + item.requestWindowMs;
            const expectedWindowStart = resetWindow ? event.data.startedAt : item.requestWindowStartedAt;
            const expectedRequests = resetWindow ? 1 : item.requestsInWindow + 1;
            if (item.status !== 'active' || item.inFlightJobId !== null || item.nextDueAt !== event.data.dueAt ||
                Date.parse(event.data.dueAt) > Date.parse(event.data.startedAt) ||
                event.data.requestWindowStartedAt !== expectedWindowStart || event.data.requestsInWindow !== expectedRequests ||
                !Number.isSafeInteger(event.data.requestsInWindow) || event.data.requestsInWindow < 1 ||
                event.data.requestsInWindow > item.requestBudget)
                throw new Error('Invalid monitor poll admission');
            item.inFlightJobId = event.data.jobId; item.nextDueAt = null;
            item.requestWindowStartedAt = event.data.requestWindowStartedAt;
            item.requestsInWindow = event.data.requestsInWindow;
            break;
        }
        case 'monitor.budget_deferred': {
            exactObject(event.data, ['id', 'nextDueAt', 'deferredAt'], 'monitor budget event');
            const item = monitor(s, event.data.id);
            canonicalInstant(event.data.nextDueAt, 'next due time'); canonicalInstant(event.data.deferredAt, 'budget deferral time');
            if (item.status !== 'active' || item.inFlightJobId !== null || item.nextDueAt === null ||
                Date.parse(item.nextDueAt) > Date.parse(event.data.deferredAt) ||
                event.data.nextDueAt !== new Date(Date.parse(item.requestWindowStartedAt) + item.requestWindowMs).toISOString() ||
                Date.parse(event.data.nextDueAt) <= Date.parse(event.data.deferredAt)) throw new Error('Invalid monitor budget deferral');
            item.nextDueAt = event.data.nextDueAt;
            break;
        }
        case 'monitor.observation_recorded': {
            exactObject(event.data, ['id', 'jobId', 'observation', 'status', 'nextDueAt', 'consecutiveFailures',
                'backoffMs', 'pauseReason', 'recordedAt'], 'monitor observation event');
            const item = monitor(s, event.data.id);
            identifier(event.data.jobId, 'jobId'); canonicalInstant(event.data.recordedAt, 'observation record time');
            if (item.inFlightJobId !== event.data.jobId || !['active', 'paused'].includes(event.data.status) ||
                !Number.isSafeInteger(event.data.consecutiveFailures) || event.data.consecutiveFailures < 0 ||
                !Number.isSafeInteger(event.data.backoffMs) || event.data.backoffMs < 0 || event.data.backoffMs > item.backoffMaxMs)
                throw new Error('Invalid monitor observation transition');
            const successful = event.data.observation.complete && event.data.observation.result === 'complete';
            const paused = ['session_expired', 'needs_human', 'rate_limited', 'contract_changed']
                .includes(event.data.observation.result);
            const expectedFailures = successful ? 0 : item.consecutiveFailures + 1;
            const expectedBackoff = successful ? 0 : Math.min(item.backoffMaxMs,
                item.backoffMs === 0 ? item.backoffBaseMs : item.backoffMs * 2);
            const delay = successful ? item.intervalMs : expectedBackoff;
            const jitter = boundedMonitorJitter(delay, item.jitterMs);
            if (!paused) canonicalInstant(event.data.nextDueAt, 'next due time');
            const nextMilliseconds = event.data.nextDueAt === null ? NaN : Date.parse(event.data.nextDueAt);
            if (event.data.status !== (paused ? 'paused' : 'active') ||
                event.data.pauseReason !== (paused ? event.data.observation.result : null) ||
                event.data.consecutiveFailures !== expectedFailures || event.data.backoffMs !== expectedBackoff ||
                (paused ? event.data.nextDueAt !== null :
                    nextMilliseconds < Date.parse(event.data.recordedAt) + delay - jitter ||
                    nextMilliseconds > Date.parse(event.data.recordedAt) + delay + jitter))
                throw new Error('Invalid monitor observation provenance');
            const candidate = structuredClone(item); candidate.lastObservation = structuredClone(event.data.observation);
            candidate.status = event.data.status; candidate.nextDueAt = event.data.nextDueAt;
            candidate.consecutiveFailures = event.data.consecutiveFailures; candidate.backoffMs = event.data.backoffMs;
            candidate.pauseReason = event.data.pauseReason; candidate.inFlightJobId = null;
            if (event.data.observation.complete && event.data.observation.result === 'complete') {
                candidate.lastCompleteObservationAt = event.data.observation.observedAt;
                candidate.lastCompleteCoverage = structuredClone(event.data.observation.coverage);
            }
            validateMonitor(candidate); s.monitors[item.id] = candidate;
            break;
        }
        case 'monitor.interrupted': {
            exactObject(event.data, ['id', 'jobId', 'nextDueAt', 'interruptedAt'], 'monitor interruption event');
            const item = monitor(s, event.data.id);
            identifier(event.data.jobId, 'jobId'); canonicalInstant(event.data.nextDueAt, 'next due time');
            canonicalInstant(event.data.interruptedAt, 'interruption time');
            const delay = Math.min(item.backoffMaxMs, item.backoffMs === 0 ? item.backoffBaseMs : item.backoffMs * 2);
            if (item.inFlightJobId !== event.data.jobId ||
                event.data.nextDueAt !== new Date(Date.parse(event.data.interruptedAt) + delay).toISOString())
                throw new Error('Monitor interruption does not match in-flight job');
            item.inFlightJobId = null; item.nextDueAt = event.data.nextDueAt;
            item.consecutiveFailures++; item.backoffMs = Math.min(item.backoffMaxMs,
                item.backoffMs === 0 ? item.backoffBaseMs : item.backoffMs * 2);
            break;
        }
        case 'monitor.resumed': {
            exactObject(event.data, ['id', 'ownerId', 'nextDueAt', 'resumedAt'], 'monitor resume event');
            const item = monitor(s, event.data.id);
            identifier(event.data.ownerId, 'ownerId'); canonicalInstant(event.data.nextDueAt, 'next due time');
            canonicalInstant(event.data.resumedAt, 'resume time');
            if (item.status !== 'paused' || event.data.ownerId !== s.ownerId || item.inFlightJobId !== null)
                throw new Error('Invalid monitor resume');
            item.status = 'active'; item.nextDueAt = event.data.nextDueAt; item.pauseReason = null;
            item.consecutiveFailures = 0; item.backoffMs = 0;
            break;
        }
        case 'monitor.stopped': {
            exactObject(event.data, ['id', 'reason', 'stoppedAt'], 'monitor stop event');
            const item = monitor(s, event.data.id);
            canonicalInstant(event.data.stoppedAt, 'monitor stop time');
            if (!['grant_reserved', 'grant_terminal', 'owner_stopped'].includes(event.data.reason))
                throw new Error('Invalid monitor stop reason');
            const grant = monitoredGrant(s, item.grantId);
            if (event.data.reason === 'grant_terminal' && !['revoked', 'expired'].includes(grant.status))
                throw new Error('Monitor terminal stop requires terminal grant');
            if (event.data.reason === 'grant_reserved' &&
                (grant.status !== 'blocked' || grant.reservedActionId === undefined))
                throw new Error('Monitor reservation stop requires reserved grant');
            item.status = 'stopped'; item.nextDueAt = null; item.inFlightJobId = null;
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
            if (a.status !== 'proposed' || a.approval || a.attemptId || a.evidenceRef || a.monitoredGrant)
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
                if (a.monitoredGrant) {
                    const grant = monitoredGrant(s, a.monitoredGrant.id);
                    if (a.approval || grant.status !== 'blocked' || grant.digest !== a.monitoredGrant.digest ||
                        grant.revision !== a.monitoredGrant.revision || grant.reservedActionId !== a.id ||
                        grant.reservationAttemptId !== event.data.attemptId || grant.connectionId !== command.connectionId ||
                        grant.connectionGeneration !== command.connectionGeneration || grant.adapter !== command.operationId ||
                        String(grant.adapterVersion) !== command.operationVersion)
                        throw new Error('Monitored action reservation binding mismatch');
                }
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
            // observedAt was added after schema v1 journals existed. Storage supplies
            // the immutable source-record timestamp while replaying an older event.
            const raw = event.data.fact as Fact & { observedAt?: string };
            if (raw.observedAt !== undefined && legacyFactObservedAt !== undefined && raw.observedAt !== legacyFactObservedAt)
                throw new Error('Fact observedAt conflicts with source record timestamp');
            const groundedObservedAt = legacyFactObservedAt ?? raw.observedAt;
            if (groundedObservedAt === null || groundedObservedAt === undefined)
                throw new Error('Fact observation time is missing');
            const f: Fact = { ...raw, observedAt: groundedObservedAt };
            identifier(f.id);
            nonempty(f.subject, 'subject');
            nonempty(f.predicate, 'predicate');
            nonempty(f.value, 'value');
            nonempty(f.sourceRecordId, 'sourceRecordId');
            instant(f.observedAt);
            if (f.validFrom !== null)
                instant(f.validFrom);
            if (f.validTo !== null) {
                instant(f.validTo);
                if (f.validFrom !== null && Date.parse(f.validTo) <= Date.parse(f.validFrom))
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
    const startsAt = (fact: Fact): number => Date.parse(fact.validFrom ?? fact.observedAt);
    const superseded = new Set(claims.filter(f => f.supersedes && startsAt(f) <= time).map(f => f.supersedes!));
    const active = claims.filter(f => !superseded.has(f.id) && startsAt(f) <= time && (f.validTo === null || time < Date.parse(f.validTo)));
    return { status: active.length === 0 ? 'missing' : active.length === 1 ? 'resolved' : 'conflict', facts: structuredClone(active) };
}
