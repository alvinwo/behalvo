# Protected Pi credentials and saved model settings

Date: 2026-09-14. Design for the next bounded implementation increment on the
approved usable-version roadmap. This document does not authorize account access,
model calls, remote identity, deployment, or sensitive-data use.

## Goal and scope

Add explicit, opt-in authenticated encryption for Pi's credential file and the
ordinary agent's saved model settings. Preserve the existing plaintext formats
and default behavior. Coordinate protected credential refresh and settings
updates across store instances and processes. Integrate protection into the
ordinary agent and the already-explicit live-evaluation path without introducing
Pi, credential, or model-state key access into offline/scripted/list/help paths.

This closes one prerequisite of issue 04. It does not complete its retention,
erasure, rotation, or broader privacy requirements. The kernel, journal, prepared
operations, owner-control routes, SQLite format, and provider APIs do not change.
All implementation and acceptance material must be synthetic.

## Approaches and decision

| Approach | Advantages | Costs and limits |
| --- | --- | --- |
| Independent opt-in protection for both model-state documents | Small adapter-local change; existing SQLite and Pi boundaries remain; one explicit key configuration covers credentials and saved selections | Two file transactions, separate backup responsibility, and an administrator-managed key |
| Automatically protect model state whenever SQLite encryption is enabled | Fewer options for a new installation | Credentials may be shared across databases; would silently change an independent store's mode/key, affect offline startup, and confuse database backup coverage |
| OS keychain or external secret manager | Can provide stronger operational key custody | Requires an OS/deployment choice and new integration work; does not alone protect saved settings or solve concurrent refresh |

Choose the first approach. A separate option is appropriate because model state
has a different lifetime and ownership scope from a SQLite workspace. Protection
must be selected deliberately; it is not inferred from the database or its key.
Retain plaintext compatibility for existing supported local workflows while
stating clearly which stronger guarantees require the new option.

## Configuration and public adapter contracts

Add `--model-state-key-file PATH` and `BEHALVO_MODEL_STATE_KEY_FILE`. The explicit
flag wins; an explicitly configured empty value is an error. Accept the flag once
with a separate, nonempty value; reject duplicates and `--model-state-key-file=`
syntax. There is no legacy environment alias and no raw-key command argument.
Relative paths resolve against the command's working directory. Do not fall back
to `BEHALVO_STORAGE_KEY_FILE`, a different file, or generated key material.

| Input | Result |
| --- | --- |
| Neither new flag nor new environment value | Existing plaintext model-state behavior |
| Valid model-state key configuration in the ordinary online agent | Protect the selected auth file and `<database>.settings.json` |
| Valid model-state key configuration with explicit `--live` evaluation | Protect the selected auth file; evaluation does not use saved model settings |
| Explicit new flag with agent `--offline` | Argument error before any model-state/key or database I/O |
| Explicit new flag with evaluation `--scripted`, `--list`, or `--help` | Argument error; retain strict mode-inappropriate flag handling |
| New environment value in offline/scripted/list/help/no-argument-help paths | Ignore it completely, including an empty or missing-file value; no model-state key/auth/settings I/O |

Existing precedence remains unchanged: agent model selection uses `--model`,
`BEHALVO_MODEL`, `OPERATOR_MODEL`, then saved selection; auth path uses `--auth`,
`BEHALVO_PI_AUTH`, `OPERATOR_PI_AUTH`, then `data/pi-auth.json`. Evaluation keeps
its existing explicit model requirement and its existing empty-preferred-env
fallback behavior for model/auth paths. Do not opportunistically rewrite these
older parsers. A storage key alone continues to protect SQLite only. Model-state
protection alone does not protect SQLite or synthetic provider sidecars.

Use one exported adapter option type, `ModelStateProtectionOptions`, containing
only `encryptionKey?: Uint8Array`, and support these calls:

```ts
new PiCredentialFileStore(path, options?);
new ModelSettingsStore(path, options?);
createPiRuntimeLoader(authPath, importer?, options?);
new PiModelGateway(loader, { sanitizeErrors: true });
```

Preserve the loader's current second-position importer injection and all existing
one-argument constructors. Add the gateway's optional error-sanitization option;
existing callers retain their current behavior. The supported protected CLI and
evaluation wiring must enable it. Stores and the loader eagerly copy supplied
key bytes before returning, so callers can clear their original buffer without
breaking lazy initialization. Wrong-size/non-byte keys are configuration errors.
There is no promise to erase JavaScript strings or every runtime key copy.

