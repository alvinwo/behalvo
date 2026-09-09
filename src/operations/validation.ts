import { identifier, instant, nonempty } from '../kernel/types.js';
import type {
    Connection, HandlerVerificationVerdict, JsonValue, OperationCommand,
    OperationExecutionOutcome, OperationObservation, OperationPreparation
} from './types.js';

const UNSAFE_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const MAX_OBSERVATION_BYTES = 262144;
const MAX_PROVIDER_VERSION_BYTES = 4096;

export function exactObject(value: unknown, keys: readonly string[], label: string): asserts value is Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null))
        throw new Error(`Invalid ${label}`);
    for (const key of Object.keys(value)) if (!keys.includes(key)) throw new Error(`Unknown ${label} field: ${key}`);
}

export function jsonValue(value: unknown, label = 'JSON value'): JsonValue {
    let nodes = 0;
    function visit(current: unknown, depth: number): JsonValue {
        if (++nodes > 10000 || depth > 20) throw new Error(`${label} exceeds complexity limit`);
        if (current === null || typeof current === 'string' || typeof current === 'boolean') return current;
        if (typeof current === 'number') {
            if (!Number.isFinite(current)) throw new Error(`${label} contains a non-JSON number`);
            return current;
        }
        if (Array.isArray(current)) {
            for (let index = 0; index < current.length; index++) if (!Object.hasOwn(current, index)) throw new Error(`${label} contains a sparse array`);
            return current.map(item => visit(item, depth + 1));
        }
        if (!current || typeof current !== 'object' ||
            (Object.getPrototypeOf(current) !== Object.prototype && Object.getPrototypeOf(current) !== null))
            throw new Error(`${label} contains an unsupported value`);
        const result: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
        for (const [key, item] of Object.entries(current)) {
            if (UNSAFE_KEYS.has(key)) throw new Error(`${label} contains an unsafe key`);
            result[key] = visit(item, depth + 1);
        }
        return result;
    }
    const result = visit(value, 0);
    if (Buffer.byteLength(JSON.stringify(result), 'utf8') > 65536) throw new Error(`${label} exceeds size limit`);
    return result;
}

export function validateConnection(connection: Connection): void {
    exactObject(connection, ['id', 'provider', 'subject', 'label', 'generation', 'status'], 'connection');
    identifier(connection.id, 'connectionId');
    identifier(connection.provider, 'provider');
    identifier(connection.subject, 'subject');
    nonempty(connection.label, 'connection label');
    if (Buffer.byteLength(connection.label, 'utf8') > 200 || !Number.isSafeInteger(connection.generation) || connection.generation < 1 ||
        !['active', 'revoked'].includes(connection.status)) throw new Error('Invalid connection');
}

export function validateObservationInput(value: unknown, connection: Connection, resourceId: string, requestedAt: string, now: string): OperationObservation {
    exactObject(value, ['source', 'observedAt', 'state', 'providerVersion', 'resourceId'], 'observation');
    if ('resourceId' in value && value.resourceId !== resourceId) throw new Error('Observation resource scope mismatch');
    nonempty(value.source, 'observation source');
    if (Buffer.byteLength(value.source, 'utf8') > 200) throw new Error('Observation source too long');
    instant(value.observedAt);
    instant(requestedAt);
    instant(now);
    const age = Date.parse(now) - Date.parse(value.observedAt);
    if (age < 0 || age > 300000 || Date.parse(value.observedAt) < Date.parse(requestedAt)) throw new Error('Stale observation for current read request');
    if ('providerVersion' in value && value.providerVersion !== undefined) {
        nonempty(value.providerVersion, 'provider version');
        if (Buffer.byteLength(value.providerVersion, 'utf8') > MAX_PROVIDER_VERSION_BYTES) throw new Error('Provider version exceeds size limit');
    }
    const observation: OperationObservation = {
        connectionId: connection.id, provider: connection.provider, subject: connection.subject,
        connectionGeneration: connection.generation, resourceId, source: value.source,
        observedAt: value.observedAt, state: jsonValue(value.state, 'observation state'),
        ...(typeof value.providerVersion === 'string' ? { providerVersion: value.providerVersion } : {})
    };
    validateStoredObservation(observation);
    return observation;
}

export function validateStoredObservation(value: unknown): asserts value is OperationObservation {
    exactObject(value, ['connectionId', 'provider', 'subject', 'connectionGeneration', 'resourceId', 'source', 'observedAt',
        'state', 'providerVersion'], 'stored observation');
    for (const [key, label] of [['connectionId', 'connectionId'], ['provider', 'provider'], ['subject', 'subject'],
        ['resourceId', 'resourceId']] as const) identifier(value[key], label);
    if (!Number.isSafeInteger(value.connectionGeneration) || Number(value.connectionGeneration) < 1)
        throw new Error('Invalid observation connection generation');
    nonempty(value.source, 'observation source');
    if (Buffer.byteLength(value.source, 'utf8') > 200) throw new Error('Observation source too long');
    instant(value.observedAt);
    jsonValue(value.state, 'observation state');
    if ('providerVersion' in value && value.providerVersion !== undefined) {
        nonempty(value.providerVersion, 'provider version');
        if (Buffer.byteLength(value.providerVersion, 'utf8') > MAX_PROVIDER_VERSION_BYTES) throw new Error('Provider version exceeds size limit');
    }
    if (Buffer.byteLength(JSON.stringify(value), 'utf8') > MAX_OBSERVATION_BYTES) throw new Error('Observation exceeds size limit');
}

