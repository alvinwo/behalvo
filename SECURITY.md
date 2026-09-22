# Security status

**Offline prototype. Not ready for sensitive accounts, customer data or public hosting.**

The offline M0 kernel uses fake providers and has no remote server. The local MVP
adds a pinned, replaceable Pi adapter that can contact model providers and stores credentials
separately in `data/pi-auth.json` by default. The owner has reported a successful Codex login/chat; the bounded operation loop
is tested with scripted models and synthetic providers. This credential store is
plaintext by default. On POSIX, `--model-state-key-file` can opt the selected Pi
auth file and the database-derived model-settings file into authenticated
encryption. This local control is not a production credential-vault or readiness
claim.

SQLite payload protection and model-state protection are independent opt-ins.
Neither key is inferred from the other, though an operator may explicitly select
the same valid key file for both. Pi credentials are shared per provider in the
selected auth file; they are not isolated by workspace. Saved provider/model IDs
are scoped by database and workspace. Ambient provider credentials, provider SDK
caches, process environment, evaluation reports, terminal input/output, swap,
crash dumps, and process memory remain outside model-state protection.

Protected model-state files use fixed, non-secret error messages and fail closed
on wrong keys, plaintext/ciphertext mode mismatch, unsafe modes, corruption, or
path collisions. The current process, current UID, root, same-UID code, and
trusted path ancestors remain inside the trust boundary. A process that can read
the key can decrypt the files. This feature adds no rollback detection, key
rotation, plaintext migration, retention, erasure, remote identity, or protection
against a compromised process.

The loopback owner-control console uses a short-lived bootstrap file and in-memory bearer session for local synthetic review. The standalone legacy console exposes no execute route. The opt-in foreground service adapter adds bounded durable chat, reminder, explicit synthetic execution and readback routes while preserving the same local session boundary; approval still does not execute an operation. Neither mode exposes model login, credential editing or connection binding. This is not remote authentication, mobile identity, OS-supervised availability or production privacy.

Private browser connections now have a callback-only `SecretProvider` contract,
a deterministic synthetic provider, and a macOS native-helper transport contract.
The transport sends secret input only through a bounded stdin frame and accepts
secret output only through a dedicated extra file descriptor; argv, environment,
stdout, errors, logs, control responses, and browser messages carry no values.
The helper executable is pinned by an operator-supplied identity and rechecked
before and after each operation. Cancellation is rechecked after the final
identity lookup and before callback entry. Received and temporary secret buffers
are cleared on validation, identity, timeout, cancellation, and callback failure
paths where JavaScript exposes the owned bytes. Metadata lists are bounded and
must match the exact requested service, connection, account, purpose, and opaque
reference. Early helper exit and stdin failure are converted to fixed public
errors rather than uncaught stream errors. If either native output stream fails,
overflows, or is cancelled, both completed aggregate buffers and all collected
chunks are cleared even when the other stream completed first. CI uses only
synthetic/fake helpers and does not access Keychain. No signed Keychain helper
binary, live credential setup, portal login integration, secure-erasure claim,
or live acceptance is shipped yet.

Private connection metadata contains opaque secret references, not values. A
dedicated profile must resolve without symlinks under an owner-only parent, stay
outside Git and recognized cloud-sync/support/backup paths, and acquire a private
exclusive sibling custody directory. Custody records the canonical profile's
device/inode, process ID, registration digest, and random identity. A second
process and profiles with any Chrome Singleton directory entry—including a
dangling symlink—are rejected. Recovery is explicit, requires the exact custody
identity and confirmation that the recorded process has exited, and uses a
private atomically published claim containing claimant/process/source identities.
Hard-link election generations admit one claimant for an exact stale source;
dead claimants can be explicitly superseded while live claimants fail closed.
Directory/state inode and source-digest checks are repeated immediately before
atomically replacing the owner state. Recovery never creates a gap in the
exclusive custody directory or recursively deletes profile contents. Live-mode
registration also requires an explicit full-disk-encryption acknowledgment.

The foreground local service binds disconnect to the exact durable connection
generation: it revokes the journaled connection, shuts matching browser sessions,
revokes matching native secret brokers, and durably terminalizes matching grants,
monitors, and jobs before selected secret deletion can complete. Missing authority
bindings fail closed. Cleanup progress is logically append-only and phase-specific;
each complete history is flushed to a private temporary file, atomically replaced,
and directory-synced before its in-memory phase advances. The completion receipt is
also privately staged and atomically published. An identical owner request can
therefore resume after partial writes, flush failures, release failures, or process
restart without restoring authority or blindly replaying a confirmed deletion.
Exact receipt/custody evidence reconciles an orphan checkpoint stage, a published
receipt hard link, a removed owner state, or a removed-but-not-directory-synced
custody directory. Only bounded, private, identity-matching staging/claim artifacts
are removed; unknown artifacts fail closed. Interrupted checkpoint writes use an
exact custody-bound filename, independent of their payload. Zero-byte or truncated
stages require the private directory, a single-link owner-only file, and exact
canonical ownership; any present header bytes must agree. Recovery-owned stages
also require their published claim's exact source inode/digest bindings. Only the
elected replacement of a dead owner removes those stages, before publishing its
replacement, without removing the election chain. Legacy random checkpoint stages
require a complete matching header; ambiguous headerless legacy files remain
fail-closed. An incomplete fixed receipt stage is discarded only by the exclusive
completed canonical owner and only when its bytes prefix the exact expected
receipt. Neither stage supplies cleanup progress. Success requires the exact single-link
receipt and a directory-synced custody release. The browser profile itself is never
recursively removed; the local UI leaves every clearly labelled destructive choice
unchecked and presents profile removal as a separate explicit follow-up.

