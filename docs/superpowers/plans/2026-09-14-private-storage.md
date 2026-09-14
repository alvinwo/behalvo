# Encrypted Workspace Storage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship opt-in encrypted workspace persistence with private key configuration and verified encrypted backup/restore.

**Architecture:** Keep the existing SQLite journal and transaction boundaries. A small authenticated payload codec protects sensitive columns, a separate file module controls private key/output handling, and the store owns encryption mode/schema validation. The CLI only configures these trusted APIs.

**Tech Stack:** TypeScript, Node crypto/fs/sqlite, node:test; existing pinned dependencies only.

**Spec:** `docs/superpowers/specs/2026-09-14-private-storage-design.md`

## Global Constraints

- Node.js **22.19.0+**, TypeScript modular monolith, no new dependencies.
- Use synthetic data only. Never ingest the maintainer's actual accounts into tests.
- Plaintext database storage version 1 remains compatible; encrypted storage version 2 never falls back to plaintext. Domain event/projection schema version stays 1.
- AES-256-GCM: random 32-byte root key, random 12-byte IV, 16-byte tag; HKDF-SHA-256 separates encryption and lookup keys using database UUID and purpose labels.
- All domain mutation goes through journal events and deterministic reduction. Replay, backup and restore never execute effects.
- New private file helpers require POSIX owner-only directories/files, safe regular leaf files and trusted ancestors. Never overwrite outputs or print keys/raw errors.
- No real-account connection, remote access, deployment, credential vault, erasure, key rotation or legacy migration is included. M1.1 live acceptance and M1.2 completion remain pending.

## File responsibilities

`src/storage/payload-cipher.ts` owns authenticated envelopes and lookup tokens.
`src/storage/private-files.ts` owns POSIX validation and exclusive staged publication.
`src/storage/key-file.ts` owns the versioned key document.
`src/storage/sqlite-schema.ts` owns database format initialization/validation.
`src/storage/sqlite-validation.ts` owns pure snapshot consistency validation.
`src/storage/sqlite-store.ts` remains the transaction and domain storage interface.
`src/storage/backup.ts` owns the SQLite snapshot lifecycle and calls validation.
`src/cli/storage-main.ts` owns keygen/backup/restore arguments and fixed output.
Existing CLI/local-app wiring opts in through a key-file path/key bytes.

### Task 1: Authenticated payload codec and private key files

**Files:**
- Create: `src/storage/payload-cipher.ts`, `src/storage/private-files.ts`, `src/storage/key-file.ts`
- Create: `tests/payload-cipher.test.mjs`, `tests/storage-key-file.test.mjs`
- Modify: `.gitignore` (add `*.behalvo-key`), `src/index.ts` (export key helpers)

**Interfaces:**
- Produces `class PayloadCipher { constructor(key: Uint8Array, databaseId: string); seal(value: string, context: readonly (string | number | null)[]): string; open(value: string, context: readonly (string | number | null)[]): string; lookup(purpose: string, workspaceId: string, values: readonly string[]): string; }`.
- Produces `createStorageKeyFile(path: string): Promise<void>` and `loadStorageKeyFile(path: string): Uint8Array`.
- Produces `ensurePrivateDirectory(path: string): void`, `validatePrivateFile(path: string, options?: { readOnly?: boolean }): void`, `preparePrivateDatabasePath(path: string, readOnly: boolean): void` and `publishPrivateFile(destination: string, write: (stagedPath: string) => Promise<void>, options?: { sqlite?: boolean }): Promise<void>`.
- All helpers have fixed safe errors. Key loading is bounded to 4096 bytes, requires a regular single-link file, and reads through a validated `O_NOFOLLOW | O_NONBLOCK` descriptor; validate mode/UID on that descriptor before reading. Permit 0400/0600 on read-only loads, 0600 for writable database/outputs. No raw exception cause in exposed errors.
- `preparePrivateDatabasePath` permits existing safe SQLite sidecars only alongside an existing main file; all must pass the same ownership/link/mode checks. New files are created exclusively with 0600 after rejecting existing sidecars. Read-only mode requires an existing main file and never creates files.
- `publishPrivateFile` uses a 0700 immediate staging directory, a 0600 staged file, fsync then exclusive hard-link publication (or equivalent no-replace operation), final directory fsync and cleanup of only its own staging directory. SQLite output checks include `-wal`, `-shm`, `-journal` before staging and immediately before publication.

