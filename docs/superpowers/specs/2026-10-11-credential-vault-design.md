# Local credential vault design

Date: 2026-10-11. Status: proposed for delegated architecture review.

## Intent and scope

The owner asks what Behalvo can learn from OpenClaw and Hermes password/vault
management and requests implementation. The useful outcome is a usable local
vault, hidden capture in the existing terminal, and a browser login path where
the model chooses a task and sees the result without receiving credentials.
The owner previously delegated design approval and final code review to specialist
agents and authorized integration after their comments are addressed.

This slice adds credential custody and proves the full flow against a synthetic
login website. Arbitrary live browsing, the H1B portal, external password-manager
integrations, TOTP, payment data and background login are separate capabilities.
Tests and acceptance use synthetic accounts exclusively. No production-readiness
claim follows from local encryption or synthetic browser acceptance.

## Research and choices

Official sources checked 2026-10-11:

- [OpenClaw secrets tool](https://docs.openclaw.ai/tools/secrets): trusted hidden
  entry, metadata-only references, owner-visible destinations, and cancellation
  tied to the requesting run. We adopt the separation of model requests from
  secret capture, not a model API that accepts passwords.
- [OpenClaw runtime model](https://docs.openclaw.ai/gateway/secrets/runtime-model):
  late resolution and explicit source selection reduce exposure; references do
  not isolate a compromised process. We retain fixed errors and no fallback.
- [Hermes passwords and logins](https://hermes-agent.nousresearch.com/docs/user-guide/features/credential-vault):
  hidden capture, local encryption and exact-origin browser fills. We adopt
  explicit site binding and secret-free results. We do not automatically discover
  personal password managers or copy a personal browser profile.

Three alternatives were considered. Implementing the native Keychain helper
would require platform signing/install work and leave other POSIX users without
a vault. Connecting only an external manager would add an account/tool dependency.
A local encrypted vault reuses the repository's tested file custody and encryption
and gives a working capability now; its provider boundary leaves later adapters
possible. The existing Keychain transport remains available to existing consumers.

## Storage and trust

Vault entries are operational credential state, like Pi auth, not task domain
state. They never enter the task journal, artifacts, summaries, task teachings or
model settings. No projection migration, new domain grant, or reinterpretation of
Connection is needed. Domain observations continue through the existing journal.
Rebuild and backup verification never open the vault, prompt or perform effects.

Refactor the existing private encrypted JSON-file implementation into a shared
primitive with an explicit `credential-vault` purpose. Existing Pi/model-settings
formats, authenticated purposes, lock names and error behavior remain compatible.
The vault encrypts both metadata and values on disk; listings deliberately return
only opaque ID, owner-defined label, exact origin, revision and lifecycle status.
Username and password both stay in the protected payload. At most 128 entries,
username 1024 UTF-8 bytes, password 16384 bytes, label 128 bytes. Inputs preserve
whitespace; invalid UTF-8/unpaired surrogates and control characters in metadata
are refused. Values are neither interpolated into errors nor printed.

An entry is bound to workspace ID, owner ID and exact canonical origin. HTTPS is
required for ordinary entries. Explicit synthetic entries allow only an exact
`http://127.0.0.1:<port>` origin. No wildcard, suffix, inferred subdomain, URL path,
userinfo, query or fragment matching. Distinct ports are distinct origins.
Each new entry gets a random opaque ID. Replacement increments revision; removal
keeps a non-secret tombstone so stale IDs cannot become valid again. Updates use
expected revisions and the shared file lock. No retry of uncertain publication.
Trusted secret use holds the file lock through the callback and owned browser
closure. A remove/replace commits after earlier uses finish; its authority takes
effect at commit. Same-process lock/remove requests also cancel active use.
Prompts never run while holding the storage lock. The shared primitive gains a
post-callback cancellation/current-authority check before publishing ciphertext.

The key is a separately selected 32-byte key file, never a password argument,
environment value, model input or key generated beside ciphertext without notice.
CLI requires both `--vault <file>` and `--vault-key-file <file>` together, with
canonical/identity collision checks against database/companions, auth, settings,
key files and locks. Existing `storage keygen` provisions the key. The vault is
opt-in and fails closed on wrong key, corruption, plaintext, unsafe permissions,
symlink/hardlink, missing previously observed state or unsupported platform.

The local process, its UID, root and trusted path ancestors remain inside the
trust boundary. Lock clears owned key/borrowed byte buffers and denies new uses;
JavaScript strings, library buffers, swap and core dumps cannot be promised erased.
No rollback detection, secure deletion, account password rotation, automatic
migration or synchronized vault/database backup is claimed. A vault copy requires
its separate key; old copies can contain removed passwords.

## Owner experience

The normal agent command accepts the optional vault file/key configuration.
`/vault` lists current-workspace metadata and supports add, replace, remove,
lock and unlock. Add/replace prompts for metadata, then hidden username/password;
no command accepts a password argument. All vault prompts bypass ordinary
chat/history. Invalid vault commands produce fixed usage text, never echo values.
Without a configured vault, display setup guidance. Hidden entry must be available;
no plaintext prompt fallback. EOF, cancellation and run expiry leave no entry.

The agent can request a login from the current synthetic login control. Trusted
code derives the destination from the browser observation, not from model text.
For a saved entry, the trusted prompt shows origin and owner-defined label and
asks whether to use it for this task. For a missing entry, it asks whether to save
and use a login, then captures values privately. Skip stops login requests for the
turn. Multiple accounts require an owner selection; the model cannot select a
credential from another site or workspace. No prompt is possible in headless mode;
the result is a fixed unavailable status.

Saving is not permission to use. Every login attempt requires the trusted prompt,
including after restart. Permission exists only in memory and is single-use, bound
to workspace/owner/work revision/run/session/document/origin/entry revision and
deadline. Metadata alone, browser text, old notes and model statements never grant
permission. Check active task and deadline before/after prompt and before storage
publication and browser dispatch. Revocation/replacement/lock during a pending
prompt invalidates its result.
If capture was committed and later dispatch stops, the saved entry may remain;
it grants no permission, and any later use requires a new prompt. Authentication
input and any queued/partial remainder are discarded before returning to chat.

## Browser and model boundary

Keep ordinary semantic browser behavior unchanged. A dedicated synthetic login
adapter implements the same observation/control port with an optional login
operation. It exposes a typed current login control and only schema-recognized,
constant status text. It does not expose general DOM text after credential entry.
The runtime accepts `request_login` with only current observation/control IDs;
no URL, selector, account password, code or arbitrary browser options are accepted.
The model sees success, skipped, unavailable or stopped and a fresh sanitized
observation. No raw exceptions or submitted form values enter its transcript.

The adapter owns a disposable Chromium profile. Network policy is limited to the
exact synthetic loopback origin, fixed GET login page and POST login endpoint.
No redirects, popups, subframes, WebSockets, downloads or other hosts. The fixture
accepts synthetic credential input and provides a fixed result without reflecting
values. Browser code rechecks main-frame origin, document/control identity, field
types and form method/action immediately before filling; request interception
rechecks the one-use permission before sending the POST. Values never enter URLs,
command arguments, environment, traces or screenshots. Credentials travel only
inside the trusted process, private browser connection and exact allowed request.

In-flight disclosure cannot be recalled. Removal/lock prevents a new dispatch but
cannot unsend an already issued request. A timeout or uncertain dispatch ends the
attempt, closes the browser and does not retry. The synthetic workflow does not
book, change an appointment or imply permission for another effect. Any future
live adapter needs separate page/output and request-policy review.
Login submission, recognized response and browser closure all happen inside the
trusted secret-use callback. The port is terminal after this attempt; the model
may explain the sanitized result but cannot continue using an authenticated
session. Failure to confirm browser cleanup keeps the runtime's existing cleanup
hold active. This is the smallest end-to-end credential use boundary for this
slice, not evidence that authenticated general exploration is implemented.

## Acceptance and completion

Behavior tests first must cover durable encrypted restart, exact scope/origin,
wrong key/corruption/unsafe files, replacement/removal/locking races, no plaintext
fallback, fixed errors, no prompt secret in model/journal/context/terminal output,
headless refusal, cancellation, stale work/document/control/entry permission,
single use, restart reauthorization and replay without vault access.

Run a visible owned Chromium synthetic acceptance through capture, encrypted
restart, saved-login confirmation, successful login and confirmed cleanup. Verify
zero forbidden requests and credential canary absence from durable/model outputs.
Then run `npm run verify`, independent Sol/high and Astra/high security/code
reviews, address findings, and check exact-head hosted CI before authorized merge.
