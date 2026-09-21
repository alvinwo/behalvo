import type { DatabaseSync } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';
import { emptyState, reduce } from '../kernel/reducer.js';
import type { JournalRecord, State } from '../kernel/types.js';
import { identifier, instant, nonempty } from '../kernel/types.js';
import type { PayloadCipher } from './payload-cipher.js';
import { artifactContext, canonicalServiceEnvelope, decodeProjection, decodeRecord, decodeServiceEnvelope, decodeServiceJob, decodeServiceReceipt, decodeSummary, messageTokens, open, serviceRequestTokens, summaryThread, timerTokens } from './sqlite-codec.js';
import { validateEncryptedSchema } from './sqlite-schema.js';
import type { ServiceEnvelope, ServiceJob, ServiceJobResult, ServiceReceipt } from './service-jobs.js';

function requireValid(condition: unknown): asserts condition {
    if (!condition) throw new Error('Invalid encrypted database snapshot.');
}

function exactObject(value: unknown, required: readonly string[], optional: readonly string[] = []): asserts value is Record<string, unknown> {
    requireValid(Boolean(value) && typeof value === 'object' && !Array.isArray(value));
    const keys = Object.keys(value as object);
    requireValid(required.every(key => keys.includes(key)) && keys.every(key => required.includes(key) || optional.includes(key)));
}

/** Shared by public service writers and read-only snapshot verification. */
export function verifyServiceEnvelope(envelope: ServiceEnvelope): void {
    if (envelope.kind === 'owner_turn') {
        exactObject(envelope, ['kind', 'threadId', 'text'], ['workId']);
        identifier(envelope.threadId, 'threadId');
        if (envelope.workId !== undefined) identifier(envelope.workId, 'workId');
        nonempty(envelope.text, 'owner input');
        requireValid(Buffer.byteLength(envelope.text, 'utf8') <= 262144);
    } else if (envelope.kind === 'execute' || envelope.kind === 'readback') {
        exactObject(envelope, ['kind', 'actionId', 'digest']);
        identifier(envelope.actionId, 'actionId'); nonempty(envelope.digest, 'action digest');
        requireValid(Buffer.byteLength(envelope.digest, 'utf8') <= 4096);
    } else if (envelope.kind === 'schedule_reminder') {
        exactObject(envelope, ['kind', 'workId', 'dueAt']);
        identifier(envelope.workId, 'workId'); instant(envelope.dueAt);
    } else if (envelope.kind === 'reminder') {
        exactObject(envelope, ['kind', 'timerId', 'workId']);
        identifier(envelope.timerId, 'timerId'); identifier(envelope.workId, 'workId');
    } else requireValid(false);
}

export function verifyServiceModel(model: { provider: string; model: string }): void {
    exactObject(model, ['provider', 'model']);
    nonempty(model.provider, 'model provider'); nonempty(model.model, 'model');
    requireValid(Buffer.byteLength(model.provider, 'utf8') <= 200 && Buffer.byteLength(model.model, 'utf8') <= 500);
}

function verifyServiceReceipt(receipt: ServiceReceipt, envelope: ServiceEnvelope, workspaceId: string): void {
    exactObject(receipt, ['id', 'workspaceId', 'source', 'requestId', 'kind', 'admittedAt'], ['jobId', 'timerId']);
    identifier(receipt.id, 'receiptId'); identifier(receipt.workspaceId, 'workspaceId');
    identifier(receipt.source, 'source'); identifier(receipt.requestId, 'requestId'); instant(receipt.admittedAt);
    requireValid(receipt.workspaceId === workspaceId && receipt.kind === envelope.kind);
    if (receipt.jobId !== undefined) identifier(receipt.jobId, 'jobId');
    if (receipt.timerId !== undefined) identifier(receipt.timerId, 'timerId');
    requireValid(envelope.kind === 'schedule_reminder'
        ? receipt.timerId !== undefined && receipt.jobId === undefined
        : receipt.jobId !== undefined && receipt.timerId === undefined);
}