Match the pinned Pi 0.85.1 credential contract: `read`, `list`, `modify`, and
`delete` accept optional `{ signal?: AbortSignal }`. Add `list` returning only
`{ providerId, type }` metadata; it never resolves auth or executes provider work.
`modify(provider, fn)` passes an isolated copy of the current credential to `fn`.
A returned credential replaces that provider; `undefined` leaves it unchanged
and returns the authoritative current credential. Deletion remains a separate
serialized operation. Returned values are isolated copies. Preserve JSON-safe
OAuth extension fields and provider-scoped API-key `env` values.

## Key ownership and file identity

Reuse `createStorageKeyFile`, `loadStorageKeyFile`, and their existing strict
version-1 random 32-byte key format. The existing command can generate a dedicated
model-state key; a second key format or key-generation command is unnecessary:

```sh
npm run storage -- keygen --out /private/keys/model-state.behalvo-key
npm run agent -- --db /private/data/new-agent.db \
  --auth /private/data/new-pi-auth.json \
  --model-state-key-file /private/keys/model-state.behalvo-key
```

The administrator owns the key and separately protects its recovery copies.
Recommend a dedicated key outside data and backup directories. Explicitly using
the same key file for SQLite and model state is allowed; it is never automatic
and does not create separate cryptographic ownership. No key is stored in either
document, settings, SQLite, logs, reports, or terminal output.

Before opening application state, check the complete reserved path set: auth and
its model-state lock; settings and its model-state lock; the database,
`<database>-wal`, `<database>-shm`, `<database>-journal`, and
`<database>.behalvo-lock`; and both configured key paths. When persistent synthetic
operations are selected, also reserve `<database>.synthetic.sqlite` and its
`-wal`, `-shm`, and `-journal` companions, matching `openSyntheticOperations`.
Refuse data-to-data, data-to-lock, lock-to-lock, and every key-to-data/lock
collision. Intentional equality between the two configured key paths is allowed.
Different textual spellings must not bypass these checks. Existing hard links
and leaf symlinks are rejected independently. Library byte-key APIs cannot know
where their caller obtained the key; path separation is a CLI responsibility.

Protected operations require POSIX and reuse the existing private-file rules:
an immediate directory owned by the effective UID with no group/other access;
regular, single-link, same-owner files; no leaf symlink following; handle-based
validation; and bounded reads through the validated descriptor. Newly created
directories use `0700`, new data/staging/lock files use `0600`. Never chmod an
existing unsafe directory or file into acceptance. Read-only existing data files
may be `0400` or `0600`; mutation requires `0600` and an owner-writable/searchable
private directory before invoking any callback. Key reads retain their existing
`0400`/`0600` rules. Protected Windows operations fail with fixed errors.

Canonicalize a validated data parent and leaf for locking and comparison. A
requested immediate symlink directory is rejected; trusted ancestor aliases may
resolve to one canonical directory. Record parent and opened-file device/inode
identities and recheck them across asynchronous mutation boundaries. These checks
detect unsafe or replaced paths; they are not a sandbox against the same UID or
root. Ancestors and in-process dependencies remain trusted.

Protected preflight loads the key before creating model-state directories. With
a valid key, it may create missing private parents, but does not materialize an
empty data file. A missing first file is an empty store. An existing empty,
malformed, plaintext, or unauthenticatable file is an error, never an empty store.
A missing data file with an existing transaction lock is unavailable. After a
store instance has observed or written a file, later disappearance in that
instance is an error. A fresh process cannot distinguish deletion from a never
created store; no persistent deletion detection is claimed.

## Encrypted format and purpose binding

Add a focused internal whole-document codec and protected JSON file transaction
helper under `src/storage/`. Keep credential/settings schema validation in their
own modules. Reuse `PayloadCipher` without changing its existing SQLite format,
HKDF labels, or semantics. Its authenticated context separates this new use from
every SQLite field; its unused lookup key does not become a new index.

The outer UTF-8 JSON object has exactly these fields:

```json
{
  "format": "behalvo-private-model-state",
  "version": 1,
  "purpose": "pi-credentials",
  "documentId": "<canonical lowercase UUID v4>",
  "payload": "<PayloadCipher version-1 envelope string>"
}
```

The two allowed purposes are `pi-credentials` and `model-settings`. The application
supplies the expected purpose; a file cannot select its own role. On first write,
generate `documentId` with `randomUUID()` and retain it on subsequent writes.
Instantiate `PayloadCipher(rootKey, documentId)` and seal/open the complete inner
document with this exact context:

```ts
['behalvo/private-model-state/v1', expectedPurpose, 1]
```