- [ ] **Step 1: Write failing tests against the public behavior.** Use real crypto and temporary POSIX directories, never real keys/accounts. The following examples establish the central contracts; table tests add malformed/truncated/base64/version inputs and substitutions in each AAD dimension.

```js
const key = randomBytes(32);
const cipher = new PayloadCipher(key, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
const context = ['artifact', 'body', 'personal', 'artifact-1'];
const sealed = cipher.seal('synthetic private text', context);
assert.equal(cipher.open(sealed, context), 'synthetic private text');
assert.notEqual(cipher.seal('synthetic private text', context), sealed);
assert.throws(() => cipher.open(sealed, ['artifact', 'body', 'business', 'artifact-1']));
assert.throws(() => new PayloadCipher(randomBytes(32), 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa').open(sealed, context));
await createStorageKeyFile(keyPath);
assert.equal(loadStorageKeyFile(keyPath).byteLength, 32);
await assert.rejects(() => createStorageKeyFile(keyPath));
```

Also test tampered IV/tag/ciphertext; field/row/database swaps; HMAC stability and purpose/workspace separation; file/symlink/hardlink/permission rejection; safe cleanup on writer failure; destination preserved on collisions; stale SQLite sidecars rejected; no secret appearing in thrown messages.

- [ ] **Step 2: Run RED.** `npm run build && node --test tests/payload-cipher.test.mjs tests/storage-key-file.test.mjs`. Record expected missing implementation/export failures.
- [ ] **Step 3: Implement the codec and file helpers.** The envelope is strict JSON `{v:1,iv:<canonical base64>,tag:<canonical base64>,data:<canonical base64>}` with no extra fields. HKDF purpose labels are `behalvo/storage/v1/encryption` and `behalvo/storage/v1/lookup`; AAD is `JSON.stringify(['behalvo/storage/v1', databaseId, ...context])`. Key document is `{version:1,key:<canonical base64>}`. Use `createCipheriv`/`createDecipheriv` with explicit `authTagLength:16`, authenticate before returning decoded UTF-8, validate key/UUID inputs, and clone caller key bytes or derive immediately.

```ts
const iv = randomBytes(12);
const cipher = createCipheriv('aes-256-gcm', encryptionKey, iv, { authTagLength: 16 });
cipher.setAAD(Buffer.from(JSON.stringify(['behalvo/storage/v1', databaseId, ...context])));
const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
const tag = cipher.getAuthTag();
```

- [ ] **Step 4: Run focused GREEN, then `npm run check` once and `git diff --check`.** Record exact results and any platform skip.
- [ ] **Step 5: Self-review and commit the complete task.** Do not build the store/CLI in this task.

### Task 2: Encrypted SQLite format and snapshot validation

**Files:**
- Create: `src/storage/sqlite-schema.ts`, `src/storage/sqlite-validation.ts`
- Modify: `src/storage/sqlite-store.ts`
- Create: `tests/encrypted-storage.test.mjs`

**Interfaces:**
- Consumes all Task 1 codec/private-file interfaces.
- Produces `SqliteStore(path: string, options?: { encryptionKey?: Uint8Array; readOnly?: boolean })`; default plaintext behavior remains unchanged. `:memory:` encrypted stores use no filesystem helper.
- Produces `verifyEncryptedDatabase(db: DatabaseSync, cipher: PayloadCipher): void` in `sqlite-validation.ts`, validating a read-only snapshot with no effects/writes. Reuse decoding/context builders instead of duplicating them: shared row encoding/decoding helpers may live in `src/storage/sqlite-codec.ts` if needed. File structure for that extraction is explicitly allowed.
- Produces schema functions `initializeStorage(db: DatabaseSync, encryptionKey?: Uint8Array): PayloadCipher | undefined` and `validateStorage(db: DatabaseSync, encryptionKey?: Uint8Array): PayloadCipher | undefined`, with no file side effects. Only initialize empty schema/version 0; validation never creates schema/metadata. Backups use `validateStorage` on their staged database.
- Metadata is `storage_protection(id INTEGER PRIMARY KEY CHECK(id=1), format INTEGER NOT NULL, database_id TEXT NOT NULL, verification TEXT NOT NULL)`. Require exactly one row, id/format 1, valid database UUID, and cipher-authenticated verification text `behalvo/storage/v1/verified` under context `['metadata','verification']`. It exists only in encrypted version 2.
- Keep v1 schema structurally unchanged. Validate v2 required tables/columns/constraints/triggers against the schema the initializer owns; optional `local_mode` may be absent, or must have its exact supported shape and at most the one valid ordinary/synthetic row. Fail before domain startup writes.

