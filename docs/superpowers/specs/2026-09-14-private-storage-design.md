# Encrypted workspace storage — M1.2 foundation

Date: 2026-09-14. Scope: an implementable dependency of the approved usable-version
roadmap. This does not finish M1.1 live acceptance or M1.2 owner control.

## Goal and delivery boundary

Provide an opt-in encrypted SQLite store for new databases, an explicit private
key-file configuration, and verified encrypted backup/restore. Preserve journal
transactions, deterministic replay, scoped retrieval, and uncertain-action
barriers. No HTTP service, model login, real account connection, deployment,
credential vault, erasure, or claim of readiness for personal data is included.
Continue using synthetic data until the remaining roadmap security gates pass.

The owner has authorized continuing the roadmap, implementation, two-model
review, fixes, PR publication, CI verification and merge. This slice advances
unblocked privacy engineering while live-model authorization remains absent; it
does not substitute for live acceptance or widen access.

## Approaches considered

1. Application-layer authenticated payload encryption using Node's maintained
   crypto implementation. Keeps the current SQLite transactions and pinned
   dependency set; visible metadata and key administration must be explicit.
2. SQLCipher/native driver replacement. Can cover more database metadata, but
   changes the driver, builds and supported runtime surface before an actual
   hosted deployment is selected. Defer that choice to deployment evaluation.
3. Encrypt only message artifacts. Insufficient: facts, action arguments and
   projections also contain sensitive content. Reject this approach.

Choose option 1 for this foundation. It is payload encryption, not full-disk
encryption or protection against a compromised running process.

## Format, cryptography and trust

- Node.js **22.19.0+**, TypeScript modular monolith, no new dependencies.
- Use `node:crypto` AES-256-GCM, fresh random 12-byte IV per encryption, full
  16-byte authentication tag, strict versioned envelopes, and a random 32-byte
  root key. No passwords, user-selected keys or custom cipher implementation.
- Derive separate encryption and lookup keys with HKDF-SHA-256, using a random
  database UUID as salt and distinct versioned purpose labels. Bind every
  ciphertext to its database, table/field, workspace, row identity and relevant
  immutable metadata with unambiguous JSON-array additional authenticated data.
- Do not release decrypted plaintext before GCM authentication finishes. Reject
  malformed envelopes, unsupported versions, wrong lengths and failed tags with
  fixed errors that contain no ciphertext, plaintext, paths or key material.
- Use HMAC-SHA-256 lookup tokens, domain-separated by purpose and workspace, for
  inbox source/external delivery keys, delivery fingerprints and summary thread
  lookup. Never use unkeyed hashes of low-entropy private content in encrypted
  mode. These tokens reveal equality within their declared scope.
- Workspace identifiers, record/artifact/summary IDs, references, sequence
  numbers, timestamps, row counts, lengths, handled flags and local mode remain
  visible metadata. Workspace IDs must be opaque application identifiers, not
  emails or account names. Actor identity is encrypted. This is application
  workspace isolation with AAD swap resistance, not per-workspace key ownership.
- An administrator can delete rows, roll back a whole database, or compromise
  the process/key. Encryption does not provide audit-log tamper proofing,
  rollback detection, authentication, or memory protection. Trusted ancestors,
  the process UID and root remain filesystem trust assumptions.

## Store integration and compatibility

`new SqliteStore(path, { encryptionKey?: Uint8Array, readOnly?: boolean })` keeps
the default plaintext reference mode. Existing plaintext databases remain at
SQLite `user_version=1`. New encrypted databases use `user_version=2`, distinct
from domain event/projection schema version 1. Old binaries reject version 2.

Version 2 requires exactly one validated storage-protection metadata record:
format version, database UUID and an authenticated fixed verification payload.
Missing/wrong keys, missing/malformed protection metadata and unsupported storage
versions fail before domain reads/writes. Never fall back to plaintext decoding.
Validate required v2 tables, columns, uniqueness constraints and journal
append-only triggers before application writes; also validate the optional
`local_mode` table and its allowed row shape. Reject protection metadata attached
to a version-1 database. Schema validation is independent of key verification.
Fresh version-0 databases may be initialized only if they have no user schema.
Initialization of schema and protection metadata is one transaction. Opening
version 1 with an encryption key fails; no implicit in-place migration, partial
conversion, key rotation or plaintext cleanup is claimed.

Encrypt all journal event JSON and actor IDs, projection JSON, artifact bodies,
summary bodies and source-reference lists before passing them to SQLite. Protect
inbox keys/fingerprints and summary thread lookup as above. Journal references
retain their normal semantics. In encrypted mode, thread retrieval/counting may
scan and decrypt the workspace journal and filter by exact thread/type; document
the performance limit rather than introducing an unauthenticated new index.
Plaintext mode may retain its existing indexed JSON queries.

All reads, historical state, rebuild, ingestion dedupe/collision checks, timers,
facts, summaries and prepared operations must preserve behavior. Encryption
happens inside the current commit boundary; failed authentication or encryption
must not commit a partial domain mutation. SQLite WAL and backup pages receive
ciphertext for protected columns, not plaintext copies of those columns.

`openLocalAgent` accepts the key and forwards it to the store. The CLI adds
`--storage-key-file` with `BEHALVO_STORAGE_KEY_FILE` fallback (path only). Missing
configured files are fatal, never a signal to generate a new key. Reject the
combination with persistent synthetic operations before opening files, because
that provider currently has its own plaintext sidecar. In-memory synthetic
operation handlers remain available in tests of encrypted storage.

## Private key and file handling

