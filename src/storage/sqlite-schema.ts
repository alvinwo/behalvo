import { randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { PayloadCipher } from './payload-cipher.js';

const DOMAIN_SCHEMA = [
    `CREATE TABLE journal (
        position INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
        workspace_id TEXT NOT NULL, seq INTEGER NOT NULL, schema_version INTEGER NOT NULL,
        recorded_at TEXT NOT NULL, actor_id TEXT NOT NULL, causation_id TEXT,
        event_json TEXT NOT NULL, UNIQUE(workspace_id,seq)
      )`,
    `CREATE TRIGGER journal_no_update BEFORE UPDATE ON journal BEGIN SELECT RAISE(ABORT,'journal is append-only'); END`,
    `CREATE TRIGGER journal_no_delete BEFORE DELETE ON journal BEGIN SELECT RAISE(ABORT,'journal is append-only'); END`,
    `CREATE TABLE projections (workspace_id TEXT PRIMARY KEY, version INTEGER NOT NULL, projection_version INTEGER NOT NULL, state_json TEXT NOT NULL)`,
    `CREATE TABLE artifacts (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, body TEXT NOT NULL)`,
    `CREATE TABLE inbox (workspace_id TEXT NOT NULL, source TEXT NOT NULL, external_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
        record_id TEXT NOT NULL, handled INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(workspace_id,source,external_id))`,
    `CREATE INDEX inbox_pending ON inbox(workspace_id,handled)`,
    `CREATE TABLE summaries (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, thread_id TEXT NOT NULL,
        source_ids TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL)`
];
const SERVICE_REQUESTS_SCHEMA = `CREATE TABLE service_requests (
        workspace_id TEXT NOT NULL, source TEXT NOT NULL, request_id TEXT NOT NULL,
        fingerprint TEXT NOT NULL, receipt_id TEXT NOT NULL, admitted_at TEXT NOT NULL,
        envelope_json TEXT NOT NULL, receipt_json TEXT NOT NULL,
        PRIMARY KEY(workspace_id,source,request_id), UNIQUE(workspace_id,receipt_id)
      )`;
function serviceJobsSchema(kinds: string): string { return `CREATE TABLE service_jobs (
        position INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
        workspace_id TEXT NOT NULL, receipt_id TEXT NOT NULL, kind TEXT NOT NULL,
        status TEXT NOT NULL, admitted_at TEXT NOT NULL, started_at TEXT, finished_at TEXT,
        claim_id TEXT, instance_id TEXT, attempt_id TEXT, job_json TEXT NOT NULL,
        UNIQUE(workspace_id,receipt_id),
        FOREIGN KEY(workspace_id,receipt_id) REFERENCES service_requests(workspace_id,receipt_id),
        CHECK(kind IN (${kinds})),
        CHECK(status IN ('queued','running','finished','stopped','interrupted')),
        CHECK((status='queued' AND started_at IS NULL AND finished_at IS NULL AND claim_id IS NULL AND instance_id IS NULL)
          OR (status='running' AND started_at IS NOT NULL AND finished_at IS NULL AND claim_id IS NOT NULL AND instance_id IS NOT NULL)
          OR (status IN ('finished','stopped','interrupted') AND started_at IS NOT NULL AND finished_at IS NOT NULL AND claim_id IS NOT NULL AND instance_id IS NOT NULL))
      )`; }
const SERVICE_INDEXES = [
    `CREATE INDEX service_jobs_pending ON service_jobs(workspace_id,status,position)`,
    `CREATE UNIQUE INDEX service_jobs_one_running ON service_jobs(workspace_id) WHERE status='running'`
];
export const SERVICE_SCHEMA = [
    SERVICE_REQUESTS_SCHEMA,
    serviceJobsSchema("'owner_turn','execute','readback','reminder','monitor'"),
    ...SERVICE_INDEXES,
    'CREATE TABLE monitor_installation (id INTEGER PRIMARY KEY CHECK(id=1), state_json TEXT NOT NULL)'
];
const PREVIOUS_MONITOR_SERVICE_SCHEMA = [SERVICE_REQUESTS_SCHEMA,
    serviceJobsSchema("'owner_turn','execute','readback','reminder','monitor'"), ...SERVICE_INDEXES];
const LEGACY_SERVICE_SCHEMA = [SERVICE_REQUESTS_SCHEMA,
    serviceJobsSchema("'owner_turn','execute','readback','reminder'"), ...SERVICE_INDEXES];
const PROTECTION_SCHEMA = 'CREATE TABLE storage_protection (id INTEGER PRIMARY KEY CHECK(id=1), format INTEGER NOT NULL, database_id TEXT NOT NULL, verification TEXT NOT NULL)';
const LOCAL_MODE_SCHEMA = 'CREATE TABLE local_mode (id INTEGER PRIMARY KEY CHECK(id=1), mode TEXT NOT NULL)';
const VERIFICATION = 'behalvo/storage/v1/verified';

function fail(): never { throw new Error('Invalid storage format or encryption key.'); }
function normalized(sql: string): string { return sql.trim().replace(/\s+/g, ' '); }

function exactSchemaMatches(db: DatabaseSync, serviceSchema: readonly string[], encrypted: boolean): boolean {
    const expected = new Set([...DOMAIN_SCHEMA, ...serviceSchema, ...(encrypted ? [PROTECTION_SCHEMA] : [])].map(normalized));
    const rows = db.prepare("SELECT name, sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*'").all();
    for (const row of rows) {
        if (row.name === 'local_mode' && typeof row.sql === 'string' && normalized(row.sql) === LOCAL_MODE_SCHEMA) {
            const modes = db.prepare('SELECT id, mode FROM local_mode').all();
            if (modes.length > 1 || modes.some(mode => mode.id !== 1 || !['ordinary', 'synthetic'].includes(String(mode.mode)))) return false;
        } else if (typeof row.sql !== 'string' || !expected.delete(normalized(row.sql))) return false;
    }
    return expected.size === 0;
}

function validateExactSchema(db: DatabaseSync, service: boolean, encrypted: boolean): void {
    if (service) {
        if (!exactSchemaMatches(db, SERVICE_SCHEMA, encrypted) &&
            !exactSchemaMatches(db, PREVIOUS_MONITOR_SERVICE_SCHEMA, encrypted) &&
            !exactSchemaMatches(db, LEGACY_SERVICE_SCHEMA, encrypted)) fail();
    } else if (!exactSchemaMatches(db, [], encrypted)) fail();
}

export interface MonitorInstallationState { generation: string; active: boolean; storageIdentity: string }
const MONITOR_INSTALLATION_CONTEXT = ['metadata', 'monitor-installation'] as const;

function encodeMonitorInstallation(value: MonitorInstallationState, cipher?: PayloadCipher): string {
    const text = JSON.stringify(value);
    return cipher ? cipher.seal(text, [...MONITOR_INSTALLATION_CONTEXT]) : text;
}

export function monitorInstallationState(db: DatabaseSync, cipher?: PayloadCipher): MonitorInstallationState | undefined {
    const table = db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='monitor_installation'").get();
    if (!table) return undefined;
    const rows = db.prepare('SELECT * FROM monitor_installation').all();
    if (rows.length !== 1 || rows[0]!.id !== 1 || typeof rows[0]!.state_json !== 'string') fail();
    try {
        const text = cipher ? cipher.open(String(rows[0]!.state_json), [...MONITOR_INSTALLATION_CONTEXT]) : String(rows[0]!.state_json);
        const value = JSON.parse(text) as unknown;
        if (!value || typeof value !== 'object' || Array.isArray(value) ||
            Object.keys(value).length !== 3 || !Object.hasOwn(value, 'generation') || !Object.hasOwn(value, 'active') ||
            !Object.hasOwn(value, 'storageIdentity') ||
            typeof (value as MonitorInstallationState).generation !== 'string' ||
            !/^[0-9a-f-]{36}$/.test((value as MonitorInstallationState).generation) ||
            typeof (value as MonitorInstallationState).storageIdentity !== 'string' ||
            !/^(memory|file:[0-9a-f]+:[0-9a-f]+)$/.test((value as MonitorInstallationState).storageIdentity) ||
            typeof (value as MonitorInstallationState).active !== 'boolean') fail();
        return value as MonitorInstallationState;
    } catch { fail(); }
}

export function monitorStorageIdentity(path: string): string {
    if (path === ':memory:') return 'memory';
    const stat = statSync(path, { bigint: true });
    return `file:${stat.dev.toString(16)}:${stat.ino.toString(16)}`;
}

function createMonitorInstallation(db: DatabaseSync, storageIdentity: string,
    cipher?: PayloadCipher, active = true): MonitorInstallationState {
    const value = { generation: randomUUID(), active, storageIdentity };
    db.prepare('INSERT INTO monitor_installation VALUES (1,?)').run(encodeMonitorInstallation(value, cipher));
    return value;
}

export function setMonitorInstallationActive(db: DatabaseSync, cipher: PayloadCipher | undefined,
    active: boolean, rotate = false, storageIdentity?: string): MonitorInstallationState {
    const current = monitorInstallationState(db, cipher);
    if (!current) fail();
    const value = { generation: rotate ? randomUUID() : current.generation, active,
        storageIdentity: storageIdentity ?? current.storageIdentity };
    db.prepare('UPDATE monitor_installation SET state_json=? WHERE id=1').run(encodeMonitorInstallation(value, cipher));
    return value;
}

/** Validate exact supported encrypted schemas, including constraints and triggers. */
export function validateEncryptedSchema(db: DatabaseSync): void {
    const version = Number(db.prepare('PRAGMA user_version').get()!.user_version);
    if (version !== 2 && version !== 4) fail();
    validateExactSchema(db, version === 4, true);
}

function validatePlaintextSchema(db: DatabaseSync, service: boolean): void {
    validateExactSchema(db, service, false);
}

function upgradeLegacyServiceSchema(db: DatabaseSync): void {
    db.exec(`DROP INDEX service_jobs_pending;
      DROP INDEX service_jobs_one_running;
      ALTER TABLE service_jobs RENAME TO service_jobs_legacy`);
    db.exec(SERVICE_SCHEMA[1]!);
    db.exec(`INSERT INTO service_jobs
      (position,id,workspace_id,receipt_id,kind,status,admitted_at,started_at,finished_at,claim_id,instance_id,attempt_id,job_json)
      SELECT position,id,workspace_id,receipt_id,kind,status,admitted_at,started_at,finished_at,claim_id,instance_id,attempt_id,job_json
      FROM service_jobs_legacy`);
    db.exec('DROP TABLE service_jobs_legacy');
    for (const sql of SERVICE_INDEXES) db.exec(sql);
}

/** Read-only validation: never initialize or repair an existing database. */
export function validateStorage(db: DatabaseSync, encryptionKey?: Uint8Array): PayloadCipher | undefined {
    try {
        const version = Number(db.prepare('PRAGMA user_version').get()!.user_version);
        if (version === 1 || version === 3) {
            if (encryptionKey !== undefined || db.prepare("SELECT 1 FROM sqlite_schema WHERE name='storage_protection'").get()) fail();
            if (version === 3) validatePlaintextSchema(db, true);
            if (version === 3 && exactSchemaMatches(db, SERVICE_SCHEMA, false)) monitorInstallationState(db);
            return undefined;
        }
        if ((version !== 2 && version !== 4) || encryptionKey === undefined) fail();
        validateEncryptedSchema(db);
        const rows = db.prepare('SELECT * FROM storage_protection').all();
        if (rows.length !== 1) fail();
        const row = rows[0]!;
        if (row.id !== 1 || row.format !== 1 || typeof row.database_id !== 'string' || typeof row.verification !== 'string') fail();
        const cipher = new PayloadCipher(encryptionKey, row.database_id);
        if (cipher.open(row.verification, ['metadata', 'verification']) !== VERIFICATION) fail();
        if (exactSchemaMatches(db, SERVICE_SCHEMA, true)) monitorInstallationState(db, cipher);
        return cipher;
    } catch { fail(); }
}

/** Only an empty version-0 schema can be initialized; both formats commit atomically. */
export function initializeStorage(db: DatabaseSync, encryptionKey?: Uint8Array, options: {
    serviceQueue?: { upgradeExisting: boolean };
    beforeWrite?: () => void;
    monitorStorageIdentity?: string;
} = {}): PayloadCipher | undefined {
    const initialVersion = Number(db.prepare('PRAGMA user_version').get()!.user_version);
    if (initialVersion !== 0) {
        const cipher = validateStorage(db, encryptionKey);
        if (!options.serviceQueue) return cipher;
        if (initialVersion === 3 || initialVersion === 4) {
            const encrypted = initialVersion === 4;
            if (exactSchemaMatches(db, SERVICE_SCHEMA, encrypted) || !options.serviceQueue.upgradeExisting) return cipher;
            db.exec('BEGIN IMMEDIATE');
            try {
                if (Number(db.prepare('PRAGMA user_version').get()!.user_version) !== initialVersion) fail();
                const previousMonitor = exactSchemaMatches(db, PREVIOUS_MONITOR_SERVICE_SCHEMA, encrypted);
                const legacy = exactSchemaMatches(db, LEGACY_SERVICE_SCHEMA, encrypted);
                if (!previousMonitor && !legacy) fail();
                options.beforeWrite?.();
                if (legacy) upgradeLegacyServiceSchema(db);
                db.exec(SERVICE_SCHEMA.at(-1)!);
                if (!options.monitorStorageIdentity) fail();
                createMonitorInstallation(db, options.monitorStorageIdentity, cipher, false);
                if (!exactSchemaMatches(db, SERVICE_SCHEMA, encrypted)) fail();
                db.exec('COMMIT');
                return cipher;
            } catch (error) {
                db.exec('ROLLBACK');
                throw error;
            }
        }
        if (!options.serviceQueue.upgradeExisting)
            throw new Error('Storage upgrade is required before enabling the service queue.');
        if (initialVersion === 1) validatePlaintextSchema(db, false);
        db.exec('BEGIN IMMEDIATE');
        try {
            if (Number(db.prepare('PRAGMA user_version').get()!.user_version) !== initialVersion) fail();
            validateStorage(db, encryptionKey);
            if (initialVersion === 1) validatePlaintextSchema(db, false);
            options.beforeWrite?.();
            for (const sql of SERVICE_SCHEMA) db.exec(sql);
            if (!options.monitorStorageIdentity) fail();
            createMonitorInstallation(db, options.monitorStorageIdentity, cipher);
            db.exec(`PRAGMA user_version=${initialVersion === 1 ? 3 : 4}`);
            db.exec('COMMIT');
            return cipher;
        } catch (error) {
            db.exec('ROLLBACK');
            throw error;
        }
    }
    if (db.prepare('SELECT 1 FROM sqlite_schema LIMIT 1').get()) fail();
    const databaseId = randomUUID();
    const cipher = encryptionKey === undefined ? undefined : new PayloadCipher(encryptionKey, databaseId);
    db.exec('BEGIN IMMEDIATE');
    try {
        // Recheck under the writer lock so a concurrent initializer cannot be overwritten.
        if (db.prepare('PRAGMA user_version').get()!.user_version !== 0 || db.prepare('SELECT 1 FROM sqlite_schema LIMIT 1').get()) fail();
        options.beforeWrite?.();
        for (const sql of DOMAIN_SCHEMA) db.exec(sql);
        if (options.serviceQueue) for (const sql of SERVICE_SCHEMA) db.exec(sql);
        if (options.serviceQueue) {
            if (!options.monitorStorageIdentity) fail();
            createMonitorInstallation(db, options.monitorStorageIdentity, cipher);
        }
        if (cipher) {
            db.exec(PROTECTION_SCHEMA);
            db.prepare('INSERT INTO storage_protection VALUES (1,1,?,?)').run(databaseId, cipher.seal(VERIFICATION, ['metadata', 'verification']));
        }
        db.exec(`PRAGMA user_version=${options.serviceQueue ? (cipher ? 4 : 3) : (cipher ? 2 : 1)}`);
        db.exec('COMMIT');
        return cipher;
    } catch (error) {
        db.exec('ROLLBACK');
        throw error;
    }
}