The cipher supplies AES-256-GCM, a fresh 12-byte random IV, a full 16-byte tag,
HKDF key derivation, strict base64/envelope validation, and authentication before
plaintext release. The document ID is bound by key derivation and AAD; the expected
purpose and document schema version are authenticated. Validate all outer fields,
UUID shape, exact supported version, and purpose before opening the inner value.
Reject extra fields and invalid UTF-8. Validate the decrypted inner schema before
returning or changing any state. No plaintext staging file is written.

The credential plaintext is the existing provider-to-credential JSON map. The
settings plaintext is the existing `{ version: 1, workspaces: {...} }` structure.
Encrypt the entire map, including provider/workspace identifiers. Use own-property
reads and safe writes for names such as `__proto__`, `constructor`, and `toString`.
Credentials remain keyed by provider within the selected auth file, shared by
every workspace/process configured to use it. Settings remain selected by the
explicit database path and exact workspace key. This does not introduce
workspace-isolated provider credentials or provider account authentication.

Do not put canonical paths or database paths into cryptographic AAD. A same-purpose
file can be copied or rolled back with the matching key; there is no independent
trusted document-ID registry. Purpose swaps and modified authenticated content
fail, but same-purpose whole-file substitution/rollback is not detected. File
presence, path, type/purpose, document ID, ciphertext length, and filesystem
metadata remain visible. No claim of authenticated freshness or whole-deployment
integrity follows from encryption.

Protected bounds are 2 MiB for the outer file and 1 MiB for serialized plaintext,
checked before oversized reading/encryption/parsing where possible. Credential
maps allow at most 256 providers and settings at most 1,024 workspaces. Provider,
workspace, and model identifier strings are nonempty, at most 512 UTF-16 code
units, and contain no C0/DEL controls. Retain required credential field/type
checks, finite OAuth expiry, and string-valued API-key environment entries. Extra
OAuth fields must be JSON-safe with maximum container nesting depth 32; reject
cycles, unsupported values, and non-finite numbers rather than silently dropping
or transforming them. Bounds are local implementation limits, not Pi provider
guarantees. Do not apply these new limits retroactively to the legacy plaintext
mode except safe own-property handling and the new metadata-only `list` method.

## Transactions and refresh uncertainty

Implement a small exclusive transaction lock for protected files at
`<canonical-data-path>.behalvo-model-state-lock`. Do not use
`acquireLocalProcessLock` directly: its same-process reference counting is a
process-ownership lease, not mutual exclusion for two asynchronous writes.
The new lock must exclude different store instances in one process as well as
different processes. Serialize the entire document, not individual providers,
because each commit replaces one complete map.

Acquire by exclusive/no-follow creation; validate the owned descriptor and exact
lock identity. Existing safe locks may be polled at 10 ms intervals for at most
5,000 ms using a monotonic elapsed clock; unsafe locks fail immediately. Polling
must be asynchronous and honor cancellation. Lock content contains only bounded
version/PID/random-instance metadata, never data values or paths. PID or age is
not permission to steal a lock. A crashed process leaves an unavailable lock
requiring exclusive operator inspection; never remove it automatically.

Under the lock: revalidate paths and writable data mode; load and authenticate the
latest complete document; call the credential modifier once if applicable;
validate and serialize the result; encrypt; stage privately; fsync; then publish.
Read/list can consume an authenticated atomic snapshot without a write lock;
Pi refresh still rechecks the authoritative credential inside `modify`.

For an absent destination use exclusive publication, reusing
`publishPrivateFile` where its contract fits. For replacement, add only the
needed identity-checked private staging/rename operation: require the target to
remain the regular private file originally read and the lock/parent to remain
owned; never follow or overwrite a substituted unsafe leaf. Stage on the same
filesystem, fsync the completed ciphertext, atomically rename, and fsync the
parent. The existing exclusive publisher must not be weakened globally.
Successful updates preserve every unrelated provider/workspace entry. Cleanup
removes only the operation's own verified lock and staging identity; it must not
unlink another operation's replacement lock or file.

Honor cancellation before entering the modifier. Once the callback starts, do
not race it against cancellation/timeout and release the lock early: wait for
settlement and persist a valid returned credential even if the caller's signal
has subsequently aborted. Pi owns cancellation of its callback/network work.
Login performs its provider exchange before storage mutation; refresh may perform
network I/O inside the callback. The five-second bound covers lock acquisition,
not callback duration. A callback that never settles continues to hold the lock;
no early release, competing refresh, or automatic retry is allowed.