Recognized exclusions include common Dropbox, OneDrive, Google Drive, iCloud
Drive/CloudDocs/Mobile Documents, CloudStorage, and Box/Box Sync directory forms.
This name-based check cannot prove that an arbitrary configured synchronization,
backup, export, same-UID process, or root process cannot access the profile;
operators must keep the chosen profile out of all such configured roots.

The China visa adapter is a disabled discovery contract, not a live integration.
Repository defaults register no live adapter or visa native host, accept no portal
credential, and perform no network or browser installation. Its executable tests
use only the local synthetic scheduling portal. The fixed policy permits at most
one new complete-group Beijing appointment in the inclusive 2026-12-15 through
2027-01-31 `Asia/Shanghai` window; exact page contracts, complete pagination,
identity/roster/terms bindings, a durable reserved action, lifecycle fences, and
authoritative exact readback all fail closed. Ambiguous submission is retained as
unknown and verification-only. Synthetic runtime execution consumes the exact
durable reservation and service claim, journals encrypted intent evidence before
the browser gesture, rechecks the current durable grant, connection, installation,
action, attempt, service, and browser bindings around every continuation, and
converts interrupted or post-submit uncertainty to a non-retryable
verification-only state. Exact compiled-page attributes supply the review and
booking evidence; missing or contradictory safety fields fail closed. Execute and
readback adapter calls are raced against the trusted runtime deadline so a
non-cooperative transport cannot retain the worker; late settlement is consumed
and cannot continue to a browser gesture or journal write. Discovery fixtures
are authenticated by local secret key material kept outside the artifact and bind
the owner, installation, session, origin, terms, roster, polling limits, and expiry. A
sanitized supervised-discovery fixture still does not register live authority:
current terms, reviewed origin and roster,
bounded polling, a private connection, a separate active grant, owner-laptop
acceptance, and independent review remain external gates.

The owner ID checks assume a trusted local caller. They are not a login system,
signature check or authorization token. External-audience context is denied.

SQLite remains plaintext by default. New databases can opt into application-layer
AES-256-GCM payload encryption with a separate random key file. Protected journal,
projection, artifact, and summary payloads are authenticated, while identifiers,
references, sequence numbers, timestamps, row counts, lengths, handled flags,
local mode, and equality-scoped lookup tokens remain visible. This is not
whole-file encryption, rollback detection, remote authentication, secure erasure,
or protection from a compromised process that can access the key. Third-party
in-process code is trusted code, regardless of the TypeScript interface. See
[docs/PRIVATE_STORAGE.md](docs/PRIVATE_STORAGE.md) for exact file and recovery
procedures.

All implemented message effects require a current owner approval. A fake provider
is the only shipped driver. Approval binds command contents, work revision and
expiry; model output cannot turn itself into approval through the supported API.
Unknown execution outcomes are quarantined rather than automatically retried.

General prepared operations use explicit workspace-scoped connection metadata and
trusted versioned handlers. A connection's owner ID, provider, subject and label
are local bindings, not remote authentication or credentials. Handler code must
enforce its provider identity and resource scope on every callback. The shipped
contact-update and subscription-cancellation handlers are synthetic and contact no
real account.

The terminal enables synthetic handlers only with `--synthetic-operations`, in a
separately mode-bound database. Provider truth persists in an independent,
workspace-scoped sidecar; missing/corrupt prior state is not silently reseeded.
The structured loop exposes only catalog, prepare, inspect, execute and verify.
Action tools are restricted to focused work. Approval requires the exact command
to have been displayed by `/actions` in the current terminal; `/approve` grants a
ten-minute approval and never resumes inference. No tool can approve, change
account bindings, provide credentials, attest outcomes, invoke a shell or browser,
or create a background worker.

A run has eight model completion attempts, a 120-second deadline, and bounded
serialized requests/responses. Trusted execution guards check elapsed time and
cancellation across provider preflight and immediately before dispatch. Once a
start record exists, an unavailable outcome at the deadline is settled as unknown;
late fulfillment/rejection cannot mutate the journal after settlement or shutdown.
Underlying transports may continue; these controls do not prove nonexecution or
bound provider spend. Provider/handler exception text is excluded from durable
application stop replies. Startup preserves running barriers and never assumes
exclusive maintenance ownership.

Trusted readback can show that a desired resource state is present, but it does not
prove which action caused that state, cover every remote account, or complete a
WorkItem. Without provider-side conditional writes, an external actor can race
after the local preflight. Real handlers therefore require protected credentials,
provider-specific authentication, conditional-write and readback design, rate
limits, and independent review.

Before real use: authenticated owner control, webhook signature verification,
replay protection, production credential custody, appropriate retention
and erasure, scoped retrieval, provider readback, rate/budget caps, deployment backups,
production loop monitoring and independent security review are required.

Do not put real messages, tokens, OTPs, financial data, addresses or customer
records in public issues. A private vulnerability reporting route must be
configured on the GitHub repository before broader public distribution.
