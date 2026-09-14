import { randomUUID } from 'node:crypto';
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
const PROTECTION_SCHEMA = 'CREATE TABLE storage_protection (id INTEGER PRIMARY KEY CHECK(id=1), format INTEGER NOT NULL, database_id TEXT NOT NULL, verification TEXT NOT NULL)';
const LOCAL_MODE_SCHEMA = 'CREATE TABLE local_mode (id INTEGER PRIMARY KEY CHECK(id=1), mode TEXT NOT NULL)';
const VERIFICATION = 'behalvo/storage/v1/verified';

function fail(): never { throw new Error('Invalid storage format or encryption key.'); }
function normalized(sql: string): string { return sql.trim().replace(/\s+/g, ' '); }

/** Validate the exact supported v2 schema, including constraints and trigger bodies. */
export function validateEncryptedSchema(db: DatabaseSync): void {
    const expected = new Set([...DOMAIN_SCHEMA, PROTECTION_SCHEMA].map(normalized));
    const rows = db.prepare("SELECT name, sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*'").all();
    for (const row of rows) {
        if (row.name === 'local_mode' && typeof row.sql === 'string' && normalized(row.sql) === LOCAL_MODE_SCHEMA) {
            const modes = db.prepare('SELECT id, mode FROM local_mode').all();
            if (modes.length > 1 || modes.some(mode => mode.id !== 1 || !['ordinary', 'synthetic'].includes(String(mode.mode)))) fail();
        } else if (typeof row.sql !== 'string' || !expected.delete(normalized(row.sql))) fail();
    }
    if (expected.size !== 0) fail();
}

/** Read-only validation: never initialize or repair an existing database. */
export function validateStorage(db: DatabaseSync, encryptionKey?: Uint8Array): PayloadCipher | undefined {
    try {
        const version = db.prepare('PRAGMA user_version').get()!.user_version;
        if (version === 1) {
            if (encryptionKey !== undefined || db.prepare("SELECT 1 FROM sqlite_schema WHERE name='storage_protection'").get()) fail();
            return undefined;
        }
        if (version !== 2 || encryptionKey === undefined) fail();
        validateEncryptedSchema(db);
        const rows = db.prepare('SELECT * FROM storage_protection').all();
        if (rows.length !== 1) fail();
        const row = rows[0]!;
        if (row.id !== 1 || row.format !== 1 || typeof row.database_id !== 'string' || typeof row.verification !== 'string') fail();
        const cipher = new PayloadCipher(encryptionKey, row.database_id);
        if (cipher.open(row.verification, ['metadata', 'verification']) !== VERIFICATION) fail();
        return cipher;
    } catch { fail(); }
}

/** Only an empty version-0 schema can be initialized; both formats commit atomically. */
export function initializeStorage(db: DatabaseSync, encryptionKey?: Uint8Array): PayloadCipher | undefined {
    if (db.prepare('PRAGMA user_version').get()!.user_version !== 0) return validateStorage(db, encryptionKey);
    if (db.prepare('SELECT 1 FROM sqlite_schema LIMIT 1').get()) fail();
    const databaseId = randomUUID();
    const cipher = encryptionKey === undefined ? undefined : new PayloadCipher(encryptionKey, databaseId);
    db.exec('BEGIN IMMEDIATE');
    try {
        // Recheck under the writer lock so a concurrent initializer cannot be overwritten.
        if (db.prepare('PRAGMA user_version').get()!.user_version !== 0 || db.prepare('SELECT 1 FROM sqlite_schema LIMIT 1').get()) fail();
        for (const sql of DOMAIN_SCHEMA) db.exec(sql);
        if (cipher) {
            db.exec(PROTECTION_SCHEMA);
            db.prepare('INSERT INTO storage_protection VALUES (1,1,?,?)').run(databaseId, cipher.seal(VERIFICATION, ['metadata', 'verification']));
        }
        db.exec(`PRAGMA user_version=${cipher ? 2 : 1}`);
        db.exec('COMMIT');
        return cipher;
    } catch (error) {
        db.exec('ROLLBACK');
        throw error;
    }
}
