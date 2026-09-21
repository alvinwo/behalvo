import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { emptyState, reduce } from '../kernel/reducer.js';
import type { DomainEvent, JournalRecord, MessageInput, OutcomeStatus, RecordMetadata, State, Summary } from '../kernel/types.js';
import { identifier, instant, nonempty } from '../kernel/types.js';
import type { PayloadCipher } from './payload-cipher.js';
import { backupEncryptedStore } from './backup.js';
import { preparePrivateDatabasePath } from './private-files.js';
import { initializeStorage, validateStorage } from './sqlite-schema.js';
import { verifyServiceEnvelope, verifyServiceModel, verifyServiceResult } from './sqlite-validation.js';
import { artifactContext, canonicalServiceEnvelope, decodeProjection, decodeRecord, decodeServiceEnvelope, decodeServiceJob, decodeServiceReceipt, decodeSummary, journalContext, messageTokens, open, projectionContext, seal, serviceJobContext, serviceRequestContext, serviceRequestTokens, summaryContext, summaryThread, timerTokens } from './sqlite-codec.js';
import type { Row } from './sqlite-codec.js';
import { ServiceStorageError } from './service-jobs.js';
import type { CompleteOwnerTurnInput, CompleteOwnerTurnResult, ServiceEnvelope, ServiceJob, ServiceJobClaim, ServiceJobPage, ServiceJobResult, ServiceQueueCounts, ServiceReceipt, ServiceReminderRequest, ServiceReminderRequestPage, ServiceRequestIdentity } from './service-jobs.js';
const SCHEMA = 1;
const SERVICE_QUEUE_LIMIT = 64;
const SERVICE_STOP_REASONS = new Set([
    'completed', 'prepared_for_review', 'model_unavailable', 'invalid_model_result', 'deadline', 'cancelled',
    'action_ineligible', 'action_failed', 'action_unknown', 'readback_unresolved', 'process_interrupted'
]);

function serviceFailure(code: ServiceStorageError['code'], message: string): never {
    throw new ServiceStorageError(code, message);
}

function serviceObject(value: unknown, label: string): asserts value is Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) serviceFailure('invalid', `Invalid ${label}.`);
}

function serviceString(value: unknown, label: string, max = 262144): asserts value is string {
    if (typeof value !== 'string' || value.trim().length === 0 || Buffer.byteLength(value, 'utf8') > max)
        serviceFailure('invalid', `Invalid ${label}.`);
}

function serviceIdentity(identity: ServiceRequestIdentity): void {
    serviceObject(identity, 'service request identity');
    try {
        identifier(identity.workspaceId, 'workspaceId');
        identifier(identity.source, 'source');
        identifier(identity.requestId, 'requestId');
    } catch { serviceFailure('invalid', 'Invalid service request identity.'); }
}