The trusted administrator owns one database root key. The library accepts bytes;
normal CLI setup loads a dedicated file. `storage keygen --out <path>` creates a
new key file exclusively and prints only a fixed success message. It never
overwrites existing files or prints a key. Store the file outside data/backup
directories and eventually mount it from the deployment's secret manager.

The key file is a strict versioned JSON document with one canonical base64
32-byte key. Key creation/loading and encrypted database/backup publication are
supported on POSIX only in this slice. Require an owner-controlled immediate
directory with no group/other access, and a regular single-link file owned by
the effective UID with mode 0600 (0400 is also acceptable for read-only key
loads). Reject symlink leaf paths and unsafe existing files; use exclusive
creation and handle-based validation (`O_NOFOLLOW`, `fstat`) where applicable.
Directory creation may create missing directories with mode 0700 but must not
silently chmod existing directories. Trusted ancestor directories and protection
from the same UID/root are prerequisites, not guarantees of these checks.

Use mode 0600 database/backup files, private 0700 staging directories, file fsync,
and directory fsync for publication. Outputs are published without replacement
using an exclusive operation; failed writes clean up only their own staging
files. Key files and database backups are ignored by git. POSIX permission checks
are a local control, not a hosted credential vault. Windows support requires an
explicit ACL design and is rejected by these new file helpers for now.
Reject pre-existing SQLite sidecars (`-wal`, `-shm`, `-journal`) for an absent
destination main file without deleting them. Validate the regular-file ownership,
permissions and link safety of sidecars when opening an encrypted database.

## Backup, restore and key recovery

`SqliteStore.backup(destination): Promise<void>` is supported for encrypted
stores only. Use Node's SQLite backup API into private staging, so committed WAL
pages are included. Validate the staged SQLite integrity, decrypt all protected
rows, and check that the journal deterministically reconstructs each current
projection before publishing. Validation must include otherwise-unreferenced
artifacts/summaries and reject authentication failures. No model or effect runs
during validation, backup or restore. Preserve running/unknown action states.
Validate the union of workspaces in all domain tables, require exactly one
projection per workspace journal, and reject orphan domain rows. Check inbox
references against same-workspace message/timer events; recompute lookup tokens
and fingerprints from authenticated events/artifacts and reconcile handled flags
against `inbox.handled` events. Check message/evidence artifacts and summary
source references within their workspace. Reject inconsistency without repair.
Close staged validation connections before publication and ensure the complete
snapshot is in the standalone main file, never only a staging WAL. Fsync that
main file before publication and the destination directory afterward. Refuse
pre-existing destination sidecars; cleanup must not remove unrelated files.

`storage backup --db <source> --out <destination> --key-file <key>` opens the
existing source read-only. `storage restore --from <backup> --out <new-db>
--key-file <key>` uses the same verified copying path, also read-only at source.
Both require encrypted version 2, existing input and absent output; neither
overwrites a live database nor recovers running effects. Commands have fixed
error output without raw exception text. The original backup is unchanged.

This backup contains the encrypted SQLite workspace only. It excludes the key,
Pi credentials, model settings, evaluation reports and synthetic sidecars. It is
not a whole deployment backup. Keep a separately protected copy of the exact key
and demonstrate recovery with it; losing all key copies makes the data
unrecoverable. Copying the database alone never recovers its key. Rotation and
legacy migration need a later export/re-encryption design. Retention and erasure
remain required before real-data use; no secure deletion is claimed.
Restore preserves barriers at snapshot time only: a backup can predate a later
execution in the original database, and separate restored copies are not fenced.
Before real providers are enabled, restored copies need explicit reconciliation
and execution activation controls. This slice does not provide rollback detection.

## Acceptance and review

Tests must demonstrate:

- Randomized round trips, strict envelope validation, wrong-key/modified-tag
  rejection, and database/workspace/row/field AAD swap rejection.
- Key files: exclusive generation, no secret output, permissions, symlink and
  hard-link rejection, malformed key rejection, and no key regeneration.
- New encrypted initialization/restart and fail-closed mode mismatches; unchanged
  plaintext compatibility; no partial mutation after decryption errors.
- Synthetic markers for message text, fact values, action arguments, owner IDs,
  summaries and dedupe source IDs absent from database/WAL/backup bytes.
- Correct dedupe, collision rejection, thread retrieval, summaries, cross-workspace
  denial, historical reads, replay and approved synthetic-operation behavior.
- Backup with uncheckpointed commits, restore into an absent destination, exact
  state/history/artifact equality, separate key recovery, and rejection of a wrong
  key, corrupted payload, unsafe destination or attempted overwrite.
- Reject inconsistent schemas, missing projections/artifacts, altered inbox
  references/handled flags and stale destination sidecars without modification.
- Running/unknown actions preserved with zero effect/model invocations on restore.

Run `npm run check`, the existing demos, scripted evaluation, `git diff --check`,
and CI on Node 22.19.0 and 24.x. Use two independent model reviewers for the final
branch, fix real findings and re-review their fixes before publication/merge.
Update README, SECURITY and ROADMAP with delivered capability and remaining gates.

## Primary references checked 2026-09-14

- [Node 22.19 crypto](https://nodejs.org/download/release/v22.19.0/docs/api/crypto.html)
- [Node 22.19 SQLite backup API](https://nodejs.org/download/release/v22.19.0/docs/api/sqlite.html#sqlitebackupsourceDb-destination-options)
- [OWASP cryptographic storage guidance](https://cheatsheetseries.owasp.org/cheatsheets/Cryptographic_Storage_Cheat_Sheet.html)

These inform the chosen primitives and threat boundaries; they do not certify
this implementation or replace an independent deployment security review.