- [ ] **Step 1: Write failing encrypted-mode behavior tests.** A key-provided store currently writes plaintext; scan database and live WAL bytes for long unique synthetic markers before closing to catch that missing protection. Cover all protected fields, not just the artifact column.

```js
const store = new SqliteStore(dbPath, { encryptionKey: key });
store.createWorkspace('personal', 'synthetic-owner-canary');
const record = store.ingest('personal', {
  source: 'synthetic-private-mailbox-canary', externalId: 'private-delivery-canary',
  threadId: 'private-thread-canary', senderId: 'synthetic-owner-canary',
  senderRole: 'owner', text: 'synthetic-message-body-canary'
});
assert.equal(store.readArtifact('personal', record.event.data.artifactId), 'synthetic-message-body-canary');
for (const path of [dbPath, dbPath + '-wal']) {
  if (existsSync(path)) assert.equal(readFileSync(path).includes(Buffer.from('synthetic-message-body-canary')), false);
}
store.close();
assert.throws(() => new SqliteStore(dbPath));
assert.throws(() => new SqliteStore(dbPath, { encryptionKey: randomBytes(32) }));
```

Add real-store tests for restart, legacy rejection without modification, type/thread retrieval, inbox dedupe/collision, timer processing, summary sources, facts, historical state/rebuild, workspace denial, prepared-operation approval/execute/unknown barriers. Use in-memory synthetic handlers without the persistent sidecar. Assert literal expected outcomes as well as state equality.

- [ ] **Step 2: Run RED.** Build and run `tests/encrypted-storage.test.mjs`; record plaintext marker leaks and missing-key rejection failure before implementation.
- [ ] **Step 3: Implement storage integration.** Authenticate metadata/schema before connection pragmas that mutate file state or domain writes. Initialize v2 atomically. Encrypt before SQL insertion; decrypt before parse/reduction. Use per-field contexts binding actual row identity and immutable metadata. Hash source/external/fingerprint/summary thread with the cipher lookup API. Plaintext path preserves current semantics. Encrypted thread retrieval can scan/decrypt/filter one workspace journal.

```ts
// Illustrative binding; centralize shared bindings for writer/reader/validator.
const context = ['journal', 'event_json', record.workspaceId, record.id,
  record.seq, record.schemaVersion, record.recordedAt, record.causationId];
const eventJson = cipher ? cipher.seal(JSON.stringify(record.event), context) : JSON.stringify(record.event);
```

- [ ] **Step 4: Implement pure snapshot validation and corruption tests.** Run SQLite integrity checks; validate union of workspace IDs across journal/projections/artifacts/inbox/summaries. Require journals and projections to correspond exactly, sequential replay and deep state equality. Authenticate every artifact and summary, including unused ones. Check message/evidence references and summary source/thread matches. Recompute delivery tokens/fingerprints from original message artifacts or timer events; compare inbox `record_id`/workspace and `handled` with journal events. Check missing/extra inbox receipts as applicable to ingest/timer invariants. Tests remove a projection/artifact, change an inbox reference/handled flag, corrupt an unused artifact, alter schema/protection combinations and swap ciphertexts; all must fail with no data repair/mutation.

- [ ] **Step 5: Run focused GREEN, existing foundation/memory/effects/operations tests, `npm run check` once, and `git diff --check`.** Confirm legacy v1 behavior still passes.
- [ ] **Step 6: Self-review and commit.** Report interface/context choices for Task 3. Do not add backup or CLI entrypoints yet.

### Task 3: Usable key configuration and verified backup/restore commands

**Files:**
- Create: `src/storage/backup.ts`, `src/cli/storage-main.ts`, `tests/storage-backup.test.mjs`, `tests/storage-cli.test.mjs`, `docs/PRIVATE_STORAGE.md`
- Modify: `src/storage/sqlite-store.ts`, `src/cli/main.ts`, `src/cli/local-app.ts`, `src/index.ts`, `package.json`, `README.md`, `SECURITY.md`, `docs/ROADMAP.md`, `docs/local-mvp.md`
- Modify tests: `tests/cli-main.test.mjs`, `tests/local-app.test.mjs` as needed for new configuration behavior.