A callback rejection propagates to the trusted Pi caller as required by its
contract, preserves prior bytes, and releases owned resources. Storage failures
use fixed errors. If token rotation occurred remotely but callback/publication
failed, persisted credentials may be stale. If rename succeeded but fsync or
cleanup then failed, an update may already be visible. Return failure without
claiming that the provider or file is unchanged; do not retry the callback,
restore an old token, or attempt an automatic rollback. This is atomic local
publication, not a transaction with the model provider or cancellation proof.

## CLI integration and error surfaces

Ordinary online startup resolves configuration, loads the model-state key, checks
path separation, and preflights both protected documents before opening the
application database or loading Pi. Preflight validates complete contents even
when `--model` overrides saved selection. It does not select a model, log in,
refresh credentials, or call a provider. A valid missing store is permitted.
The ordinary agent and live evaluation are potential writers, so their protected
preflight also requires mutable private modes (`0600` for existing documents).
The `0400` data-file allowance is for library read/list operations; a CLI must
not defer discovering an unwritable credential destination until after refresh.
Retain one configured `ModelSettingsStore` instance for startup and `/model`
persistence; do not create a later plaintext instance accidentally. Pass the
same key options to credential preflight and the Pi runtime loader, and enable
the gateway's fixed-error policy. Clear caller-owned key buffers in `finally`
blocks after their consumers have captured owned copies.

An unavailable saved catalog entry retains existing safe recovery guidance.
An invalid protected file/key is a protection error; do not turn it into
"remove the settings file" or "select another model" guidance. Startup cannot
silently continue with unsaved/plaintext state after protection preflight fails.
For an in-session `/model` persistence failure, preserve the existing explicit
warning that selection is active only for this session; never claim it was saved.

Add `modelStateKeyPath?: string` to the live evaluation command. Extend its
`createLiveGateway` dependency to receive `(authPath, protectionOptions)`; existing
one-argument test factories remain compatible. Live startup loads/preflights with
the same options it passes to `createPiRuntimeLoader(authPath, undefined, options)`
and the sanitized gateway. Invalid protection fails before gateway construction,
catalog enumeration, report preparation, or inference. No new settings lookup,
login, key generation, or implicit live mode is added. Reports retain their
current private plaintext format and sanitized telemetry boundary.

Absence of a stored provider entry, including a never-created store, still allows
Pi's existing ambient credential resolution. An unreadable/malformed/wrong-key
configured file must throw rather than returning `undefined`, so it cannot cause
ambient fallback. This feature does not inventory or protect ambient environment,
cloud-profile, or other provider-managed credential sources.

New protection failures use fixed no-cause messages with no path, provider ID,
plaintext, ciphertext, key, or raw exception interpolation:

| Failure | Message |
| --- | --- |
| Invalid options or path collision | `Invalid private model state configuration.` |
| Configured key unavailable or invalid | `Private model state key is unavailable.` |
| Read, schema, mode, permissions, or authentication failure | `Private model state is unavailable.` |
| Lock unavailable/timeout | `Private model state is busy.` |
| Cancellation before mutation starts | `Private model state operation cancelled.` |
| Serialization or local publication failure | `Private model state update failed.` |

Protected gateway failures have these exact no-cause messages: initialization
uses `Unable to load bundled Pi model support (@earendil-works/pi-ai). Use Node
>=22.19 and run npm ci.` as one line; login uses `Pi login failed.`; catalog uses
`Pi model catalog is unavailable.`; completion uses `Pi provider request failed.`.
Pi's wrapped exceptions and returned `errorMessage` must not bypass this boundary.
Callback exceptions remain available only to trusted library callers; supported
protected CLI/eval paths sanitize them. Existing provider-owned login
URL/code/prompt rendering is unchanged and is not a general redaction system.
No secret is added to journal, model context, error logs, or reports by this
increment.

## Compatibility, operations, and remaining gates

Existing plaintext auth/settings and their defaults continue to work without the
new option, including supported legacy platform behavior. Existing encrypted
documents fail under plaintext mode, and plaintext documents fail under protected
mode. Enabling a key never imports, rewrites, deletes, renames, or partially
converts an existing plaintext file. Use unused auth/settings destinations for
new setup; because settings remain derived from the database path, the simplest
fully new setup uses a new database path. Existing installations require a later
explicit migration workflow or a deliberate operator-managed setup that preserves
old files. Do not present deletion as encrypted-state recovery.

