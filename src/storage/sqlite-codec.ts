import { createHash } from 'node:crypto';
import type { DomainEvent, JournalRecord, MessageInput, State, Summary } from '../kernel/types.js';
import type { PayloadCipher } from './payload-cipher.js';
import type { ServiceEnvelope, ServiceJob, ServiceReceipt, ServiceRequestIdentity } from './service-jobs.js';
import { canonicalJson } from '../operations/validation.js';
import type { JsonValue } from '../operations/types.js';

export type Row = Record<string, string | number | bigint | Uint8Array | null>;
type Context = readonly (string | number | null)[];
export function seal(value: string, context: Context, cipher?: PayloadCipher): string { return cipher ? cipher.seal(value, context) : value; }
export function open(value: unknown, context: Context, cipher?: PayloadCipher): string {
    if (typeof value !== 'string') throw new Error('Invalid stored payload.');
    return cipher ? cipher.open(value, context) : value;
}
export function journalContext(record: Omit<JournalRecord, 'event' | 'actorId'>, field: 'event_json' | 'actor_id'): Context {
    return ['journal', field, record.workspaceId, record.id, record.seq, record.schemaVersion, record.recordedAt, record.causationId];
}
export function decodeRecord(row: Row, cipher?: PayloadCipher): JournalRecord {
    if (row.schema_version !== 1) throw new Error('Unsupported journal schema version');
    const metadata = { id: String(row.id), schemaVersion: 1 as const, workspaceId: String(row.workspace_id), seq: Number(row.seq),
        recordedAt: String(row.recorded_at), causationId: row.causation_id === null ? null : String(row.causation_id) };
    return { ...metadata, actorId: open(row.actor_id, journalContext(metadata, 'actor_id'), cipher),
        event: JSON.parse(open(row.event_json, journalContext(metadata, 'event_json'), cipher)) as DomainEvent };
}
export function projectionContext(workspaceId: string, version: number, projectionVersion: number): Context {
    return ['projections', 'state_json', workspaceId, version, projectionVersion];
}
export function decodeProjection(row: Row, cipher?: PayloadCipher): State {
    if (row.projection_version !== 1) throw new Error('Unsupported projection version; rebuild required');
    return JSON.parse(open(row.state_json, projectionContext(String(row.workspace_id), Number(row.version), Number(row.projection_version)), cipher)) as State;
}
export function artifactContext(workspaceId: string, id: string): Context { return ['artifacts', 'body', workspaceId, id]; }
export function summaryThread(workspaceId: string, threadId: string, cipher?: PayloadCipher): string {
    return cipher ? cipher.lookup('summaries/thread', workspaceId, [threadId]) : threadId;
}
export function summaryContext(workspaceId: string, id: string, thread: string, createdAt: string, field: 'body' | 'source_ids'): Context {
    return ['summaries', field, workspaceId, id, thread, createdAt];
}
export function decodeSummary(row: Row, threadId: string, cipher?: PayloadCipher): Summary {
    const id = String(row.id), workspaceId = String(row.workspace_id), createdAt = String(row.created_at);
    return { id, workspaceId, threadId, createdAt,
        sourceIds: JSON.parse(open(row.source_ids, summaryContext(workspaceId, id, String(row.thread_id), createdAt, 'source_ids'), cipher)) as string[],
        text: open(row.body, summaryContext(workspaceId, id, String(row.thread_id), createdAt, 'body'), cipher) };
}
export function deliveryTokens(workspaceId: string, source: string, externalId: string, fingerprintValues: string[], cipher?: PayloadCipher): {
    source: string; externalId: string; fingerprint: string;
} {
    return cipher ? {
        source: cipher.lookup('inbox/source', workspaceId, [source]),
        externalId: cipher.lookup('inbox/external', workspaceId, [source, externalId]),
        fingerprint: cipher.lookup('inbox/fingerprint', workspaceId, fingerprintValues)
    } : { source, externalId, fingerprint: createHash('sha256').update(JSON.stringify(fingerprintValues)).digest('hex') };
}
export function messageTokens(workspaceId: string, input: MessageInput, cipher?: PayloadCipher): ReturnType<typeof deliveryTokens> {
    return deliveryTokens(workspaceId, input.source, input.externalId,
        [input.source, input.externalId, input.threadId, input.senderId, input.senderRole, input.text], cipher);
}
export function timerTokens(workspaceId: string, timerId: string, cipher?: PayloadCipher): ReturnType<typeof deliveryTokens> {
    return cipher ? deliveryTokens(workspaceId, 'kernel:timer', timerId, [timerId], cipher)
        : { source: 'kernel:timer', externalId: timerId, fingerprint: timerId };
}

export function canonicalServiceEnvelope(envelope: ServiceEnvelope): string {
    return canonicalJson(envelope as unknown as JsonValue);
}

export function serviceRequestTokens(identity: ServiceRequestIdentity, envelope: ServiceEnvelope, cipher?: PayloadCipher): {
    source: string; requestId: string; fingerprint: string;
} {
    const canonical = canonicalServiceEnvelope(envelope);
    return cipher ? {
        source: cipher.lookup('service/source', identity.workspaceId, [identity.source]),
        requestId: cipher.lookup('service/request', identity.workspaceId, [identity.source, identity.requestId]),
        fingerprint: cipher.lookup('service/fingerprint', identity.workspaceId,
            [identity.source, identity.requestId, canonical])
    } : {
        source: identity.source,
        requestId: identity.requestId,
        fingerprint: createHash('sha256').update(JSON.stringify([identity.source, identity.requestId, canonical])).digest('hex')
    };
}

export function serviceRequestContext(row: Row, field: 'envelope_json' | 'receipt_json'): Context {
    return ['service_requests', field, String(row.workspace_id), String(row.source), String(row.request_id),
        String(row.fingerprint), String(row.receipt_id), String(row.admitted_at)];
}

export function serviceJobContext(row: Row): Context {
    return ['service_jobs', 'job_json', Number(row.position), String(row.id), String(row.workspace_id),
        String(row.receipt_id), String(row.kind), String(row.status), String(row.admitted_at),
        row.started_at === null ? null : String(row.started_at), row.finished_at === null ? null : String(row.finished_at),
        row.claim_id === null ? null : String(row.claim_id), row.instance_id === null ? null : String(row.instance_id),
        row.attempt_id === null ? null : String(row.attempt_id)];
}

export function decodeServiceReceipt(row: Row, cipher?: PayloadCipher): ServiceReceipt {
    return JSON.parse(open(row.receipt_json, serviceRequestContext(row, 'receipt_json'), cipher)) as ServiceReceipt;
}

export function decodeServiceEnvelope(row: Row, cipher?: PayloadCipher): ServiceEnvelope {
    return JSON.parse(open(row.envelope_json, serviceRequestContext(row, 'envelope_json'), cipher)) as ServiceEnvelope;
}

export function decodeServiceJob(row: Row, cipher?: PayloadCipher): ServiceJob {
    return JSON.parse(open(row.job_json, serviceJobContext(row), cipher)) as ServiceJob;
}