export function verifyServiceResult(result: ServiceJobResult, job: ServiceJob, prior: Map<string, JournalRecord>): void {
    exactObject(result, ['reason', 'recordIds'], ['assistantRecordId', 'actionId', 'attemptId', 'actionRecordId',
        'verificationRecordId', 'timerId']);
    requireValid(['completed', 'prepared_for_review', 'model_unavailable', 'invalid_model_result', 'deadline', 'cancelled',
        'action_ineligible', 'action_failed', 'action_unknown', 'readback_unresolved', 'process_interrupted'].includes(result.reason));
    if (job.status === 'interrupted') requireValid(result.reason === 'process_interrupted');
    requireValid(Array.isArray(result.recordIds) && result.recordIds.length <= 1000 &&
        new Set(result.recordIds).size === result.recordIds.length);
    for (const field of ['assistantRecordId', 'actionId', 'attemptId', 'actionRecordId', 'verificationRecordId', 'timerId'] as const)
        if (result[field] !== undefined) identifier(result[field], field);
    const records = new Map<string, JournalRecord>();
    for (const id of result.recordIds) {
        identifier(id, 'recordId');
        const record = prior.get(id); requireValid(record); records.set(id, record);
    }
    if (result.assistantRecordId !== undefined) {
        const record = records.get(result.assistantRecordId);
        requireValid(record?.event.type === 'message.received' && record.event.data.senderRole === 'agent');
    }
    if (job.kind === 'execute' || job.kind === 'readback') {
        requireValid(job.parameters.kind === job.kind);
        if (job.status === 'finished') requireValid(result.reason === 'completed');
        if (job.status === 'stopped') requireValid(result.reason !== 'completed' && result.reason !== 'process_interrupted');
        if (job.kind === 'execute' && job.attemptId === undefined) {
            const validPreStart = (job.status === 'stopped' && ['action_ineligible', 'cancelled', 'deadline'].includes(result.reason)) ||
                (job.status === 'interrupted' && result.reason === 'process_interrupted');
            requireValid(validPreStart && result.recordIds.length === 0 && result.actionId === undefined &&
                result.attemptId === undefined && result.actionRecordId === undefined && result.verificationRecordId === undefined);
        }
        if (job.kind === 'readback') {
            const hasOutcome = result.actionId !== undefined || result.actionRecordId !== undefined ||
                result.attemptId !== undefined || result.verificationRecordId !== undefined;
            if (hasOutcome) requireValid(job.actionRecordId !== undefined && result.actionRecordId === job.actionRecordId &&
                result.actionId === job.parameters.actionId && result.attemptId !== undefined);
            else requireValid(result.recordIds.length === 0 &&
                ((job.status === 'stopped' && ['action_ineligible', 'cancelled', 'deadline'].includes(result.reason)) ||
                (job.status === 'interrupted' && result.reason === 'process_interrupted')));
        }
        if (result.actionId !== undefined) requireValid(result.actionId === job.parameters.actionId);
        if (result.actionRecordId !== undefined) {
            const record = records.get(result.actionRecordId);
            requireValid(record?.event.type === 'action.finished' && record.event.data.id === job.parameters.actionId &&
                record.event.data.attemptId === result.attemptId);
            // An explicit readback reports its own exact verdict, not a new effect outcome.
            if (job.kind === 'readback' && result.verificationRecordId !== undefined) {
                requireValid(record.event.data.status === 'accepted' || record.event.data.status === 'unknown');
            } else {
                const reason = record.event.data.status === 'failed' ? 'action_failed'
                    : record.event.data.status === 'unknown' && job.kind === 'execute' ? 'action_unknown'
                    : result.reason === 'completed' ? 'completed' : 'readback_unresolved';
                requireValid(result.reason === reason && job.status === (reason === 'completed' ? 'finished' : 'stopped'));
            }
        }
        if (result.verificationRecordId !== undefined) {
            const record = records.get(result.verificationRecordId);
            requireValid(record?.event.type === 'action.verification_recorded' && record.event.data.id === job.parameters.actionId);
        }
        if (job.verificationRecordId !== undefined) {
            identifier(job.verificationRecordId, 'verificationRecordId');
            const record = prior.get(job.verificationRecordId);
            requireValid(record?.event.type === 'action.verification_recorded' && record.event.data.id === job.parameters.actionId &&
                record.event.data.verification.status !== 'owner_attested');
            if (job.status !== 'running') requireValid(result.verificationRecordId === job.verificationRecordId &&
                records.has(job.verificationRecordId));
        } else requireValid(result.verificationRecordId === undefined);
        if (job.attemptId !== undefined && job.status !== 'interrupted')
            requireValid(result.actionId === job.parameters.actionId && result.attemptId === job.attemptId && result.actionRecordId !== undefined);
        if (result.reason === 'completed') {
            const verification = result.verificationRecordId === undefined
                ? undefined : records.get(result.verificationRecordId);
            requireValid(verification?.event.type === 'action.verification_recorded' &&
                verification.event.data.verification.status === 'satisfied');
            if (job.kind === 'execute') {
                const outcome = result.actionRecordId === undefined ? undefined : records.get(result.actionRecordId);
                requireValid(outcome?.event.type === 'action.finished' && outcome.event.data.status === 'accepted');
            }
            requireValid(job.status === 'finished');
        }
        if (result.verificationRecordId !== undefined && result.reason !== 'completed') {
            const verification = records.get(result.verificationRecordId);
            requireValid(verification?.event.type === 'action.verification_recorded' &&
                verification.event.data.verification.status !== 'satisfied' &&
                result.reason === 'readback_unresolved' && job.status === 'stopped');
        }
        for (const record of records.values()) {
            const relatedStart = record.event.type === 'action.started' && record.event.data.id === job.parameters.actionId &&
                job.attemptId !== undefined && record.event.data.attemptId === job.attemptId;
            const relatedOutcome = record.event.type === 'action.finished' && record.event.data.id === job.parameters.actionId &&
                (job.attemptId === undefined || record.event.data.attemptId === job.attemptId);
            const relatedVerification = record.event.type === 'action.verification_recorded' &&
                record.event.data.id === job.parameters.actionId;
            requireValid(relatedStart || relatedOutcome || relatedVerification);
        }
    } else if (job.kind === 'reminder') {
        requireValid(job.parameters.kind === 'reminder' && result.timerId === job.parameters.timerId &&
            records.has(job.parameters.timerRecordId));
        if (job.status === 'interrupted') requireValid(result.recordIds.length === 1);
    }
}