export function validatePreparation(value: unknown): OperationPreparation {
    exactObject(value, ['arguments', 'affectedResourceIds', 'expectedResult'], 'operation preparation');
    if (!Array.isArray(value.affectedResourceIds) || value.affectedResourceIds.length === 0 || value.affectedResourceIds.length > 100)
        throw new Error('Invalid affected resource IDs');
    const ids = value.affectedResourceIds.map((id, index) => { identifier(id, `affectedResourceIds[${index}]`); return id; });
    if (new Set(ids).size !== ids.length) throw new Error('Duplicate affected resource ID');
    return { arguments: jsonValue(value.arguments, 'operation arguments'), affectedResourceIds: ids,
        expectedResult: jsonValue(value.expectedResult, 'expected result') };
}

export function validateExecutionOutcome(value: unknown): OperationExecutionOutcome {
    exactObject(value, ['status', 'evidence'], 'operation outcome');
    if (typeof value.status !== 'string' || !['accepted', 'failed', 'unknown'].includes(value.status)) throw new Error('Invalid operation outcome status');
    nonempty(value.evidence, 'operation evidence');
    if (Buffer.byteLength(value.evidence, 'utf8') > 262144) throw new Error('Operation evidence too large');
    return { status: value.status as OperationExecutionOutcome['status'], evidence: value.evidence };
}

export function validateVerdict(value: unknown): HandlerVerificationVerdict {
    exactObject(value, ['status'], 'verification verdict');
    if (typeof value.status !== 'string' || !['satisfied', 'not_satisfied', 'unknown'].includes(value.status)) throw new Error('Invalid verification verdict status');
    return { status: value.status as HandlerVerificationVerdict['status'] };
}

export function isOperationCommand(command: { kind: string }): command is OperationCommand {
    return command.kind === 'operation.execute';
}

export function validateOperationCommand(value: unknown): asserts value is OperationCommand {
    exactObject(value, ['kind', 'operationId', 'operationVersion', 'connectionId', 'provider', 'subject', 'connectionGeneration',
        'resourceId', 'arguments', 'affectedResourceIds', 'precondition', 'expectedResult', 'subjectRevision', 'requestFingerprint'], 'operation command');
    if (value.kind !== 'operation.execute') throw new Error('Invalid operation command kind');
    for (const [key, label] of [['operationId', 'operationId'], ['operationVersion', 'operationVersion'], ['connectionId', 'connectionId'],
        ['provider', 'provider'], ['subject', 'subject'], ['resourceId', 'resourceId']] as const) identifier(value[key], label);
    if (typeof value.requestFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(value.requestFingerprint))
        throw new Error('Invalid operation request fingerprint');
    if (!Number.isSafeInteger(value.connectionGeneration) || Number(value.connectionGeneration) < 1 ||
        !Number.isSafeInteger(value.subjectRevision) || Number(value.subjectRevision) < 0) throw new Error('Invalid operation revision');
    jsonValue(value.arguments, 'operation arguments');
    jsonValue(value.expectedResult, 'expected result');
    exactObject(value.precondition, ['state', 'providerVersion', 'source', 'observedAt'], 'operation precondition');
    jsonValue(value.precondition.state, 'precondition state');
    if ('providerVersion' in value.precondition && value.precondition.providerVersion !== undefined)
        {
            nonempty(value.precondition.providerVersion, 'provider version');
            if (Buffer.byteLength(value.precondition.providerVersion, 'utf8') > MAX_PROVIDER_VERSION_BYTES)
                throw new Error('Provider version exceeds size limit');
        }
    nonempty(value.precondition.source, 'observation source');
    if (Buffer.byteLength(value.precondition.source, 'utf8') > 200) throw new Error('Observation source too long');
    instant(value.precondition.observedAt);
    if (!Array.isArray(value.affectedResourceIds) || value.affectedResourceIds.length === 0 || value.affectedResourceIds.length > 100)
        throw new Error('Invalid affected resources');
    for (const id of value.affectedResourceIds) identifier(id, 'affected resource ID');
    if (new Set(value.affectedResourceIds).size !== value.affectedResourceIds.length) throw new Error('Duplicate affected resource ID');
    if (!value.affectedResourceIds.includes(value.resourceId)) throw new Error('Primary resource missing from affected resources');
}

export function canonicalJson(value: JsonValue): string {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key]!)}`).join(',')}}`;
}
