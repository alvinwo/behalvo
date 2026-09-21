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