function verifyServiceWorkspace(db: DatabaseSync, cipher: PayloadCipher, workspaceId: string,
    prior: Map<string, JournalRecord>, inboxRecords: Set<string>, artifacts: Map<string, string>, state: State): void {
    const requests = new Map<string, { receipt: ServiceReceipt; envelope: ServiceEnvelope }>();
    for (const row of db.prepare('SELECT * FROM service_requests WHERE workspace_id=?').all(workspaceId)) {
        const envelope = decodeServiceEnvelope(row, cipher);
        const receipt = decodeServiceReceipt(row, cipher);
        verifyServiceEnvelope(envelope); verifyServiceReceipt(receipt, envelope, workspaceId);
        requireValid(row.receipt_id === receipt.id && row.admitted_at === receipt.admittedAt && !requests.has(receipt.id));
        const tokens = serviceRequestTokens(receipt, envelope, cipher);
        requireValid(row.source === tokens.source && row.request_id === tokens.requestId && row.fingerprint === tokens.fingerprint);
        // Ensure the protected submitted envelope, rather than normalized job parameters, controls equality.
        requireValid(canonicalServiceEnvelope(decodeServiceEnvelope(row, cipher)) === canonicalServiceEnvelope(envelope));
        requests.set(receipt.id, { receipt, envelope });
    }

    const jobs = new Set<string>();
    for (const row of db.prepare('SELECT * FROM service_jobs WHERE workspace_id=? ORDER BY position').all(workspaceId)) {
        const job = decodeServiceJob(row, cipher);
        exactObject(job, ['id', 'workspaceId', 'receiptId', 'position', 'kind', 'status', 'admittedAt', 'admittedBy', 'parameters'],
            ['startedAt', 'finishedAt', 'claim', 'attemptId', 'actionRecordId', 'verificationRecordId', 'result']);
        identifier(job.id, 'jobId'); identifier(job.workspaceId, 'workspaceId'); identifier(job.receiptId, 'receiptId');
        identifier(job.admittedBy, 'instanceId'); instant(job.admittedAt);
        requireValid(job.workspaceId === workspaceId && Number.isSafeInteger(job.position) && job.position > 0 &&
            job.position === Number(row.position) && job.id === row.id && job.receiptId === row.receipt_id &&
            job.kind === row.kind && job.status === row.status && job.admittedAt === row.admitted_at && !jobs.has(job.id));
        requireValid(['owner_turn', 'execute', 'readback', 'reminder'].includes(job.kind) &&
            ['queued', 'running', 'finished', 'stopped', 'interrupted'].includes(job.status));
        requireValid(job.actionRecordId === undefined || job.kind === 'readback');
        const request = requests.get(job.receiptId);
        requireValid(request?.receipt.jobId === job.id && request.envelope.kind === job.kind);

        if (job.kind === 'owner_turn') {
            exactObject(job.parameters, ['kind', 'ownerRecordId', 'threadId', 'model', 'windowTokens', 'outputReserve', 'capability'], ['workId']);
            requireValid(job.parameters.kind === 'owner_turn');
            identifier(job.parameters.ownerRecordId, 'recordId'); identifier(job.parameters.threadId, 'threadId');
            if (job.parameters.workId !== undefined) identifier(job.parameters.workId, 'workId');
            verifyServiceModel(job.parameters.model);
            requireValid(Number.isSafeInteger(job.parameters.windowTokens) && Number.isSafeInteger(job.parameters.outputReserve) &&
                job.parameters.windowTokens > job.parameters.outputReserve && job.parameters.outputReserve >= 0 &&
                job.parameters.capability === 'prepare_only');
            const ownerRecord = prior.get(job.parameters.ownerRecordId);
            requireValid(ownerRecord?.event.type === 'message.received' && ownerRecord.event.data.senderRole === 'owner' &&
                ownerRecord.event.data.threadId === job.parameters.threadId && ownerRecord.event.data.senderId === state.ownerId &&
                ownerRecord.event.data.source === request?.receipt.source && ownerRecord.event.data.externalId === request.receipt.requestId &&
                request.envelope.kind === 'owner_turn' && artifacts.get(ownerRecord.event.data.artifactId) === request.envelope.text &&
                inboxRecords.has(ownerRecord.id));
        } else if (job.kind === 'execute' || job.kind === 'readback') {
            exactObject(job.parameters, ['kind', 'actionId', 'digest']);
            requireValid(job.parameters.kind === job.kind && request?.envelope.kind === job.kind &&
                request.envelope.actionId === job.parameters.actionId && request.envelope.digest === job.parameters.digest);
            const action = state.actions[job.parameters.actionId];
            requireValid(action?.digest === job.parameters.digest);
            if (job.actionRecordId !== undefined) {
                identifier(job.actionRecordId, 'actionRecordId');
                const outcome = prior.get(job.actionRecordId);
                requireValid(job.kind === 'readback' && outcome?.event.type === 'action.finished' &&
                    outcome.event.data.id === job.parameters.actionId && outcome.event.data.attemptId === action.attemptId);
            }
            if (job.verificationRecordId !== undefined) {
                const verification = prior.get(job.verificationRecordId);
                requireValid(verification?.event.type === 'action.verification_recorded' &&
                    verification.event.data.id === job.parameters.actionId &&
                    verification.event.data.verification.status !== 'owner_attested');
                if (job.kind === 'readback') requireValid(job.actionRecordId !== undefined);
            }
        } else {
            exactObject(job.parameters, ['kind', 'timerId', 'workId', 'timerRecordId']);
            requireValid(job.parameters.kind === 'reminder' && request?.envelope.kind === 'reminder' &&
                request.envelope.timerId === job.parameters.timerId && request.envelope.workId === job.parameters.workId);
            const timerRecord = prior.get(job.parameters.timerRecordId);
            requireValid(timerRecord?.event.type === 'timer.fired' && timerRecord.event.data.id === job.parameters.timerId &&
                inboxRecords.has(timerRecord.id));
        }

        if (job.status === 'queued') {
            requireValid(job.startedAt === undefined && job.finishedAt === undefined && job.claim === undefined &&
                job.attemptId === undefined && job.actionRecordId === undefined && job.verificationRecordId === undefined && job.result === undefined && row.started_at === null && row.finished_at === null &&
                row.claim_id === null && row.instance_id === null && row.attempt_id === null);
        } else {
            requireValid(job.startedAt !== undefined && job.claim !== undefined);
            instant(job.startedAt); exactObject(job.claim, ['jobId', 'claimId', 'instanceId']);
            identifier(job.claim.claimId, 'claimId'); identifier(job.claim.instanceId, 'instanceId');
            requireValid(job.claim.jobId === job.id && job.startedAt === row.started_at && job.claim.claimId === row.claim_id &&
                job.claim.instanceId === row.instance_id);
            if (job.attemptId !== undefined) identifier(job.attemptId, 'attemptId');
            if (job.verificationRecordId !== undefined) identifier(job.verificationRecordId, 'verificationRecordId');
            requireValid(job.verificationRecordId === undefined || job.kind === 'execute' || job.kind === 'readback');
            requireValid((job.attemptId ?? null) === row.attempt_id && (job.attemptId === undefined || job.kind === 'execute'));
            if (job.status === 'running') requireValid(job.finishedAt === undefined && job.result === undefined && row.finished_at === null);
            else {
                requireValid(job.finishedAt !== undefined && job.result !== undefined && job.finishedAt === row.finished_at);
                instant(job.finishedAt); verifyServiceResult(job.result, job, prior);
            }
        }
        jobs.add(job.id);
    }
    for (const { receipt } of requests.values()) {
        if (receipt.jobId !== undefined) requireValid(jobs.has(receipt.jobId));
    }
    for (const { receipt, envelope } of requests.values()) {
        if (envelope.kind !== 'schedule_reminder') continue;
        const timer = receipt.timerId === undefined ? undefined : state.timers[receipt.timerId];
        requireValid(timer !== undefined && timer.workId === envelope.workId && timer.dueAt === envelope.dueAt);
    }
}

