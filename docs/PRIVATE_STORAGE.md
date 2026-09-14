# Private storage operations

Behalvo can create a new SQLite database whose private payload columns use
authenticated application-layer encryption. This is an opt-in local control for
the ordinary agent. The default remains plaintext, and this feature is not yet a
claim that Behalvo is ready for personal, customer, or other sensitive data.

## Create and use a key

The storage key is a random 32-byte root key in a strict versioned file. On POSIX,
place it in an owner-controlled directory and create it exclusively:

```bash
mkdir -m 700 /private/path
npm run storage -- keygen --out /private/path/agent.behalvo-key
npm run agent -- --db /private/data/agent.db \
  --storage-key-file /private/path/agent.behalvo-key
```

Choose an unused database path for the first encrypted start. The backup example
below uses that same `/private/data/agent.db` path.

`BEHALVO_STORAGE_KEY_FILE=/private/path/agent.behalvo-key` is the environment
alternative. The command-line option takes precedence. A configured key path is
mandatory: a missing, empty, malformed, linked, or unsafe key file causes startup
to fail before the database is created. The key itself never belongs in a command
argument or terminal output; arguments contain paths only.

Encryption applies only when creating a new database. Existing plaintext version
1 databases cannot be opened with a key or converted in place. New encrypted
databases use storage version 2. Keep a separately protected recovery copy of the
exact key, outside the database and backup directories. Losing every key copy
makes the encrypted payloads unrecoverable. Key rotation and plaintext migration
need a later export and re-encryption design.

Persistent `--synthetic-operations` mode uses a separate plaintext provider
sidecar, so Behalvo rejects that mode when encrypted storage is configured before
creating either file. In-memory synthetic handlers remain a test facility.

## Back up and restore

Create a verified encrypted snapshot at a new path:

```bash
npm run storage -- backup \
  --db /private/data/agent.db \
  --out /private/backups/agent-2026-09-14.db \
  --key-file /private/path/agent.behalvo-key
```

Restore a snapshot to another new path, using a separately stored copy of the
same key:

```bash
npm run storage -- restore \
  --from /private/backups/agent-2026-09-14.db \
  --out /private/restore/agent.db \
  --key-file /recovery/path/agent.behalvo-key
```

Both commands open the source read-only, include committed WAL state through
Node's SQLite backup API, validate SQLite integrity and foreign keys, authenticate
every protected row, and verify journal/projection/inbox/artifact/summary
relationships before exclusive publication. Source and output cannot be the same
path. The input must already exist; the output and its `-wal`, `-shm`, and
`-journal` sidecars must all be absent. Existing output files and sidecars are
never replaced or deleted. Validation runs with no model, provider login, or
effect execution.

Restore preserves `running` and `unknown` action barriers recorded at snapshot
time. A backup can predate a later execution in the original database, and
separate restored copies do not fence one another. Reconcile restored provider
state and add explicit execution activation controls before real providers exist.

The snapshot contains only the encrypted SQLite workspace. It excludes the key,
Pi credentials (`data/pi-auth.json`), provider/model settings
(`<database>.settings.json`), evaluation reports, and synthetic provider
sidecars. Those paths remain outside this encryption boundary and need their own
backup and protection decisions.

## Security and operating limits

The feature is supported on POSIX only in this slice. It requires owner-controlled
immediate directories, mode `0700`; key/database/backup files use mode `0600`
(a key may be `0400` when loaded read-only). Regular-file, owner, link count, leaf
symlink, destination-sidecar, file sync, and directory sync checks are local
controls. Trusted ancestors, the process UID, root, and same-UID code remain in
the trust boundary. Windows needs a separate ACL design.

This is payload encryption, not whole-file encryption. Workspace IDs, record and
artifact IDs, references, sequence numbers, timestamps, row counts, ciphertext
lengths, handled flags, and local mode remain visible. Equality-scoped keyed
tokens remain visible for inbox and summary lookup. Actor IDs, journal events,
projections, artifact bodies, summary bodies, and summary source lists are
encrypted and authenticated. An administrator can still delete or roll back a
database, and a compromised process with the key can read or change data. There
is no rollback detection, remote authentication, secure erasure, key rotation,
credential vault, or memory protection.

Encrypted thread reads currently decrypt and scan one workspace journal, so cost
is linear in that workspace's journal size. Retention, erasure, authenticated
owner control, protected credentials, provider reconciliation, deployment review,
and independent security review remain required before real-data use. This work
does not complete roadmap milestones M1.1 or M1.2.

Implementation details and threat assumptions are in the approved
[private-storage design](superpowers/specs/2026-09-14-private-storage-design.md).
The main code boundaries are [key-file handling](../src/storage/key-file.ts),
[private publication](../src/storage/private-files.ts), [snapshot backup](../src/storage/backup.ts),
and [snapshot verification](../src/storage/sqlite-validation.ts).