SQLite backup/restore continues to exclude model-state files and their keys.
Document separate protected copies of the exact key and complete encrypted
documents with all model-state writers stopped. These are operator file copies,
not a newly verified or coordinated deployment backup command. A credential
backup can contain revoked/rotated tokens; restoring it does not recover a
provider session and may require explicit provider reauthentication. Losing all
key copies makes protected state unrecoverable. Logout/removal affects the
current map only and is not secure erasure of earlier files, backups, memory,
filesystem snapshots, or provider credentials. No rotation, migration, retention,
erasure, rollback detection, independent-writer fencing, or OS keychain is added.

Update README, SECURITY, ROADMAP, the private-storage and local-MVP guides, and
the evaluation guide to distinguish delivered opt-in model-state protection from
remaining production gates. Extend ignore rules for the known settings/lock/
staging artifacts, without claiming arbitrary custom auth paths are automatically
safe to commit. Runtime credentials stay outside version control; committed
fixtures contain synthetic material only.
Live-model/manual acceptance, authenticated mobile owner control, protected
evaluation reports, real-provider auth/readback/conditional-write design,
retention/erasure, supervised operation, and deployment security review remain
open. No real account is opened or exercised while implementing this slice.

## Acceptance and implementation review

Behavior tests precede implementation. Required evidence:

- Synthetic credential and settings round trips, restart with a copied key,
  fresh ciphertext per write, and preserved Pi extension fields; secret/provider/
  workspace/model markers absent from raw protected data and leftover staging
  bytes. This is a byte check, not an erasure claim.
- Strict malformed/unsupported envelope, UTF-8, schema, size/cardinality/depth,
  wrong-key, modified IV/tag/data, document-ID alteration, and cross-purpose
  rejection. Same-purpose copied files can open with the correct key, matching
  the documented limitation. Plaintext/protected mode mismatches preserve bytes.
- Missing first file/parent, missing-after-observation, leftover-lock, private
  directory, ownership, read-only/mutation mode, symlink, hard-link, alias,
  data/key collision, and protected Windows rejection cases; no chmod repair or
  key generation on failure. Use only synthetic temporary paths.
- Real child processes preserve unrelated credential and workspace updates.
  Coordinated synthetic refresh proves a second callback sees the first committed
  result; modify/delete share the lock; prototype-named provider/workspace keys
  behave independently; undefined modifiers do not write or delete.
- Lock timeout/pre-callback abort prevents callback execution; callback rejection
  releases its own resources; abort during a callback does not release early or
  discard a valid rotated credential; unclean exit leaves a non-stolen lock.
  A replaced lock/target/parent is not deleted or published over. Publication
  failure does not invoke the modifier twice or promise rollback after rename.
- Old constructor/importer signatures and plaintext tests still pass. Protected
  loader capture survives clearing the caller's key. Synthetic injected Pi login
  and refresh reach the configured store; no tests import real credentials or
  contact model/provider endpoints.
- Agent protected startup preflights both stores before database/Pi activity,
  including explicit model override; restart and `/model` use the same protected
  settings; in-session save failures retain the existing truthful warning.
  Explicit offline flag rejection and ambient offline isolation are tested.
- Evaluation passes identical options to preflight/factory; invalid key/file
  creates no report and makes zero gateway/model calls. Scripted/list/help ignore
  ambient key configuration; explicit mode-inappropriate flags fail. Existing
  plaintext ambient resolution remains intact. Secret-bearing synthetic callback,
  loader, provider, and file errors do not appear in protected terminal/report
  surfaces.

Run the focused tests, `npm run check`, `npm run demo`, `npm run mvp:demo`,
`npm run operations:demo`, `npm run owner-control:demo`, scripted evaluation, and
`git diff --check`. Record actual results, then run the established independent
security/code reviews and CI on Node 22.19.0 and 24.x before the authorized merge.
Scripted/injected-model evidence must remain labeled non-live. The implementation
plan and final review must resolve concrete findings; this design has no deferred
implementation decisions disguised as completed acceptance.

## Source basis and self-review

This design uses the approved architecture/private-storage specifications and
the current `pi-auth-store.ts`, `pi-gateway.ts`, `model-settings.ts`, agent/evaluation
entry points, private-file/key/cipher/lock helpers, and their behavior tests.
Pi callback semantics were checked against installed, pinned 0.85.1
`dist/auth/types.d.ts`, `dist/auth/resolve.js`, and `dist/models.js`; no new provider
API or dependency behavior is assumed. Reusing maintained crypto primitives does
not certify this implementation.

Self-review completed: configuration and mode boundaries are explicit; callback
uncertainty is separated from local publication; canonical filesystem identity
is separated from cryptographic freshness; credential sharing and backup limits
are stated; the work remains one protected adapter/file-storage increment.