function serviceEnvelope(envelope: ServiceEnvelope): void {
    try {
        verifyServiceEnvelope(envelope);
    } catch {
        serviceFailure('invalid', 'Invalid service envelope.');
    }
}
/** Internal trusted persistence API. Do not expose append() to models or untrusted plugins. */
export class SqliteStore {
    #db: DatabaseSync;
    #closed = false;
    #cipher: PayloadCipher | undefined;
    #encryptionKey: Uint8Array | undefined;
    #readOnly: boolean;
    #serviceQueue = false;
    constructor(path: string, options: { encryptionKey?: Uint8Array; readOnly?: boolean;
        serviceQueue?: { upgradeExisting: boolean }; beforeWrite?: () => void } = {}) {
        if (!options || typeof options !== 'object' || Array.isArray(options) ||
            Object.keys(options).some(key => !['encryptionKey', 'readOnly', 'serviceQueue', 'beforeWrite'].includes(key)) ||
            (options.readOnly !== undefined && typeof options.readOnly !== 'boolean') ||
            (options.beforeWrite !== undefined && typeof options.beforeWrite !== 'function') ||
            (options.serviceQueue !== undefined && (!options.serviceQueue || typeof options.serviceQueue !== 'object' ||
                Array.isArray(options.serviceQueue) || Object.keys(options.serviceQueue).length !== 1 ||
                typeof options.serviceQueue.upgradeExisting !== 'boolean')) ||
            (options.encryptionKey !== undefined && (!(options.encryptionKey instanceof Uint8Array) || options.encryptionKey.byteLength !== 32)))
            throw new Error('Invalid storage options.');
        this.#readOnly = options.readOnly ?? false;
        this.#encryptionKey = options.encryptionKey === undefined ? undefined : Uint8Array.from(options.encryptionKey);
        if (options.encryptionKey !== undefined && path !== ':memory:') preparePrivateDatabasePath(path, this.#readOnly);
        this.#db = new DatabaseSync(path, { readOnly: this.#readOnly });
        try {
            this.#cipher = this.#readOnly ? validateStorage(this.#db, options.encryptionKey)
                : initializeStorage(this.#db, options.encryptionKey, {
                    ...(options.serviceQueue ? { serviceQueue: options.serviceQueue } : {}),
                    ...(options.beforeWrite ? { beforeWrite: options.beforeWrite } : {})
                });
            const version = Number(this.#db.prepare('PRAGMA user_version').get()!.user_version);
            this.#serviceQueue = version === 3 || version === 4;
            if (options.serviceQueue && !this.#serviceQueue)
                throw new Error('Storage upgrade is required before enabling the service queue.');
            // Authenticate format and key before any connection pragmas that can change disk state.
            if (!this.#readOnly) this.#db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;');
        } catch (error) {
            this.close();
            throw error;
        }
    }
    /** Local deployment metadata, not domain state; prevents accidental mode rebinding. */
    bindLocalMode(mode: 'ordinary' | 'synthetic'): void {
        if (!['ordinary', 'synthetic'].includes(mode)) throw new Error('Invalid local mode');
        this.#transaction(() => {
            this.#db.exec('CREATE TABLE IF NOT EXISTS local_mode (id INTEGER PRIMARY KEY CHECK(id=1), mode TEXT NOT NULL)');
            const row = this.#db.prepare('SELECT mode FROM local_mode WHERE id=1').get();
            if (row) {
                if (row.mode !== mode) throw new Error('Database mode mismatch; use a separate database for synthetic operations');
                return;
            }
            if (mode === 'synthetic' && this.#db.prepare('SELECT 1 FROM journal LIMIT 1').get())
                throw new Error('Existing unbound database cannot be imported into synthetic mode; choose a new database');
            this.#db.prepare('INSERT INTO local_mode (id,mode) VALUES (1,?)').run(mode);
        });
    }
    /** Inspect local deployment metadata without creating or adopting a mode. */
    localMode(): 'ordinary' | 'synthetic' | undefined {
        const table = this.#db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='local_mode'").get();
        if (!table) return undefined;
        const rows = this.#db.prepare('SELECT id, mode FROM local_mode').all();
        if (rows.length !== 1 || rows[0]!.id !== 1 || !['ordinary', 'synthetic'].includes(String(rows[0]!.mode)))
            throw new Error('Invalid local mode');
        return rows[0]!.mode as 'ordinary' | 'synthetic';
    }
    close(): void { if (!this.#closed) {
        this.#db.close();
        this.#encryptionKey?.fill(0);
        this.#closed = true;
    } }
    async backup(destination: string): Promise<void> {
        if (!this.#cipher || !this.#encryptionKey) throw new Error('Encrypted storage is required.');
        await backupEncryptedStore(this.#db, this.#encryptionKey, destination);
    }
    #transaction<T>(fn: () => T): T {
        this.#writable();
        this.#db.exec('BEGIN IMMEDIATE');
        try {
            const result = fn();
            this.#db.exec('COMMIT');
            return result;
        }
        catch (error) {
            this.#db.exec('ROLLBACK');
            throw error;
        }
    }
    #writable(): void { if (this.#readOnly) throw new Error('Store is read-only.'); }
    #serviceTransaction<T>(fn: (beforeCommit: () => void) => T, beforeCommit?: () => void): T {
        this.#writable();
        let hookFailed = false;
        try {
            return this.#transaction(() => fn(() => {
                try { beforeCommit?.(); }
                catch (error) { hookFailed = true; throw error; }
            }));
        } catch (error) {
            // Trusted fault-injection callbacks retain their original errors; storage faults never do.
            if (hookFailed || error instanceof ServiceStorageError) throw error;
            serviceFailure('integrity', 'Service storage operation failed.');
        }
    }
    #requireServiceQueue(): void {
        if (!this.#serviceQueue) serviceFailure('invalid', 'Service queue is not enabled.');
    }
    #load(workspaceId: string): State | undefined {
        const row = this.#db.prepare('SELECT * FROM projections WHERE workspace_id=?').get(workspaceId);
        if (!row)
            return undefined;
        const state = decodeProjection(row, this.#cipher);
        state.connections ??= {};
        for (const fact of Object.values(state.facts)) {
            const legacy = fact as typeof fact & { observedAt?: string };
            if (legacy.observedAt === undefined) {
                const source = this.#db.prepare('SELECT recorded_at FROM journal WHERE workspace_id=? AND id=?').get(workspaceId, legacy.sourceRecordId);
                if (!source) throw new Error('Legacy fact source record is missing');
                legacy.observedAt = String(source.recorded_at);
            }
        }
        return state;
    }
    state(workspaceId: string): State {
        identifier(workspaceId, 'workspaceId');
        const s = this.#load(workspaceId);
        if (!s)
            throw new Error('Workspace not found');
        return s;
    }
    #save(s: State): void {
        this.#db.prepare(`INSERT INTO projections VALUES (?,?,?,?) ON CONFLICT(workspace_id)
      DO UPDATE SET version=excluded.version,projection_version=excluded.projection_version,state_json=excluded.state_json`)
            .run(s.workspaceId, s.version, SCHEMA, seal(JSON.stringify(s), projectionContext(s.workspaceId, s.version, SCHEMA), this.#cipher));
    }
    #append(workspaceId: string, expectedVersion: number, events: DomainEvent[], metadata: RecordMetadata = {}, creating = false): JournalRecord[] {
        let s = this.#load(workspaceId);
        if (!s && !creating)
            throw new Error('Workspace not found');
        s ??= emptyState(workspaceId);
        if (!Number.isSafeInteger(expectedVersion) || s.version !== expectedVersion)
            throw new Error('Stream version conflict');
        if (metadata.causationId)
            this.record(workspaceId, metadata.causationId);
        const records: JournalRecord[] = [];
        for (const event of events) {
            const recordedAt = metadata.recordedAt ?? new Date().toISOString();
            instant(recordedAt);
            const record: JournalRecord = { id: randomUUID(), schemaVersion: 1, workspaceId, seq: s.version + 1,
                recordedAt, actorId: metadata.actorId ?? 'system', causationId: metadata.causationId ?? null, event: structuredClone(event) };
            const sourceObservedAt = record.event.type === 'fact.recorded'
                ? this.record(workspaceId, record.event.data.fact.sourceRecordId).recordedAt : undefined;
            s = reduce(s, record.event, record.seq, sourceObservedAt);
            this.#db.prepare('INSERT INTO journal(id,workspace_id,seq,schema_version,recorded_at,actor_id,causation_id,event_json) VALUES (?,?,?,?,?,?,?,?)')
                .run(record.id, workspaceId, record.seq, SCHEMA, record.recordedAt,
                    seal(record.actorId, journalContext(record, 'actor_id'), this.#cipher), record.causationId,
                    seal(JSON.stringify(record.event), journalContext(record, 'event_json'), this.#cipher));
            records.push(record);
        }
        this.#save(s);
        return records;
    }
    createWorkspace(workspaceId: string, ownerId: string): State {
        identifier(workspaceId);
        identifier(ownerId);
        this.#transaction(() => {
            if (this.#load(workspaceId))
                throw new Error('Workspace already exists');
            this.#append(workspaceId, 0, [{ type: 'workspace.created', data: { ownerId } }], { actorId: ownerId }, true);
        });
        return this.state(workspaceId);
    }
    /** Optional trusted guard runs after acquiring the writer lock, before domain mutation. */
    append(workspaceId: string, expectedVersion: number, events: DomainEvent[], metadata: RecordMetadata = {}, beforeAppend?: () => void): JournalRecord[] {
        return this.#transaction(() => {
            beforeAppend?.();
            return this.#append(workspaceId, expectedVersion, events, metadata);
        });
    }
    #decode(row: Row): JournalRecord {
        return decodeRecord(row, this.#cipher);
    }
    record(workspaceId: string, id: string): JournalRecord {
        const row = this.#db.prepare('SELECT * FROM journal WHERE workspace_id=? AND id=?').get(workspaceId, id);
        if (!row)
            throw new Error('Source record not found');
        return this.#decode(row);
    }
    journal(workspaceId: string): JournalRecord[] {
        this.state(workspaceId);
        return this.#db.prepare('SELECT * FROM journal WHERE workspace_id=? ORDER BY seq').all(workspaceId).map(r => this.#decode(r));
    }
    /** Read a historical projection without modifying the live state or executing anything. */
    stateAt(workspaceId: string, revision: number): State {
        const current = this.state(workspaceId);
        if (!Number.isSafeInteger(revision) || revision < 1 || revision > current.version)
            throw new Error('Historical revision out of range');
        const rows = this.#db.prepare('SELECT * FROM journal WHERE workspace_id=? AND seq<=? ORDER BY seq').all(workspaceId, revision);
        let state = emptyState(workspaceId);
        for (const row of rows) {
            const record = this.#decode(row);
            const sourceObservedAt = record.event.type === 'fact.recorded'
                ? this.record(workspaceId, record.event.data.fact.sourceRecordId).recordedAt : undefined;
            state = reduce(state, record.event, record.seq, sourceObservedAt);
        }
        return state;
    }
    rebuild(workspaceId: string): State {
        return this.#transaction(() => {
            const rows = this.#db.prepare('SELECT * FROM journal WHERE workspace_id=? ORDER BY seq').all(workspaceId);
            if (!rows.length)
                throw new Error('Workspace not found');
            let s = emptyState(workspaceId);
            for (const row of rows) {
                const record = this.#decode(row);
                const sourceObservedAt = record.event.type === 'fact.recorded'
                    ? this.record(workspaceId, record.event.data.fact.sourceRecordId).recordedAt : undefined;
                s = reduce(s, record.event, record.seq, sourceObservedAt);
            }
            this.#save(s);
            return s;
        });
    }
    #artifact(workspaceId: string, body: string): string {
        this.#writable();
        const id = randomUUID();
        this.#db.prepare('INSERT INTO artifacts VALUES (?,?,?)').run(id, workspaceId, seal(body, artifactContext(workspaceId, id), this.#cipher));
        return id;
    }
    putArtifact(workspaceId: string, body: string): string {
        this.state(workspaceId);
        nonempty(body, 'artifact body');
        if (Buffer.byteLength(body, 'utf8') > 262144)
            throw new Error('Artifact exceeds size limit');
        return this.#artifact(workspaceId, body);
    }
    /** Persist an already obtained effect outcome only while its exact attempt is still running. */
    finishActionAttempt(workspaceId: string, actionId: string, attemptId: string, status: OutcomeStatus,
        evidence: string, metadata: RecordMetadata = {}): boolean {
        identifier(actionId, 'actionId');
        identifier(attemptId, 'attemptId');
        if (!['accepted', 'failed', 'unknown'].includes(status)) throw new Error('Invalid action outcome');
        nonempty(evidence, 'artifact body');
        if (Buffer.byteLength(evidence, 'utf8') > 262144)
            throw new Error('Artifact exceeds size limit');
        return this.#transaction(() => {
            const state = this.state(workspaceId);
            const action = state.actions[actionId];
            if (!action) throw new Error('Action not found');
            if (action.status !== 'running' || action.attemptId !== attemptId) return false;
            const evidenceRef = this.#artifact(workspaceId, evidence);
            this.#append(workspaceId, state.version, [{ type: 'action.finished', data: {
                id: actionId, attemptId, status, evidenceRef
            } }], metadata);
            return true;
        });
    }
    readArtifact(workspaceId: string, id: string): string {
        const row = this.#db.prepare('SELECT body FROM artifacts WHERE workspace_id=? AND id=?').get(workspaceId, id);
        if (!row)
            throw new Error('Artifact not found');
        return open(row.body, artifactContext(workspaceId, id), this.#cipher);
    }
    ingest(workspaceId: string, input: MessageInput): JournalRecord {
        nonempty(input.source, 'source binding');
        nonempty(input.externalId, 'externalId');
        nonempty(input.text, 'message text');
        if (Buffer.byteLength(input.text, 'utf8') > 262144)
            throw new Error('Message exceeds size limit');
        const tokens = messageTokens(workspaceId, input, this.#cipher);
        return this.#transaction(() => {
            const s = this.state(workspaceId);
            if (input.senderRole === 'owner' && input.senderId !== s.ownerId)
                throw new Error('Owner binding mismatch');
            const found = this.#db.prepare('SELECT * FROM inbox WHERE workspace_id=? AND source=? AND external_id=?').get(workspaceId, tokens.source, tokens.externalId);
            if (found) {
                if (found.fingerprint !== tokens.fingerprint)
                    throw new Error('Delivery key collision');
                return this.record(workspaceId, String(found.record_id));
            }
            const artifactId = this.#artifact(workspaceId, input.text);
            const event: DomainEvent = { type: 'message.received', data: { source: input.source, externalId: input.externalId, threadId: input.threadId, senderId: input.senderId, senderRole: input.senderRole, artifactId } };
            const record = this.#append(workspaceId, s.version, [event], { actorId: input.senderId })[0]!;
            this.#db.prepare('INSERT INTO inbox(workspace_id,source,external_id,fingerprint,record_id) VALUES (?,?,?,?,?)').run(workspaceId, tokens.source, tokens.externalId, tokens.fingerprint, record.id);
            return record;
        });
    }
    inbox(workspaceId: string): JournalRecord[] {
        this.state(workspaceId);
        return this.#db.prepare(`SELECT j.* FROM inbox i JOIN journal j ON j.id=i.record_id AND j.workspace_id=i.workspace_id
      WHERE i.workspace_id=? AND i.handled=0 ORDER BY j.seq`).all(workspaceId).map(r => this.#decode(r));
    }
    completeInbox(workspaceId: string, recordId: string, expectedVersion: number, events: DomainEvent[], beforeAppend?: () => void): JournalRecord[] {
        return this.#transaction(() => {
            const row = this.#db.prepare('SELECT handled FROM inbox WHERE workspace_id=? AND record_id=?').get(workspaceId, recordId);
            if (!row || Number(row.handled) !== 0)
                throw new Error('Inbox record already handled or not found');
            beforeAppend?.();
            const records = this.#append(workspaceId, expectedVersion, [...events, { type: 'inbox.handled', data: { recordId } }], { causationId: recordId });
            this.#db.prepare('UPDATE inbox SET handled=1 WHERE workspace_id=? AND record_id=?').run(workspaceId, recordId);
            return records;
        });
    }
    /** Commit a timer firing and its processable inbox record together. */
    enqueueTimer(workspaceId: string, expectedVersion: number, timerId: string, at: string): JournalRecord {
        return this.#transaction(() => {
            const record = this.#append(workspaceId, expectedVersion, [{ type: 'timer.fired', data: { id: timerId } }], { recordedAt: at })[0]!;
            const tokens = timerTokens(workspaceId, timerId, this.#cipher);
            this.#db.prepare('INSERT INTO inbox(workspace_id,source,external_id,fingerprint,record_id) VALUES (?,?,?,?,?)')
                .run(workspaceId, tokens.source, tokens.externalId, tokens.fingerprint, record.id);
            return record;
        });
    }
    threadMessages(workspaceId: string, threadId: string, limit = 50): JournalRecord[] {
        this.state(workspaceId);
        identifier(threadId);
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10000)
            throw new Error('Invalid message limit');
        // Encrypted mode scans one workspace's journal; it has no plaintext JSON/thread index.
        if (this.#cipher) return this.journal(workspaceId).filter(record => record.event.type === 'message.received' && record.event.data.threadId === threadId).slice(-limit);
        return this.#db.prepare(`SELECT * FROM journal WHERE workspace_id=? AND json_extract(event_json,'$.type')='message.received'
      AND json_extract(event_json,'$.data.threadId')=? ORDER BY seq DESC LIMIT ?`).all(workspaceId, threadId, limit).map(r => this.#decode(r)).reverse();
    }
    messageCount(workspaceId: string, threadId: string): number {
        if (this.#cipher) {
            if (!this.#load(workspaceId)) return 0;
            return this.journal(workspaceId).filter(record => record.event.type === 'message.received' && record.event.data.threadId === threadId).length;
        }
        return Number(this.#db.prepare(`SELECT count(*) AS n FROM journal WHERE workspace_id=? AND json_extract(event_json,'$.type')='message.received'
      AND json_extract(event_json,'$.data.threadId')=?`).get(workspaceId, threadId)!.n);
    }
    saveSummary(workspaceId: string, input: {
        threadId: string;
        sourceIds: string[];
        text: string;
    }): Summary {
        this.#writable();
        this.state(workspaceId);
        identifier(input.threadId);
        nonempty(input.text, 'summary');
        if (Buffer.byteLength(input.text, 'utf8') > 65536)
            throw new Error('Summary exceeds size limit');
        if (input.sourceIds.length === 0 || input.sourceIds.length > 1000 || new Set(input.sourceIds).size !== input.sourceIds.length)
            throw new Error('Invalid summary sources');
        for (const id of input.sourceIds) {
            const record = this.record(workspaceId, id);
            if (record.event.type !== 'message.received' || record.event.data.threadId !== input.threadId)
                throw new Error('Summary source thread mismatch');
        }
        const summary: Summary = { id: randomUUID(), workspaceId, threadId: input.threadId, sourceIds: [...input.sourceIds], text: input.text, createdAt: new Date().toISOString() };
        const thread = summaryThread(workspaceId, summary.threadId, this.#cipher);
        this.#db.prepare('INSERT INTO summaries VALUES (?,?,?,?,?,?)').run(summary.id, workspaceId, thread,
            seal(JSON.stringify(summary.sourceIds), summaryContext(workspaceId, summary.id, thread, summary.createdAt, 'source_ids'), this.#cipher),
            seal(summary.text, summaryContext(workspaceId, summary.id, thread, summary.createdAt, 'body'), this.#cipher), summary.createdAt);
        return summary;
    }
    summaries(workspaceId: string, threadId: string): Summary[] {
        this.state(workspaceId);
        return this.#db.prepare('SELECT * FROM summaries WHERE workspace_id=? AND thread_id=? ORDER BY rowid DESC LIMIT 8')
            .all(workspaceId, summaryThread(workspaceId, threadId, this.#cipher)).map(row => decodeSummary(row, threadId, this.#cipher));
    }

    #serviceRequest(identity: ServiceRequestIdentity, envelope: ServiceEnvelope):
        { row: Row; envelope: ServiceEnvelope; receipt: ServiceReceipt } | undefined {
        const tokens = serviceRequestTokens(identity, envelope, this.#cipher);
        const row = this.#db.prepare('SELECT * FROM service_requests WHERE workspace_id=? AND source=? AND request_id=?')
            .get(identity.workspaceId, tokens.source, tokens.requestId) as Row | undefined;
        if (!row) return undefined;
        try {
            const storedEnvelope = decodeServiceEnvelope(row, this.#cipher);
            if (row.fingerprint !== tokens.fingerprint || canonicalServiceEnvelope(storedEnvelope) !== canonicalServiceEnvelope(envelope))
                serviceFailure('conflict', 'Service request key was reused with different input.');
            const receipt = decodeServiceReceipt(row, this.#cipher);
            if (receipt.workspaceId !== identity.workspaceId || receipt.source !== identity.source ||
                receipt.requestId !== identity.requestId || receipt.id !== row.receipt_id || receipt.admittedAt !== row.admitted_at ||
                receipt.kind !== storedEnvelope.kind) serviceFailure('integrity', 'Invalid service request record.');
            return { row, envelope: storedEnvelope, receipt };
        } catch (error) {
            if (error instanceof ServiceStorageError) throw error;
            serviceFailure('integrity', 'Invalid service request record.');
        }
    }

    #serviceJobRow(workspaceId: string, jobId: string): { row: Row; job: ServiceJob } | undefined {
        const row = this.#db.prepare('SELECT * FROM service_jobs WHERE workspace_id=? AND id=?').get(workspaceId, jobId) as Row | undefined;
        if (!row) return undefined;
        try {
            const job = decodeServiceJob(row, this.#cipher);
            const claimMatches = job.status === 'queued'
                ? job.claim === undefined && row.claim_id === null && row.instance_id === null
                : job.claim?.jobId === job.id && job.claim.claimId === row.claim_id && job.claim.instanceId === row.instance_id;
            if (job.id !== row.id || job.workspaceId !== row.workspace_id || job.receiptId !== row.receipt_id ||
                job.position !== Number(row.position) || job.kind !== row.kind || job.status !== row.status ||
                job.admittedAt !== row.admitted_at || (job.startedAt ?? null) !== row.started_at ||
                (job.finishedAt ?? null) !== row.finished_at || (job.attemptId ?? null) !== row.attempt_id || !claimMatches)
                serviceFailure('integrity', 'Invalid service job record.');
            return { row, job };
        } catch (error) {
            if (error instanceof ServiceStorageError) throw error;
            serviceFailure('integrity', 'Invalid service job record.');
        }
    }

    #insertServiceRequest(identity: ServiceRequestIdentity, envelope: ServiceEnvelope, receipt: ServiceReceipt): void {
        const tokens = serviceRequestTokens(identity, envelope, this.#cipher);
        const row: Row = { workspace_id: identity.workspaceId, source: tokens.source, request_id: tokens.requestId,
            fingerprint: tokens.fingerprint, receipt_id: receipt.id, admitted_at: receipt.admittedAt,
            envelope_json: '', receipt_json: '' };
        this.#db.prepare(`INSERT INTO service_requests
            (workspace_id,source,request_id,fingerprint,receipt_id,admitted_at,envelope_json,receipt_json)
            VALUES (?,?,?,?,?,?,?,?)`).run(identity.workspaceId, tokens.source, tokens.requestId, tokens.fingerprint,
                receipt.id, receipt.admittedAt, seal(JSON.stringify(envelope), serviceRequestContext(row, 'envelope_json'), this.#cipher),
                seal(JSON.stringify(receipt), serviceRequestContext(row, 'receipt_json'), this.#cipher));
    }

    #insertServiceJob(job: Omit<ServiceJob, 'position'>): ServiceJob {
        const inserted = this.#db.prepare(`INSERT INTO service_jobs
            (id,workspace_id,receipt_id,kind,status,admitted_at,started_at,finished_at,claim_id,instance_id,attempt_id,job_json)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(job.id, job.workspaceId, job.receiptId, job.kind, job.status,
                job.admittedAt, null, null, null, null, null, '');
        const position = Number(inserted.lastInsertRowid);
        if (!Number.isSafeInteger(position) || position < 1) serviceFailure('integrity', 'Invalid service queue position.');
        const stored: ServiceJob = { ...job, position };
        const row = this.#db.prepare('SELECT * FROM service_jobs WHERE position=?').get(position) as Row;
        this.#db.prepare('UPDATE service_jobs SET job_json=? WHERE position=?')
            .run(seal(JSON.stringify(stored), serviceJobContext(row), this.#cipher), position);
        return stored;
    }

    #updateServiceJob(row: Row, job: ServiceJob): ServiceJob {
        const next: Row = { ...row, status: job.status, started_at: job.startedAt ?? null,
            finished_at: job.finishedAt ?? null, claim_id: job.claim?.claimId ?? null,
            instance_id: job.claim?.instanceId ?? null, attempt_id: job.attemptId ?? null };
        const updated = this.#db.prepare(`UPDATE service_jobs SET status=?,started_at=?,finished_at=?,claim_id=?,instance_id=?,attempt_id=?,job_json=?
            WHERE position=? AND id=? AND workspace_id=?`).run(String(next.status), next.started_at ?? null,
                next.finished_at ?? null, next.claim_id ?? null, next.instance_id ?? null, next.attempt_id ?? null,
                seal(JSON.stringify(job), serviceJobContext(next), this.#cipher), Number(row.position), String(row.id),
                String(row.workspace_id));
        if (updated.changes !== 1) serviceFailure('integrity', 'Service job update failed.');
        return job;
    }

    #waitingServiceJobs(workspaceId: string): number {
        return Number(this.#db.prepare("SELECT count(*) AS n FROM service_jobs WHERE workspace_id=? AND status='queued'").get(workspaceId)!.n);
    }

    #serviceDuplicate(identity: ServiceRequestIdentity, envelope: ServiceEnvelope):
        { receipt: ServiceReceipt; job?: ServiceJob } | undefined {
        const found = this.#serviceRequest(identity, envelope);
        if (!found) return undefined;
        if (!found.receipt.jobId) return { receipt: found.receipt };
        const job = this.#serviceJobRow(identity.workspaceId, found.receipt.jobId)?.job;
        if (!job || job.receiptId !== found.receipt.id) serviceFailure('integrity', 'Service receipt job is missing.');
        return { receipt: found.receipt, job };
    }

    #ingestServiceOwner(workspaceId: string, input: MessageInput, recordedAt: string): JournalRecord {
        const tokens = messageTokens(workspaceId, input, this.#cipher);
        if (this.#db.prepare('SELECT 1 FROM inbox WHERE workspace_id=? AND source=? AND external_id=?')
            .get(workspaceId, tokens.source, tokens.externalId)) serviceFailure('conflict', 'Service delivery key already exists.');
        const artifactId = this.#artifact(workspaceId, input.text);
        const state = this.state(workspaceId);
        const event: DomainEvent = { type: 'message.received', data: { source: input.source, externalId: input.externalId,
            threadId: input.threadId, senderId: input.senderId, senderRole: input.senderRole, artifactId } };
        const record = this.#append(workspaceId, state.version, [event], { actorId: input.senderId, recordedAt })[0]!;
        this.#db.prepare('INSERT INTO inbox(workspace_id,source,external_id,fingerprint,record_id) VALUES (?,?,?,?,?)')
            .run(workspaceId, tokens.source, tokens.externalId, tokens.fingerprint, record.id);
        return record;
    }

    findServiceReceipt(identity: ServiceRequestIdentity, envelope: ServiceEnvelope): ServiceReceipt | undefined {
        this.#requireServiceQueue();
        serviceIdentity(identity);
        serviceEnvelope(envelope);
        return this.#serviceRequest(identity, envelope)?.receipt;
    }

    admitOwnerTurnJob(input: ServiceRequestIdentity & {
        ownerId: string; envelope: Extract<ServiceEnvelope, { kind: 'owner_turn' }>;
        accepted: { threadId: string; workId?: string; model: { provider: string; model: string };
            windowTokens: number; outputReserve: number; capability: 'prepare_only' };
        instanceId: string; at: string;
    }, beforeCommit?: () => void): { receipt: ServiceReceipt; job: ServiceJob; duplicate: boolean } {
        this.#requireServiceQueue();
        serviceIdentity(input);
        serviceEnvelope(input.envelope);
        if (input.envelope.kind !== 'owner_turn') serviceFailure('invalid', 'Invalid admitted owner request.');
        return this.#serviceTransaction(checkBeforeCommit => {
            const duplicate = this.#serviceDuplicate(input, input.envelope);
            if (duplicate) {
                if (!duplicate.job) serviceFailure('integrity', 'Service owner receipt has no job.');
                return { receipt: duplicate.receipt, job: duplicate.job, duplicate: true };
            }
            if (this.#waitingServiceJobs(input.workspaceId) >= SERVICE_QUEUE_LIMIT)
                serviceFailure('full', 'Service queue is full.');
            const state = this.#load(input.workspaceId);
            if (!state || state.ownerId !== input.ownerId) serviceFailure('invalid', 'Owner binding mismatch.');
            try {
                identifier(input.instanceId, 'instanceId'); instant(input.at);
                identifier(input.accepted.threadId, 'threadId');
                if (input.accepted.workId !== undefined) identifier(input.accepted.workId, 'workId');
                verifyServiceModel(input.accepted.model);
                if (!Number.isSafeInteger(input.accepted.windowTokens) || !Number.isSafeInteger(input.accepted.outputReserve) ||
                    input.accepted.windowTokens < 1 || input.accepted.outputReserve < 0 ||
                    input.accepted.outputReserve >= input.accepted.windowTokens || input.accepted.capability !== 'prepare_only')
                    serviceFailure('invalid', 'Invalid admitted owner parameters.');
            } catch (error) {
                if (error instanceof ServiceStorageError) throw error;
                serviceFailure('invalid', 'Invalid admitted owner request.');
            }
            const ownerRecord = this.#ingestServiceOwner(input.workspaceId, { source: input.source, externalId: input.requestId,
                threadId: input.accepted.threadId, senderId: input.ownerId, senderRole: 'owner', text: input.envelope.text }, input.at);
            const receiptId = randomUUID(), jobId = randomUUID();
            const receipt: ServiceReceipt = { id: receiptId, workspaceId: input.workspaceId, source: input.source,
                requestId: input.requestId, kind: 'owner_turn', admittedAt: input.at, jobId };
            this.#insertServiceRequest(input, input.envelope, receipt);
            const job = this.#insertServiceJob({ id: jobId, workspaceId: input.workspaceId, receiptId, kind: 'owner_turn',
                status: 'queued', admittedAt: input.at, admittedBy: input.instanceId,
                parameters: { kind: 'owner_turn', ownerRecordId: ownerRecord.id, threadId: input.accepted.threadId,
                    ...(input.accepted.workId ? { workId: input.accepted.workId } : {}), model: structuredClone(input.accepted.model),
                    windowTokens: input.accepted.windowTokens, outputReserve: input.accepted.outputReserve, capability: 'prepare_only' } });
            checkBeforeCommit();
            return { receipt, job, duplicate: false };
        }, beforeCommit);
    }

    admitActionJob(input: ServiceRequestIdentity & {
        ownerId: string; envelope: Extract<ServiceEnvelope, { kind: 'execute' | 'readback' }>;
        instanceId: string; at: string;
    }, beforeCommit?: () => void): { receipt: ServiceReceipt; job: ServiceJob; duplicate: boolean } {
        this.#requireServiceQueue();
        serviceIdentity(input); serviceEnvelope(input.envelope);
        if (!['execute', 'readback'].includes(input.envelope.kind)) serviceFailure('invalid', 'Invalid service action request.');
        return this.#serviceTransaction(checkBeforeCommit => {
            const duplicate = this.#serviceDuplicate(input, input.envelope);
            if (duplicate) {
                if (!duplicate.job) serviceFailure('integrity', 'Service action receipt has no job.');
                return { receipt: duplicate.receipt, job: duplicate.job, duplicate: true };
            }
            if (this.#waitingServiceJobs(input.workspaceId) >= SERVICE_QUEUE_LIMIT)
                serviceFailure('full', 'Service queue is full.');
            const state = this.#load(input.workspaceId);
            if (!state || state.ownerId !== input.ownerId) serviceFailure('invalid', 'Owner binding mismatch.');
            try {
                identifier(input.instanceId, 'instanceId'); instant(input.at);
                const action = state.actions[input.envelope.actionId];
                if (!action || action.digest !== input.envelope.digest) serviceFailure('invalid', 'Action binding mismatch.');
            } catch (error) {
                if (error instanceof ServiceStorageError) throw error;
                serviceFailure('invalid', 'Invalid service action request.');
            }
            const receiptId = randomUUID(), jobId = randomUUID();
            const receipt: ServiceReceipt = { id: receiptId, workspaceId: input.workspaceId, source: input.source,
                requestId: input.requestId, kind: input.envelope.kind, admittedAt: input.at, jobId };
            this.#insertServiceRequest(input, input.envelope, receipt);
            const job = this.#insertServiceJob({ id: jobId, workspaceId: input.workspaceId, receiptId,
                kind: input.envelope.kind, status: 'queued', admittedAt: input.at, admittedBy: input.instanceId,
                parameters: { kind: input.envelope.kind, actionId: input.envelope.actionId, digest: input.envelope.digest } });
            checkBeforeCommit();
            return { receipt, job, duplicate: false };
        }, beforeCommit);
    }

    scheduleServiceReminder(input: ServiceRequestIdentity & {
        ownerId: string; envelope: Extract<ServiceEnvelope, { kind: 'schedule_reminder' }>;
        timerId: string; at: string;
    }, beforeCommit?: () => void): { receipt: ServiceReceipt; duplicate: boolean } {
        this.#requireServiceQueue();
        serviceIdentity(input); serviceEnvelope(input.envelope);
        if (input.envelope.kind !== 'schedule_reminder') serviceFailure('invalid', 'Invalid service reminder request.');
        return this.#serviceTransaction(checkBeforeCommit => {
            const duplicate = this.#serviceDuplicate(input, input.envelope);
            if (duplicate) return { receipt: duplicate.receipt, duplicate: true };
            const state = this.#load(input.workspaceId);
            if (!state || state.ownerId !== input.ownerId) serviceFailure('invalid', 'Owner binding mismatch.');
            try {
                identifier(input.timerId, 'timerId'); instant(input.at);
            } catch (error) {
                if (error instanceof ServiceStorageError) throw error;
                serviceFailure('invalid', 'Invalid service reminder request.');
            }
            const work = state.works[input.envelope.workId];
            if (!work || ['done', 'cancelled'].includes(work.phase)) serviceFailure('invalid', 'Reminder work is unavailable.');
            if (state.timers[input.timerId]) serviceFailure('conflict', 'Timer already exists.');
            this.#append(input.workspaceId, state.version, [{ type: 'timer.scheduled', data: { timer: {
                id: input.timerId, workId: work.id, workRevision: work.revision,
                dueAt: input.envelope.dueAt, status: 'scheduled'
            } } }], { actorId: input.ownerId, recordedAt: input.at });
            const receipt: ServiceReceipt = { id: randomUUID(), workspaceId: input.workspaceId, source: input.source,
                requestId: input.requestId, kind: 'schedule_reminder', admittedAt: input.at, timerId: input.timerId };
            this.#insertServiceRequest(input, input.envelope, receipt);
            checkBeforeCommit();
            return { receipt, duplicate: false };
        }, beforeCommit);
    }

    admitDueTimerJob(workspaceId: string, timerId: string, instanceId: string, at: string):
        { kind: 'queued'; job: ServiceJob } | { kind: 'cancelled' | 'full' | 'unchanged' } {
        this.#requireServiceQueue();
        try { identifier(workspaceId, 'workspaceId'); identifier(timerId, 'timerId'); identifier(instanceId, 'instanceId'); instant(at); }
        catch { serviceFailure('invalid', 'Invalid due timer request.'); }
        return this.#serviceTransaction(() => {
            const state = this.state(workspaceId);
            const timer = state.timers[timerId];
            if (!timer || timer.status !== 'scheduled' || Date.parse(timer.dueAt) > Date.parse(at)) return { kind: 'unchanged' };
            const work = state.works[timer.workId];
            if (!work || ['done', 'cancelled'].includes(work.phase) || work.revision !== timer.workRevision) {
                this.#append(workspaceId, state.version, [{ type: 'timer.cancelled', data: { id: timerId } }], { recordedAt: at });
                return { kind: 'cancelled' };
            }
            if (this.#waitingServiceJobs(workspaceId) >= SERVICE_QUEUE_LIMIT) return { kind: 'full' };
            const identity = { workspaceId, source: 'kernel:timer', requestId: timerId };
            const envelope: Extract<ServiceEnvelope, { kind: 'reminder' }> = { kind: 'reminder', timerId, workId: timer.workId };
            if (this.#serviceDuplicate(identity, envelope)) return { kind: 'unchanged' };
            const timerRecord = this.#append(workspaceId, state.version,
                [{ type: 'timer.fired', data: { id: timerId } }], { recordedAt: at })[0]!;
            const delivery = timerTokens(workspaceId, timerId, this.#cipher);
            this.#db.prepare('INSERT INTO inbox(workspace_id,source,external_id,fingerprint,record_id) VALUES (?,?,?,?,?)')
                .run(workspaceId, delivery.source, delivery.externalId, delivery.fingerprint, timerRecord.id);
            const receiptId = randomUUID(), jobId = randomUUID();
            const receipt: ServiceReceipt = { ...identity, id: receiptId, kind: 'reminder', admittedAt: at, jobId };
            this.#insertServiceRequest(identity, envelope, receipt);
            const job = this.#insertServiceJob({ id: jobId, workspaceId, receiptId, kind: 'reminder', status: 'queued',
                admittedAt: at, admittedBy: instanceId,
                parameters: { kind: 'reminder', timerId, workId: timer.workId, timerRecordId: timerRecord.id } });
            return { kind: 'queued', job };
        });
    }

    serviceJob(workspaceId: string, jobId: string): ServiceJob {
        this.#requireServiceQueue();
        try { identifier(workspaceId, 'workspaceId'); identifier(jobId, 'jobId'); } catch { serviceFailure('invalid', 'Invalid service job identity.'); }
        const job = this.#serviceJobRow(workspaceId, jobId)?.job;
        if (!job) serviceFailure('invalid', 'Service job not found.');
        return job;
    }

    serviceJobReceipt(workspaceId: string, jobId: string): ServiceReceipt {
        const job = this.serviceJob(workspaceId, jobId);
        const row = this.#db.prepare('SELECT * FROM service_requests WHERE workspace_id=? AND receipt_id=?')
            .get(workspaceId, job.receiptId) as Row | undefined;
        if (!row) serviceFailure('integrity', 'Service job receipt is missing.');
        try {
            const receipt = decodeServiceReceipt(row, this.#cipher);
            const envelope = decodeServiceEnvelope(row, this.#cipher);
            const found = this.#serviceRequest({ workspaceId, source: receipt.source, requestId: receipt.requestId }, envelope);
            if (!found || found.receipt.id !== job.receiptId || found.receipt.jobId !== job.id)
                serviceFailure('integrity', 'Service job receipt does not match its job.');
            return found.receipt;
        } catch (error) {
            if (error instanceof ServiceStorageError) throw error;
            serviceFailure('integrity', 'Invalid service job receipt.');
        }
    }

    serviceJobs(workspaceId: string, after = 0, limit = 50): ServiceJobPage {
        this.#requireServiceQueue();
        try { identifier(workspaceId, 'workspaceId'); } catch { serviceFailure('invalid', 'Invalid workspace.'); }
        this.state(workspaceId);
        if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100)
            serviceFailure('invalid', 'Invalid service job page.');
        const rows = this.#db.prepare('SELECT * FROM service_jobs WHERE workspace_id=? AND position>? ORDER BY position LIMIT ?')
            .all(workspaceId, after, limit + 1) as Row[];
        const hasMore = rows.length > limit;
        const pageRows = rows.slice(0, limit);
        const items = pageRows.map(row => this.#serviceJobRow(workspaceId, String(row.id))!.job);
        return { items, nextAfter: hasMore ? items.at(-1)!.position : null };
    }

    serviceReminderRequests(workspaceId: string, after = 0, limit = 50): ServiceReminderRequestPage {
        this.#requireServiceQueue();
        try { identifier(workspaceId, 'workspaceId'); } catch { serviceFailure('invalid', 'Invalid workspace.'); }
        const state = this.state(workspaceId);
        if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100)
            serviceFailure('invalid', 'Invalid service reminder page.');
        const rows = this.#db.prepare(`SELECT r.* FROM service_requests r
            WHERE r.workspace_id=? AND NOT EXISTS (
                SELECT 1 FROM service_jobs j WHERE j.workspace_id=r.workspace_id AND j.receipt_id=r.receipt_id)
            ORDER BY r.rowid`).all(workspaceId) as Row[];
        const receipts = new Map<string, ServiceReceipt>();
        for (const row of rows) {
            try {
                const receipt = decodeServiceReceipt(row, this.#cipher);
                const envelope = decodeServiceEnvelope(row, this.#cipher);
                const found = this.#serviceRequest({ workspaceId, source: receipt.source, requestId: receipt.requestId }, envelope);
                if (!found || found.receipt.id !== receipt.id || envelope.kind !== 'schedule_reminder' ||
                    receipt.kind !== 'schedule_reminder' || receipt.timerId === undefined || receipt.jobId !== undefined ||
                    receipts.has(receipt.timerId)) serviceFailure('integrity', 'Invalid service reminder request.');
                const timer = state.timers[receipt.timerId];
                if (!timer || timer.workId !== envelope.workId || timer.dueAt !== envelope.dueAt)
                    serviceFailure('integrity', 'Service reminder does not match durable timer state.');
                receipts.set(receipt.timerId, receipt);
            } catch (error) {
                if (error instanceof ServiceStorageError) throw error;
                serviceFailure('integrity', 'Invalid service reminder request.');
            }
        }
        // Journal sequence provides one stable cursor for service and pre-service timers.
        // Receipts add provenance; absence never invents an owner-service request identity.
        const reminders: ServiceReminderRequest[] = [];
        for (const record of this.journal(workspaceId)) {
            if (record.event.type !== 'timer.scheduled') continue;
            const scheduled = record.event.data.timer;
            const timer = state.timers[scheduled.id];
            if (!timer || timer.workId !== scheduled.workId || timer.dueAt !== scheduled.dueAt ||
                timer.workRevision !== scheduled.workRevision)
                serviceFailure('integrity', 'Reminder does not match durable timer state.');
            if (record.seq > after) reminders.push({ position: record.seq, receipt: receipts.get(timer.id) ?? null,
                timerId: timer.id, workId: timer.workId, dueAt: timer.dueAt });
        }
        const items = reminders.slice(0, limit);
        return { items, nextAfter: reminders.length > limit ? items.at(-1)!.position : null };
    }

    serviceReminderRequest(workspaceId: string, timerId: string): ServiceReminderRequest | undefined {
        try { identifier(timerId, 'timerId'); } catch { serviceFailure('invalid', 'Invalid timer identity.'); }
        let after = 0;
        do {
            const page = this.serviceReminderRequests(workspaceId, after, 100);
            const found = page.items.find(item => item.timerId === timerId);
            if (found) return found;
            if (page.nextAfter === null) return undefined;
            after = page.nextAfter;
        } while (true);
    }

    serviceQueueCounts(workspaceId: string): ServiceQueueCounts {
        this.#requireServiceQueue();
        try { identifier(workspaceId, 'workspaceId'); } catch { serviceFailure('invalid', 'Invalid workspace.'); }
        this.state(workspaceId);
        const counts: Record<string, number> = { queued: 0, running: 0, finished: 0, stopped: 0, interrupted: 0 };
        for (const row of this.#db.prepare('SELECT status,count(*) AS n FROM service_jobs WHERE workspace_id=? GROUP BY status').all(workspaceId))
            counts[String(row.status)] = Number(row.n);
        const oldest = this.#db.prepare("SELECT admitted_at FROM service_jobs WHERE workspace_id=? AND status='queued' ORDER BY position LIMIT 1").get(workspaceId);
        const active = this.#db.prepare("SELECT id FROM service_jobs WHERE workspace_id=? AND status='running'").get(workspaceId);
        return { queued: counts.queued!, running: counts.running!, finished: counts.finished!, stopped: counts.stopped!,
            interrupted: counts.interrupted!, oldestQueuedAt: oldest ? String(oldest.admitted_at) : null,
            activeJobId: active ? String(active.id) : null };
    }

    claimServiceJob(workspaceId: string, instanceId: string, at: string): ServiceJob | undefined {
        this.#requireServiceQueue();
        try { identifier(workspaceId, 'workspaceId'); identifier(instanceId, 'instanceId'); instant(at); }
        catch { serviceFailure('invalid', 'Invalid service claim.'); }
        return this.#transaction(() => {
            const state = this.state(workspaceId);
            if (this.#db.prepare("SELECT 1 FROM service_jobs WHERE workspace_id=? AND status='running'").get(workspaceId)) return undefined;
            const row = this.#db.prepare("SELECT * FROM service_jobs WHERE workspace_id=? AND status='queued' ORDER BY position LIMIT 1")
                .get(workspaceId) as Row | undefined;
            if (!row) return undefined;
            const job = this.#serviceJobRow(workspaceId, String(row.id))!.job;
            if (job.parameters.kind === 'readback') {
                const action = state.actions[job.parameters.actionId];
                const outcome = action?.attemptId === undefined ? undefined : this.journal(workspaceId).find(record =>
                    record.event.type === 'action.finished' && record.event.data.id === action.id &&
                    record.event.data.attemptId === action.attemptId);
                if (outcome) job.actionRecordId = outcome.id;
                else if (action && ['accepted', 'unknown', 'failed'].includes(action.status))
                    serviceFailure('integrity', 'Readback historical outcome is missing.');
            }
            const claim: ServiceJobClaim = { jobId: job.id, claimId: randomUUID(), instanceId };
            return this.#updateServiceJob(row, { ...job, status: 'running', startedAt: at, claim });
        });
    }

    #claimedServiceJob(workspaceId: string, claim: ServiceJobClaim): { row: Row; job: ServiceJob } {
        serviceObject(claim, 'service claim');
        try { identifier(claim.jobId, 'jobId'); identifier(claim.claimId, 'claimId'); identifier(claim.instanceId, 'instanceId'); }
        catch { serviceFailure('invalid', 'Invalid service claim.'); }
        const found = this.#serviceJobRow(workspaceId, claim.jobId);
        if (!found || found.job.status !== 'running' || found.job.claim?.claimId !== claim.claimId ||
            found.job.claim.instanceId !== claim.instanceId) serviceFailure('conflict', 'Service claim is no longer current.');
        return found;
    }

    #validateServiceResult(job: ServiceJob, result: ServiceJobResult,
        status: 'finished' | 'stopped' | 'interrupted'): void {
        try {
            const records = new Map<string, JournalRecord>();
            if (!Array.isArray(result.recordIds) || result.recordIds.length > 1000)
                serviceFailure('integrity', 'Invalid service job result.');
            for (const id of result.recordIds) {
                identifier(id, 'recordId'); records.set(id, this.record(job.workspaceId, id));
            }
            verifyServiceResult(result, { ...job, status }, records);
        } catch { serviceFailure('integrity', 'Invalid service job result provenance.'); }
    }

    completeServiceJob(workspaceId: string, claim: ServiceJobClaim, status: 'finished' | 'stopped' | 'interrupted',
        result: ServiceJobResult, at: string, beforeCommit?: () => void): ServiceJob {
        this.#requireServiceQueue();
        if (!['finished', 'stopped', 'interrupted'].includes(status)) serviceFailure('invalid', 'Invalid terminal service status.');
        try { identifier(workspaceId, 'workspaceId'); instant(at); } catch { serviceFailure('invalid', 'Invalid service completion.'); }
        return this.#serviceTransaction(checkBeforeCommit => {
            const found = this.#claimedServiceJob(workspaceId, claim);
            this.#validateServiceResult(found.job, result, status);
            const finalResult: ServiceJobResult = structuredClone(result);
            if (found.job.kind === 'reminder' && found.job.parameters.kind === 'reminder' && status !== 'interrupted') {
                const inbox = this.#db.prepare('SELECT handled FROM inbox WHERE workspace_id=? AND record_id=?')
                    .get(workspaceId, found.job.parameters.timerRecordId);
                if (!inbox || Number(inbox.handled) !== 0) serviceFailure('integrity', 'Reminder inbox record is unavailable.');
                const state = this.state(workspaceId);
                const handled = this.#append(workspaceId, state.version,
                    [{ type: 'inbox.handled', data: { recordId: found.job.parameters.timerRecordId } }],
                    { causationId: found.job.parameters.timerRecordId, recordedAt: at })[0]!;
                this.#db.prepare('UPDATE inbox SET handled=1 WHERE workspace_id=? AND record_id=?')
                    .run(workspaceId, found.job.parameters.timerRecordId);
                if (!finalResult.recordIds.includes(handled.id)) finalResult.recordIds.push(handled.id);
            }
            this.#validateServiceResult(found.job, finalResult, status);
            checkBeforeCommit();
            return this.#updateServiceJob(found.row, { ...found.job, status, finishedAt: at, result: finalResult });
        }, beforeCommit);
    }

    completeOwnerTurnJob(workspaceId: string, claim: ServiceJobClaim, input: CompleteOwnerTurnInput,
        beforeCommit?: () => void): CompleteOwnerTurnResult {
        this.#requireServiceQueue();
        try { identifier(workspaceId, 'workspaceId'); instant(input.at); } catch { serviceFailure('invalid', 'Invalid owner completion.'); }
        return this.#transaction(() => {
            const found = this.#claimedServiceJob(workspaceId, claim);
            if (found.job.kind !== 'owner_turn' || found.job.parameters.kind !== 'owner_turn' ||
                found.job.parameters.ownerRecordId !== input.ownerRecordId ||
                !['finished', 'stopped'].includes(input.status) || !SERVICE_STOP_REASONS.has(input.reason))
                serviceFailure('conflict', 'Owner completion does not match the claimed job.');
            const pending = this.#db.prepare('SELECT handled FROM inbox WHERE workspace_id=? AND record_id=?')
                .get(workspaceId, input.ownerRecordId);
            if (!pending || Number(pending.handled) !== 0) serviceFailure('conflict', 'Owner inbox record is unavailable.');
            try {
                serviceString(input.reply.text, 'assistant reply');
                identifier(input.reply.externalId, 'externalId'); identifier(input.reply.threadId, 'threadId');
                if (!['agent:model', 'agent:application'].includes(input.reply.source) ||
                    input.reply.threadId !== found.job.parameters.threadId) serviceFailure('invalid', 'Invalid owner completion reply.');
            } catch (error) {
                if (error instanceof ServiceStorageError) throw error;
                serviceFailure('invalid', 'Invalid owner completion reply.');
            }
            const artifactId = this.#artifact(workspaceId, input.reply.text);
            const assistantEvent: DomainEvent = { type: 'message.received', data: { source: input.reply.source,
                externalId: input.reply.externalId, threadId: input.reply.threadId, senderId: 'agent', senderRole: 'agent', artifactId } };
            const records = this.#append(workspaceId, input.expectedVersion,
                [...input.events, assistantEvent, { type: 'inbox.handled', data: { recordId: input.ownerRecordId } }],
                { causationId: input.ownerRecordId, recordedAt: input.at });
            const assistant = records.find(record => record.event.type === 'message.received' && record.event.data.senderRole === 'agent')!;
            this.#db.prepare('UPDATE inbox SET handled=1 WHERE workspace_id=? AND record_id=?').run(workspaceId, input.ownerRecordId);
            const result: ServiceJobResult = { reason: input.reason, recordIds: records.map(record => record.id),
                assistantRecordId: assistant.id };
            this.#validateServiceResult(found.job, result, input.status);
            beforeCommit?.();
            const job = this.#updateServiceJob(found.row, { ...found.job, status: input.status,
                finishedAt: input.at, result });
            return { job, records };
        });
    }

    startActionAttempt(workspaceId: string, expectedVersion: number, actionId: string, attemptId: string,
        metadata: RecordMetadata = {}, beforeAppend?: () => void, claim?: ServiceJobClaim): JournalRecord {
        if (claim) this.#requireServiceQueue();
        try { identifier(workspaceId, 'workspaceId'); identifier(actionId, 'actionId'); identifier(attemptId, 'attemptId'); }
        catch { serviceFailure('invalid', 'Invalid action attempt.'); }
        return this.#transaction(() => {
            let found: { row: Row; job: ServiceJob } | undefined;
            if (claim) {
                found = this.#claimedServiceJob(workspaceId, claim);
                const state = this.state(workspaceId);
                const action = state.actions[actionId];
                if (found.job.kind !== 'execute' || found.job.parameters.kind !== 'execute' ||
                    found.job.parameters.actionId !== actionId || found.job.parameters.digest !== action?.digest || found.job.attemptId)
                    serviceFailure('conflict', 'Action attempt does not match the claimed service job.');
            }
            beforeAppend?.();
            const record = this.#append(workspaceId, expectedVersion,
                [{ type: 'action.started', data: { id: actionId, attemptId } }], metadata)[0]!;
            if (found) this.#updateServiceJob(found.row, { ...found.job, attemptId });
            return record;
        });
    }

    /** Atomically persist trusted readback evidence and bind its exact record to the active service claim. */
    recordActionVerification(workspaceId: string, expectedVersion: number, actionId: string,
        events: DomainEvent[], metadata: RecordMetadata = {}, beforeAppend?: () => void,
        claim?: ServiceJobClaim): JournalRecord[] {
        if (claim) this.#requireServiceQueue();
        try { identifier(workspaceId, 'workspaceId'); identifier(actionId, 'actionId'); }
        catch { serviceFailure('invalid', 'Invalid action verification.'); }
        return this.#transaction(() => {
            let found: { row: Row; job: ServiceJob } | undefined;
            if (claim) {
                found = this.#claimedServiceJob(workspaceId, claim);
                const state = this.state(workspaceId);
                const action = state.actions[actionId];
                if (!['execute', 'readback'].includes(found.job.kind) ||
                    (found.job.parameters.kind !== 'execute' && found.job.parameters.kind !== 'readback') ||
                    found.job.parameters.actionId !== actionId || found.job.parameters.digest !== action?.digest ||
                    found.job.verificationRecordId !== undefined)
                    serviceFailure('conflict', 'Action verification does not match the claimed service job.');
                if (found.job.kind === 'readback') {
                    const outcome = found.job.actionRecordId === undefined ? undefined
                        : this.record(workspaceId, found.job.actionRecordId);
                    if (outcome?.event.type !== 'action.finished' || outcome.event.data.id !== actionId ||
                        outcome.event.data.attemptId !== action?.attemptId)
                        serviceFailure('integrity', 'Readback historical outcome does not match its claim.');
                }
            }
            beforeAppend?.();
            const records = this.#append(workspaceId, expectedVersion, events, metadata);
            const verification = records.filter(record => record.event.type === 'action.verification_recorded' &&
                record.event.data.id === actionId);
            if (verification.length !== 1 || verification[0]!.event.type !== 'action.verification_recorded' ||
                verification[0]!.event.data.verification.status === 'owner_attested')
                serviceFailure('integrity', 'Invalid trusted action verification record.');
            if (found) this.#updateServiceJob(found.row, { ...found.job, verificationRecordId: verification[0]!.id });
            return records;
        });
    }

    inspectInterruptedServiceJobs(workspaceId: string, at: string): { repaired: number; interrupted: number } {
        this.#requireServiceQueue();
        try { identifier(workspaceId, 'workspaceId'); instant(at); } catch { serviceFailure('invalid', 'Invalid interrupted-job inspection.'); }
        return this.#transaction(() => {
            this.state(workspaceId);
            let repaired = 0, interrupted = 0;
            const records = this.journal(workspaceId);
            const rows = this.#db.prepare("SELECT * FROM service_jobs WHERE workspace_id=? AND status='running' ORDER BY position")
                .all(workspaceId) as Row[];
            for (const row of rows) {
                const job = this.#serviceJobRow(workspaceId, String(row.id))!.job;
                let result: ServiceJobResult | undefined;
                let status: 'finished' | 'stopped' | 'interrupted' = 'interrupted';
                const verification = job.verificationRecordId === undefined ? undefined
                    : records.find(record => record.id === job.verificationRecordId);
                if (job.verificationRecordId !== undefined &&
                    (verification?.event.type !== 'action.verification_recorded' ||
                    (job.parameters.kind !== 'execute' && job.parameters.kind !== 'readback') ||
                    verification.event.data.id !== job.parameters.actionId ||
                    verification.event.data.verification.status === 'owner_attested'))
                    serviceFailure('integrity', 'Claimed action verification is invalid.');
                if (job.kind === 'execute' && job.parameters.kind === 'execute' && job.attemptId) {
                    const parameters = job.parameters;
                    const outcome = records.find(record => record.event.type === 'action.finished' &&
                        record.event.data.id === parameters.actionId && record.event.data.attemptId === job.attemptId);
                    if (outcome?.event.type === 'action.finished') {
                        const satisfied = verification?.event.type === 'action.verification_recorded' &&
                            verification.event.data.verification.status === 'satisfied';
                        status = outcome.event.data.status === 'accepted' && satisfied ? 'finished' : 'stopped';
                        result = { reason: outcome.event.data.status === 'accepted'
                            ? satisfied ? 'completed' : 'readback_unresolved'
                            : outcome.event.data.status === 'failed' ? 'action_failed' : 'action_unknown',
                            recordIds: [outcome.id, ...(verification ? [verification.id] : [])],
                            actionId: parameters.actionId, attemptId: job.attemptId, actionRecordId: outcome.id,
                            ...(verification ? { verificationRecordId: verification.id } : {}) };
                    }
                } else if (job.kind === 'readback' && job.parameters.kind === 'readback' && verification?.event.type === 'action.verification_recorded') {
                    const outcome = records.find(record => record.id === job.actionRecordId);
                    if (outcome?.event.type !== 'action.finished' || outcome.event.data.id !== job.parameters.actionId)
                        serviceFailure('integrity', 'Readback historical outcome is missing.');
                    const satisfied = verification.event.data.verification.status === 'satisfied';
                    status = satisfied ? 'finished' : 'stopped';
                    result = { reason: satisfied ? 'completed' : 'readback_unresolved', recordIds: [outcome.id, verification.id],
                        actionId: job.parameters.actionId, actionRecordId: outcome.id, attemptId: outcome.event.data.attemptId,
                        verificationRecordId: verification.id };
                } else if (job.kind === 'owner_turn' && job.parameters.kind === 'owner_turn') {
                    const parameters = job.parameters;
                    const handled = records.find(record => record.event.type === 'inbox.handled' &&
                        record.event.data.recordId === parameters.ownerRecordId);
                    const assistant = records.find(record => record.event.type === 'message.received' &&
                        record.event.data.senderRole === 'agent' && record.causationId === parameters.ownerRecordId);
                    if (handled && assistant) {
                        status = 'finished';
                        result = { reason: 'completed', recordIds: [assistant.id, handled.id], assistantRecordId: assistant.id };
                    }
                } else if (job.kind === 'reminder' && job.parameters.kind === 'reminder') {
                    const parameters = job.parameters;
                    const handled = records.find(record => record.event.type === 'inbox.handled' &&
                        record.event.data.recordId === parameters.timerRecordId);
                    if (handled) {
                        status = 'finished';
                        result = { reason: 'completed', recordIds: [parameters.timerRecordId, handled.id], timerId: parameters.timerId };
                    }
                }
                if (result) repaired++;
                else {
                    interrupted++;
                    result = job.parameters.kind === 'reminder'
                        ? { reason: 'process_interrupted', recordIds: [job.parameters.timerRecordId], timerId: job.parameters.timerId }
                        : { reason: 'process_interrupted', recordIds: [] };
                }
                this.#validateServiceResult(job, result, status);
                this.#updateServiceJob(row, { ...job, status, finishedAt: at, result });
            }
            return { repaired, interrupted };
        });
    }
}
