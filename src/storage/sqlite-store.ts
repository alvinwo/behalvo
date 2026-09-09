import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { emptyState, reduce } from '../kernel/reducer.js';
import type { DomainEvent, JournalRecord, MessageInput, OutcomeStatus, RecordMetadata, State, Summary } from '../kernel/types.js';
import { identifier, instant, nonempty } from '../kernel/types.js';
type Row = Record<string, string | number | bigint | Uint8Array | null>;
const SCHEMA = 1;
/** Internal trusted persistence API. Do not expose append() to models or untrusted plugins. */
export class SqliteStore {
    #db: DatabaseSync;
    #closed = false;
    constructor(path: string) {
        this.#db = new DatabaseSync(path);
        this.#db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;');
        const version = Number(this.#db.prepare('PRAGMA user_version').get()!.user_version);
        if (version !== 0 && version !== SCHEMA) {
            this.close();
            throw new Error('Unsupported database schema version');
        }
        if (version === 0)
            this.#db.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE journal (
        position INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
        workspace_id TEXT NOT NULL, seq INTEGER NOT NULL, schema_version INTEGER NOT NULL,
        recorded_at TEXT NOT NULL, actor_id TEXT NOT NULL, causation_id TEXT,
        event_json TEXT NOT NULL, UNIQUE(workspace_id,seq)
      );
      CREATE TRIGGER journal_no_update BEFORE UPDATE ON journal BEGIN SELECT RAISE(ABORT,'journal is append-only'); END;
      CREATE TRIGGER journal_no_delete BEFORE DELETE ON journal BEGIN SELECT RAISE(ABORT,'journal is append-only'); END;
      CREATE TABLE projections (workspace_id TEXT PRIMARY KEY, version INTEGER NOT NULL, projection_version INTEGER NOT NULL, state_json TEXT NOT NULL);
      CREATE TABLE artifacts (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, body TEXT NOT NULL);
      CREATE TABLE inbox (workspace_id TEXT NOT NULL, source TEXT NOT NULL, external_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
        record_id TEXT NOT NULL, handled INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(workspace_id,source,external_id));
      CREATE INDEX inbox_pending ON inbox(workspace_id,handled);
      CREATE TABLE summaries (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, thread_id TEXT NOT NULL,
        source_ids TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL);
      PRAGMA user_version=1;
      COMMIT;
    `);
    }
    close(): void { if (!this.#closed) {
        this.#db.close();
        this.#closed = true;
    } }
    #transaction<T>(fn: () => T): T {
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
    #load(workspaceId: string): State | undefined {
        const row = this.#db.prepare('SELECT * FROM projections WHERE workspace_id=?').get(workspaceId);
        if (!row)
            return undefined;
        if (Number(row.projection_version) !== SCHEMA)
            throw new Error('Unsupported projection version; rebuild required');
        const state = JSON.parse(String(row.state_json)) as State;
        state.connections ??= {};
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
            .run(s.workspaceId, s.version, SCHEMA, JSON.stringify(s));
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
            s = reduce(s, record.event, record.seq);
            this.#db.prepare('INSERT INTO journal(id,workspace_id,seq,schema_version,recorded_at,actor_id,causation_id,event_json) VALUES (?,?,?,?,?,?,?,?)')
                .run(record.id, workspaceId, record.seq, SCHEMA, record.recordedAt, record.actorId, record.causationId, JSON.stringify(record.event));
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
    append(workspaceId: string, expectedVersion: number, events: DomainEvent[], metadata: RecordMetadata = {}): JournalRecord[] {
        return this.#transaction(() => this.#append(workspaceId, expectedVersion, events, metadata));
    }
    #decode(row: Row): JournalRecord {
        if (Number(row.schema_version) !== SCHEMA)
            throw new Error('Unsupported journal schema version');
        return { id: String(row.id), schemaVersion: 1, workspaceId: String(row.workspace_id), seq: Number(row.seq),
            recordedAt: String(row.recorded_at), actorId: String(row.actor_id), causationId: row.causation_id === null ? null : String(row.causation_id),
            event: JSON.parse(String(row.event_json)) as DomainEvent };
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
            state = reduce(state, record.event, record.seq);
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
                s = reduce(s, record.event, record.seq);
            }
            this.#save(s);
            return s;
        });
    }
    #artifact(workspaceId: string, body: string): string {
        const id = randomUUID();
        this.#db.prepare('INSERT INTO artifacts VALUES (?,?,?)').run(id, workspaceId, body);
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
        return String(row.body);
    }
    ingest(workspaceId: string, input: MessageInput): JournalRecord {
        nonempty(input.source, 'source binding');
        nonempty(input.externalId, 'externalId');
        nonempty(input.text, 'message text');
        if (Buffer.byteLength(input.text, 'utf8') > 262144)
            throw new Error('Message exceeds size limit');
        const fingerprint = createHash('sha256').update(JSON.stringify([input.source, input.externalId, input.threadId, input.senderId, input.senderRole, input.text])).digest('hex');
        return this.#transaction(() => {
            const s = this.state(workspaceId);
            if (input.senderRole === 'owner' && input.senderId !== s.ownerId)
                throw new Error('Owner binding mismatch');
            const found = this.#db.prepare('SELECT * FROM inbox WHERE workspace_id=? AND source=? AND external_id=?').get(workspaceId, input.source, input.externalId);
            if (found) {
                if (found.fingerprint !== fingerprint)
                    throw new Error('Delivery key collision');
                return this.record(workspaceId, String(found.record_id));
            }
            const artifactId = this.#artifact(workspaceId, input.text);
            const event: DomainEvent = { type: 'message.received', data: { source: input.source, externalId: input.externalId, threadId: input.threadId, senderId: input.senderId, senderRole: input.senderRole, artifactId } };
            const record = this.#append(workspaceId, s.version, [event], { actorId: input.senderId })[0]!;
            this.#db.prepare('INSERT INTO inbox(workspace_id,source,external_id,fingerprint,record_id) VALUES (?,?,?,?,?)').run(workspaceId, input.source, input.externalId, fingerprint, record.id);
            return record;
        });
    }
    inbox(workspaceId: string): JournalRecord[] {
        this.state(workspaceId);
        return this.#db.prepare(`SELECT j.* FROM inbox i JOIN journal j ON j.id=i.record_id AND j.workspace_id=i.workspace_id
      WHERE i.workspace_id=? AND i.handled=0 ORDER BY j.seq`).all(workspaceId).map(r => this.#decode(r));
    }
    completeInbox(workspaceId: string, recordId: string, expectedVersion: number, events: DomainEvent[]): JournalRecord[] {
        return this.#transaction(() => {
            const row = this.#db.prepare('SELECT handled FROM inbox WHERE workspace_id=? AND record_id=?').get(workspaceId, recordId);
            if (!row || Number(row.handled) !== 0)
                throw new Error('Inbox record already handled or not found');
            const records = this.#append(workspaceId, expectedVersion, [...events, { type: 'inbox.handled', data: { recordId } }], { causationId: recordId });
            this.#db.prepare('UPDATE inbox SET handled=1 WHERE workspace_id=? AND record_id=?').run(workspaceId, recordId);
            return records;
        });
    }
    /** Commit a timer firing and its processable inbox record together. */
    enqueueTimer(workspaceId: string, expectedVersion: number, timerId: string, at: string): JournalRecord {
        return this.#transaction(() => {
            const record = this.#append(workspaceId, expectedVersion, [{ type: 'timer.fired', data: { id: timerId } }], { recordedAt: at })[0]!;
            this.#db.prepare('INSERT INTO inbox(workspace_id,source,external_id,fingerprint,record_id) VALUES (?,?,?,?,?)')
                .run(workspaceId, 'kernel:timer', timerId, timerId, record.id);
            return record;
        });
    }
    threadMessages(workspaceId: string, threadId: string, limit = 50): JournalRecord[] {
        this.state(workspaceId);
        identifier(threadId);
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10000)
            throw new Error('Invalid message limit');
        return this.#db.prepare(`SELECT * FROM journal WHERE workspace_id=? AND json_extract(event_json,'$.type')='message.received'
      AND json_extract(event_json,'$.data.threadId')=? ORDER BY seq DESC LIMIT ?`).all(workspaceId, threadId, limit).map(r => this.#decode(r)).reverse();
    }
    messageCount(workspaceId: string, threadId: string): number {
        return Number(this.#db.prepare(`SELECT count(*) AS n FROM journal WHERE workspace_id=? AND json_extract(event_json,'$.type')='message.received'
      AND json_extract(event_json,'$.data.threadId')=?`).get(workspaceId, threadId)!.n);
    }
    saveSummary(workspaceId: string, input: {
        threadId: string;
        sourceIds: string[];
        text: string;
    }): Summary {
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
        this.#db.prepare('INSERT INTO summaries VALUES (?,?,?,?,?,?)').run(summary.id, workspaceId, summary.threadId, JSON.stringify(summary.sourceIds), summary.text, summary.createdAt);
        return summary;
    }
    summaries(workspaceId: string, threadId: string): Summary[] {
        this.state(workspaceId);
        return this.#db.prepare('SELECT * FROM summaries WHERE workspace_id=? AND thread_id=? ORDER BY rowid DESC LIMIT 8').all(workspaceId, threadId).map(row => ({
            id: String(row.id), workspaceId, threadId, sourceIds: JSON.parse(String(row.source_ids)) as string[], text: String(row.body), createdAt: String(row.created_at)
        }));
    }
}
