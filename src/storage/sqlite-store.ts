import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { emptyState, reduce } from '../kernel/reducer.js';
import type { DomainEvent, JournalRecord, MessageInput, OutcomeStatus, RecordMetadata, State, Summary } from '../kernel/types.js';
import { identifier, instant, nonempty } from '../kernel/types.js';
import type { PayloadCipher } from './payload-cipher.js';
import { backupEncryptedStore } from './backup.js';
import { preparePrivateDatabasePath } from './private-files.js';
import { initializeStorage, validateStorage } from './sqlite-schema.js';
import { artifactContext, decodeProjection, decodeRecord, decodeSummary, journalContext, messageTokens, open, projectionContext, seal, summaryContext, summaryThread, timerTokens } from './sqlite-codec.js';
import type { Row } from './sqlite-codec.js';
const SCHEMA = 1;
/** Internal trusted persistence API. Do not expose append() to models or untrusted plugins. */
export class SqliteStore {
    #db: DatabaseSync;
    #closed = false;
    #cipher: PayloadCipher | undefined;
    #encryptionKey: Uint8Array | undefined;
    #readOnly: boolean;
    constructor(path: string, options: { encryptionKey?: Uint8Array; readOnly?: boolean } = {}) {
        if (!options || typeof options !== 'object' || Array.isArray(options) ||
            Object.keys(options).some(key => !['encryptionKey', 'readOnly'].includes(key)) ||
            (options.readOnly !== undefined && typeof options.readOnly !== 'boolean') ||
            (options.encryptionKey !== undefined && (!(options.encryptionKey instanceof Uint8Array) || options.encryptionKey.byteLength !== 32)))
            throw new Error('Invalid storage options.');
        this.#readOnly = options.readOnly ?? false;
        this.#encryptionKey = options.encryptionKey === undefined ? undefined : Uint8Array.from(options.encryptionKey);
        if (options.encryptionKey !== undefined && path !== ':memory:') preparePrivateDatabasePath(path, this.#readOnly);
        this.#db = new DatabaseSync(path, { readOnly: this.#readOnly });
        try {
            this.#cipher = this.#readOnly ? validateStorage(this.#db, options.encryptionKey) : initializeStorage(this.#db, options.encryptionKey);
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
}