/** Validate a stable, read-only snapshot. No repair, model, effect, or domain writes. */
export function verifyEncryptedDatabase(db: DatabaseSync, cipher: PayloadCipher): void {
    try {
        const version = Number(db.prepare('PRAGMA user_version').get()!.user_version);
        requireValid(version === 2 || version === 4);
        validateEncryptedSchema(db);
        const protection = db.prepare('SELECT * FROM storage_protection').all();
        requireValid(protection.length === 1 && protection[0]!.id === 1 && protection[0]!.format === 1);
        requireValid(cipher.open(String(protection[0]!.verification), ['metadata', 'verification']) === 'behalvo/storage/v1/verified');
        const integrity = db.prepare('PRAGMA integrity_check').all();
        requireValid(integrity.length === 1 && integrity[0]!.integrity_check === 'ok');
        requireValid(db.prepare('PRAGMA foreign_key_check').all().length === 0);

        // The union catches orphan workspaces even if their journal/projection was removed.
        const workspaces = db.prepare(`SELECT workspace_id FROM journal UNION SELECT workspace_id FROM projections
            UNION SELECT workspace_id FROM artifacts UNION SELECT workspace_id FROM inbox UNION SELECT workspace_id FROM summaries
            ${version === 4 ? 'UNION SELECT workspace_id FROM service_requests UNION SELECT workspace_id FROM service_jobs' : ''}`).all();
        for (const workspace of workspaces) {
            const workspaceId = workspace.workspace_id;
            identifier(workspaceId, 'workspaceId');
            const records = db.prepare('SELECT * FROM journal WHERE workspace_id=? ORDER BY seq').all(workspaceId).map(row => decodeRecord(row, cipher));
            const projections = db.prepare('SELECT * FROM projections WHERE workspace_id=?').all(workspaceId);
            requireValid(records.length > 0 && records[0]!.event.type === 'workspace.created' && projections.length === 1);
            const artifacts = new Map<string, string>();
            for (const row of db.prepare('SELECT * FROM artifacts WHERE workspace_id=?').all(workspaceId)) {
                identifier(row.id, 'artifactId');
                const body = open(row.body, artifactContext(workspaceId, row.id), cipher);
                nonempty(body, 'artifact');
                requireValid(Buffer.byteLength(body, 'utf8') <= 262144);
                artifacts.set(row.id, body);
            }
            const requireArtifact = (id: string): string => {
                const body = artifacts.get(id);
                requireValid(body !== undefined);
                return body;
            };
            const prior = new Map<string, JournalRecord>();
            const handled = new Set<string>();
            let state = emptyState(workspaceId);
            for (const record of records) {
                identifier(record.id, 'recordId');
                instant(record.recordedAt);
                requireValid(Number.isSafeInteger(record.seq) && record.workspaceId === workspaceId);
                if (record.causationId !== null) requireValid(prior.has(record.causationId));
                const event = record.event;
                let observedAt: string | undefined;
                if (event.type === 'fact.recorded') {
                    const source = prior.get(event.data.fact.sourceRecordId);
                    requireValid(source);
                    observedAt = source.recordedAt;
                }
                if (event.type === 'message.received') requireArtifact(event.data.artifactId);
                if (event.type === 'work.phase_changed' && event.data.evidenceRef !== undefined) requireArtifact(event.data.evidenceRef);
                if (event.type === 'action.finished' || event.type === 'action.reconciled') requireArtifact(event.data.evidenceRef);
                if (event.type === 'action.verification_recorded' && event.data.verification.status === 'owner_attested')
                    requireArtifact(event.data.verification.evidenceRef);
                if (event.type === 'inbox.handled') {
                    const source = prior.get(event.data.recordId);
                    requireValid(source && (source.event.type === 'message.received' || source.event.type === 'timer.fired'));
                    requireValid(record.causationId === source.id && !handled.has(source.id));
                    handled.add(source.id);
                }
                state = reduce(state, event, record.seq, observedAt);
                prior.set(record.id, record);
            }
            const projection = projections[0]!;
            requireValid(projection.version === state.version && isDeepStrictEqual(decodeProjection(projection, cipher), state));

            const receipts = new Set<string>();
            for (const row of db.prepare('SELECT * FROM inbox WHERE workspace_id=?').all(workspaceId)) {
                const source = prior.get(String(row.record_id));
                requireValid(source && !receipts.has(source.id));
                const event = source.event;
                requireValid(event.type === 'message.received' || event.type === 'timer.fired');
                const tokens = event.type === 'message.received'
                    ? messageTokens(workspaceId, { ...event.data, text: requireArtifact(event.data.artifactId) }, cipher)
                    : timerTokens(workspaceId, event.data.id, cipher);
                requireValid(row.source === tokens.source && row.external_id === tokens.externalId && row.fingerprint === tokens.fingerprint);
                requireValid(row.handled === (handled.has(source.id) ? 1 : 0));
                receipts.add(source.id);
            }
            for (const record of records) {
                const event = record.event;
                // AgentService appends its reply inside completeInbox, without a new delivery receipt.
                const assistantReply = event.type === 'message.received' && event.data.senderRole === 'agent' &&
                    ['agent:model', 'agent:application'].includes(event.data.source) && record.causationId !== null && handled.has(record.causationId);
                if (event.type === 'timer.fired' || (event.type === 'message.received' && !assistantReply) || handled.has(record.id))
                    requireValid(receipts.has(record.id));
            }

            for (const row of db.prepare('SELECT * FROM summaries WHERE workspace_id=?').all(workspaceId)) {
                // The actual thread is recovered from authenticated message provenance, never a guessed token.
                const summary = decodeSummary(row, '', cipher);
                identifier(summary.id, 'summaryId');
                instant(summary.createdAt);
                nonempty(summary.text, 'summary');
                requireValid(Buffer.byteLength(summary.text, 'utf8') <= 65536 && Array.isArray(summary.sourceIds) &&
                    summary.sourceIds.length > 0 && summary.sourceIds.length <= 1000 && new Set(summary.sourceIds).size === summary.sourceIds.length);
                let threadId: string | undefined;
                for (const id of summary.sourceIds) {
                    requireValid(typeof id === 'string');
                    const source = prior.get(id);
                    requireValid(source && source.event.type === 'message.received');
                    threadId ??= source.event.data.threadId;
                    requireValid(source.event.data.threadId === threadId);
                }
                requireValid(row.thread_id === summaryThread(workspaceId, threadId!, cipher));
            }
            if (version === 4) verifyServiceWorkspace(db, cipher, String(workspaceId), prior, receipts, artifacts, state);
        }
    } catch {
        // Database/parser/reducer errors can contain private payloads. Never expose those through validation.
        throw new Error('Invalid encrypted database snapshot.');
    }
}