**Interfaces:**
- Consumes schema/cipher/validation/private-publication APIs from Tasks 1–2.
- Produces `SqliteStore.backup(destination: string): Promise<void>` for encrypted stores only. Store keeps ownership of its connection; caller must await backup before closing. `backupEncryptedStore(db: DatabaseSync, encryptionKey: Uint8Array, destination: string): Promise<void>` in backup module may be internal to implement that method. Keep only the minimum private key material required for validation; no public database/key accessor.
- Produces `LocalAgentOptions.encryptionKey?: Uint8Array`, `parseCliArgs(...).storageKeyPath?: string`, and strict storage CLI commands. `--storage-key-file` overrides `BEHALVO_STORAGE_KEY_FILE`; reject missing values and duplicate occurrences, never ignore a supplied key flag. Reject encrypted + persistent synthetic mode before database/sidecar creation.
- Add npm script `storage`: `npm run build && node dist/cli/storage-main.js`.
- CLI verbs are `keygen --out`, `backup --db --out --key-file`, and `restore --from --out --key-file`. No mode/`--help` prints usage and exits 0; unknown, missing or duplicate options exit 2; runtime failures exit 1 with fixed safe error text. No key/environment secret in process arguments or printed output: arguments contain paths only. Backup/restore source must exist and is opened read-only.

- [ ] **Step 1: Write failing backup/restore and CLI behavior tests.** Use real SQLite backup, a live WAL and synthetic domain data. Capture source state/journal/artifacts, back up, close, restore into a new path with a separately loaded key-file copy, and assert equality plus literal domain outcomes. Reopen after the staging directory has been removed.

```js
await store.backup(backupPath);
const snapshot = new SqliteStore(backupPath, { encryptionKey: recoveredKey, readOnly: true });
await snapshot.backup(restoredPath);
snapshot.close();
const restored = new SqliteStore(restoredPath, { encryptionKey: recoveredKey });
assert.deepEqual(restored.state('personal'), expectedState);
assert.deepEqual(restored.journal('personal'), expectedJournal);
assert.equal(restored.state('personal').actions[unknownId].status, 'unknown');
assert.equal(restored.state('personal').actions[runningId].status, 'running');
assert.equal(effectCalls, priorEffectCalls);
```

Test wrong key, corrupt ciphertext/relational metadata, plaintext-source refusal, output collisions, unsafe permissions/symlinks/stale sidecars, and no input creation on missing source. CLI subprocess tests prove no secret/error payload leakage and no inference/login/effects. Run an offline encrypted agent across restart to prove key-file wiring; verify absent configured key fails before data is created and synthetic-mode combination creates no sidecar.

- [ ] **Step 2: Run RED against absent APIs/scripts.** Record expected failures before implementation.
- [ ] **Step 3: Implement backup and CLI.** Use `node:sqlite.backup` into the private staged path, open staged snapshot with read-only `DatabaseSync`, call `validateStorage` + `verifyEncryptedDatabase`, close it, then allow publication only when committed contents reside in the standalone main file. Ensure all async paths close validation connections and preserve original/output data on failure. The source connection is never replayed into a writable projection.

```ts
await publishPrivateFile(destination, async stagedPath => {
  await sqliteBackup(sourceDb, stagedPath);
  const snapshot = new DatabaseSync(stagedPath, { readOnly: true });
  try {
    const cipher = validateStorage(snapshot, key);
    if (!cipher) throw new Error('Encrypted storage is required');
    verifyEncryptedDatabase(snapshot, cipher);
  } finally { snapshot.close(); }
}, { sqlite: true });
```

- [ ] **Step 4: Wire agent configuration and write operational documentation.** Explain supported commands, new-database-only behavior, separate key recovery, visible metadata, POSIX assumptions, linear encrypted-thread scan, backup exclusions and snapshot-time barriers. State default plaintext/synthetic-only status, unprotected Pi credential/settings/report paths, missing erasure/rotation/authentication, and no real-data readiness. Update implementation/status tables without marking M1.1/M1.2 complete. Add source links from the design where relevant; no unverified CI claim.
- [ ] **Step 5: Run focused GREEN, then full `npm run check`, three demos, scripted evaluation and `git diff --check`.** Report exact counts/skip and no live-model execution. CI on both supported Node versions is the controller's publication gate.
- [ ] **Step 6: Self-review and commit the complete task.** Return precise remaining limitations; no deployment or account setup.

## Final integration gate

Use independent Astra and Sol whole-branch reviews, consolidate real findings into
one fix dispatch, and re-review that diff. Publish the exact reviewed tree to a
feature branch/PR using the authorized GitHub connection, verify actual CI for
the final head on both Node versions, merge with expected-head protection, and
verify remote master and the local checkout match the reviewed tree.
