# Local owner control — synthetic approval console

Date: 2026-09-14. Status: accepted implementation direction under the owner's
continuing authorization. Base revision: b5973bd57311cbe84b396aa9a8c75c50cc69c0ce.
This is a partial M1.2 increment; genuine live-model acceptance and remote mobile
owner control remain incomplete.

## Goal and scope

Ship an operable responsive browser surface that authenticates local requests,
displays exact prepared synthetic operations, records owner approval or
cancellation, and preserves those decisions across restart. A fresh deterministic
fixture and an actual-HTTP acceptance demo make the feature usable without a
model, model credential, real account, or owner-operated Mac.

The first HTTP surface contains only bootstrap, logout, action listing, exact
review, approval and cancellation. Approval never executes an operation or resumes
inference. Execution/readback occur only in the separate automated synthetic
acceptance demo after the HTTP server has stopped and released the database.

The owner has authorized continuing implementation, reviews, fixes, PR/CI work
and merge. This design does not expand authorization to deployment, public
exposure, real accounts, paid resources or live inference.

## Approaches considered

| Approach | Benefit | Reason for decision |
| --- | --- | --- |
| Local authenticated review console | Exercises principal binding, exact review, replay rejection and cancellation through an actual UI | Selected as the smallest complete owner-control increment |
| Encrypt Pi credentials and settings first | Closes an important prerequisite for later real-account use | Does not deliver owner control; it remains a subsequent privacy dependency |
| HTTPS plus an established OIDC/passkey implementation | Direct route to remotely usable mobile control | Requires an identity/deployment choice and substantially broader scope |

Use short-lived random bearer credentials with standard Node cryptographic
primitives for the local console. Do not invent WebAuthn, signatures, JWTs,
password hashing, OAuth, certificates or a remote pairing protocol.

## Global constraints

- Node.js **22.19.0+**, TypeScript modular monolith, no new dependencies.
- Use synthetic data only. Never ingest the maintainer's actual accounts into tests.
- Normative documentation and code-facing documentation are English; Chinese translations are supplementary.
- All domain mutation goes through journal events and deterministic reduction. Replay never executes effects.
- A timeout is unknown, not proof of failure. Never auto-retry unknown side effects.
- Owner ID is a local trust binding, not authentication suitable for a public API.
- The HTTP listener binds only to 127.0.0.1; no host override, proxy mode, tunnel, remote exposure or deployment is included.
- New process-lock and bootstrap-file controls are POSIX-only; trusted ancestors are an operator precondition, while owner-controlled immediate directories and safe file identities are enforced.
- The control process loads no model, Pi credential store or model settings, and exposes no execution, chat, provider-login, credential or connection-binding route.
- Bootstrap secrets, bearer tokens and review tokens never enter URLs, command arguments, browser persistent storage, logs, journal payloads, domain artifacts or model context.
- Browser QA is best effort using supported available connectivity; actual HTTP/API acceptance is mandatory. Never add a production authentication bypass for screenshots.
- Genuine live-model acceptance, protected Pi credentials/settings, remote mobile authentication and production-readiness claims remain out of scope.

## Trust and state ownership

The trusted local process chooses one existing synthetic workspace. It derives
the owner ID from that workspace and binds every authenticated session to that
same owner, workspace and process instance. A client-supplied owner/workspace ID
cannot select authority: unknown fields are rejected at the HTTP boundary.

Possession of a bootstrap file issued by that trusted process establishes local
control authority. It is not verification of a real-world identity, a phone,
an external account or an Internet client. The process UID, trusted filesystem
ancestors, root, in-process code and the owner's browser remain trusted. Browser
extensions or a compromised local process can defeat this boundary.
Trusted ancestors are an environmental/operator precondition, not an implemented
ancestor-chain guarantee. The existing private-file helpers validate the
immediate directory. An attacker able to rename or replace an ancestor can
defeat canonical-path, process-lock and bootstrap-file ownership assumptions;
the console does not claim protection in that environment.

The journal remains authoritative for action/work state. The session manager
owns only volatile authentication state. The review service owns volatile
single-use review receipts. Neither becomes a second domain database.
Authentication metadata does not need new domain event types.

The server's dependencies stop at a narrow review service. Never expose
arbitrary method dispatch on Operator, OperationService or SqliteStore.

## Shared process ownership

Create `src/storage/process-lock.ts` and acquire its lock in both
`openLocalAgent` and the new control factory before opening writable SQLite or
the persistent synthetic sidecar. This prevents the existing CLI from silently
bypassing the control process's ownership claim.

~~~ts
export interface LocalProcessLock {
  readonly dbPath: string;
  release(): void;
}
export function acquireLocalProcessLock(dbPath: string): LocalProcessLock;
~~~

The returned path is the canonical database path. For a missing path, create its
immediate directory privately, resolve the real parent and append the basename.
Use that returned path for both the main database and its synthetic sidecar;
do not continue opening either file through the original alias.
Reject unsafe leaf symlinks, nonregular existing database files and hardlinks.
Use the existing private-directory policy; do not silently chmod existing
directories. Validate regular-file owner/link identity while resolving the path.
The canonical immediate parent must belong to the current effective UID, exclude
all group/world permission bits, and permit owner write/traversal. Existing
plaintext database files may retain mode 0644 under that private parent; the lock
does not apply encrypted-storage mode checks or call preparePrivateDatabasePath
to every database. For a present database, verify stable lstat/open/fstat identity
with a no-follow descriptor, regular type, current effective UID and one link.
Encrypted storage retains its existing 0400/0600 requirements. The plaintext
database's existing storage format and mode are unchanged.

Use exclusive creation of `<canonical-db>.behalvo-lock` with mode 0600. Record
only a format version, process ID and random instance identifier. Keep the
created file's device/inode identity for release. A held path or malformed/unsafe
lock fails closed; never follow or replace it. Release is idempotent per handle
and removes only this process's matching file after the final reference closes.
Use a process-local map for reference-counted reuse of the same lock: existing
tests legitimately open distinct workspaces of one database in one process.
The `:memory:` library path requires no filesystem lock; the durable control CLI
does not accept it.

A second process must fail before DB/provider mutation. No PID-based automatic
stealing, stale timeout, lock-removal endpoint or force flag is shipped. An
unclean termination may leave a lock. Document manual removal only after all
Behalvo processes for that database have been stopped and the local operator has
confirmed exclusive maintenance. Never infer provider nonexecution from that
removal or run recovery automatically.

This is a cooperating application process lock, not OS isolation or distributed
fencing. Trusted low-level SqliteStore callers can bypass application lifecycle
coordination. Existing read-only encrypted backup remains allowed.

Add this read-only store method; it must not create `local_mode` or adopt a mode:

~~~ts
// src/storage/sqlite-store.ts
localMode(): 'ordinary' | 'synthetic' | undefined;
~~~

The control factory acquires the process lock, validates a pre-existing safe
database through a read-only SqliteStore, requires mode `synthetic` and the
requested existing workspace, closes that probe, opens writable storage, and
rechecks the binding. It must never call the auto-creating `openLocalAgent` path,
`bindLocalMode`, `openSyntheticOperations`, recovery or a model gateway. Only
init-demo creates fixture data.

## Shared exported contracts

Put value/response types and the fixed error type in `src/control/types.ts`.
Use these exact names so the three implementation units can be reviewed
independently. ControlPrincipal is a trusted in-process capability: the session
manager checks the identity of the exact issued object, not just matching fields.
It must never be reconstructed from JSON or returned over HTTP.

~~~ts
import type { Action, WorkPhase } from '../kernel/types.js';
import type { Connection, OperationCommand } from '../operations/types.js';

export interface ControlBinding {
  readonly workspaceId: string;
  readonly ownerId: string;
}
export interface ControlPrincipal extends ControlBinding {
  readonly instanceId: string;
  readonly sessionId: string;
}
export interface ControlBootstrap {
  version: 1;
  origin: string;
  token: string;
  expiresAt: string;
}
export interface ControlSession {
  token: string;
  expiresAt: string;
  idleExpiresAt: string;
}
export type ControlErrorCode =
  | 'invalid_request' | 'unauthenticated' | 'forbidden'
  | 'not_found' | 'conflict' | 'rate_limited' | 'unavailable';
export class OwnerControlError extends Error {
  readonly code: ControlErrorCode;
  constructor(code: ControlErrorCode);
}
export interface ControlActionSummary {
  actionId: string;
  workId: string;
  workTitle: string;
  workRevision: number;
  currentWorkRevision: number;
  phase: WorkPhase;
  status: Action['status'];
  digest: string;
  approvalExpiresAt: string | null;
  synthetic: true;
}
export interface ControlActionPage {
  workspaceId: string;
  items: ControlActionSummary[];
  nextAfter: string | null;
}
export interface ControlReview {
  action: ControlActionSummary;
  command: OperationCommand;
  connection: Connection | null;
  reviewToken: string;
  reviewExpiresAt: string;
  approvalExpiresAt: string | null;
  canApprove: boolean;
  canCancel: boolean;
}
export interface ControlDecisionInput {
  reviewToken: string;
  digest: string;
}
~~~

`OwnerControlError` selects fixed application-owned messages by code. It never
wraps raw provider, JSON, filesystem or request errors in public messages.

~~~ts
// src/control/session.ts
import type {
  ControlBinding, ControlBootstrap, ControlPrincipal, ControlSession
} from './types.js';

export class OwnerControlSessions {
  readonly instanceId: string;
  constructor(binding: ControlBinding, clock?: () => number);
  issueBootstrap(origin: string): ControlBootstrap;
  exchangeBootstrap(token: string, origin: string): ControlSession;
  authenticate(token: string): ControlPrincipal;
  assertActive(principal: ControlPrincipal): void;
  logout(principal: ControlPrincipal): void;
  close(): void;
}
~~~

An injectable clock is a trusted library/test dependency, never a CLI flag,
request header or body field. Production uses Date.now. All token generation
uses fresh `randomBytes(32).toString('base64url')`. Store only SHA-256 token
digests server-side, compare fixed-length digests safely, and reject malformed
token lengths/encoding before lookup. The random sessionId is an internal
identifier, not a bearer token.

~~~ts
// src/control/review-service.ts
import type { SqliteStore } from '../storage/sqlite-store.js';
import type { Operator } from '../runtime/operator.js';
import type { OperationService } from '../operations/service.js';
import type { OwnerControlSessions } from './session.js';
import type {
  ControlBinding, ControlPrincipal, ControlActionPage, ControlActionSummary,
  ControlReview, ControlDecisionInput
} from './types.js';

export interface OwnerControlServiceOptions {
  store: SqliteStore;
  operator: Operator;
  operations: OperationService;
  sessions: OwnerControlSessions;
  binding: ControlBinding;
  clock?: () => number;
}
export class OwnerControlService {
  constructor(options: OwnerControlServiceOptions);
  list(principal: ControlPrincipal, after?: string): ControlActionPage;
  review(principal: ControlPrincipal, actionId: string): ControlReview;
  approve(principal: ControlPrincipal, actionId: string,
    input: ControlDecisionInput): ControlActionSummary;
  cancel(principal: ControlPrincipal, actionId: string,
    input: ControlDecisionInput): ControlActionSummary;
  logout(principal: ControlPrincipal): void;
  close(): void;
}
~~~

The service validates its principal against the live session manager and the
current workspace owner before every read or mutation. List only valid
`operation.execute` actions for provider `synthetic-accounts` and operation
`contact.update`/`subscription.cancel` version `1`. Direct review/mutation of a
different kind/provider/version fails without exposing its contents.

List at most 100 summaries sorted by action ID. `after` is an optional validated
action-ID cursor; `nextAfter` is the last returned ID only when more items exist.
No full-state/history/artifact endpoint is introduced.

~~~ts
// src/control/local-app.ts
import type { OwnerControlSessions } from './session.js';
import type { OwnerControlService } from './review-service.js';

export interface OwnerControlApp {
  readonly sessions: OwnerControlSessions;
  readonly service: OwnerControlService;
  close(): void;
}
export function openOwnerControl(options: {
  dbPath: string;
  workspaceId: string;
  clock?: () => number;
}): OwnerControlApp;
~~~

The factory uses SqliteStore, Operator and OperationService with an empty
OperationRegistry. Approval needs no registered provider callback. The
factory-owned close is idempotent: invalidate receipts and sessions, close the
store, then release the process lock. Do not expose the store on this object.

Extend existing methods with a separate optional trusted guard, preserving
existing callers and input-object validation:

~~~ts
// OperationService
approveBatch(input: ApproveOperationBatchInput,
  beforeAppend?: () => void): OperationAction[];

// Operator
cancelAction(workspaceId: string, ownerId: string, actionId: string,
  reason: string, beforeAppend?: () => void): void;
~~~

Pass that guard to SqliteStore.append's existing final argument. Authentication
fields must not be added to model-visible input types or journal event data.

## Authentication lifecycle and private bootstrap file

The HTTP adapter binds its literal IPv4 loopback listener first, using port 0 by
default, then constructs the canonical origin with
`new URL('http://127.0.0.1:' + assignedPort).origin`. This includes the assigned
port except HTTP's default port 80, which browsers normalize away. It
calls issueBootstrap exactly once for this process instance. Bootstrap issuance
cannot be repeated, including after logout or failed exchange.

A bootstrap token expires five minutes after issuance. Exchange requires its
exact origin and consumes a valid token synchronously before returning one new
session. A replay, previous-process token, wrong origin or expired token fails.
Ten failed well-formed bootstrap credential attempts exhaust this process's
bootstrap attempt allowance; later exchange receives rate_limited. Malformed
HTTP/origin requests are rejected before the credential attempt counter.

There is one session per process startup. The absolute session lifetime is one
hour; the idle lifetime is fifteen minutes. authenticate extends only the idle
deadline, capped at the absolute deadline. assertActive checks the same live
issued principal without extending any deadline; use it inside write guards.
Logout invalidates the session and all its review receipts. close invalidates
everything. There is no cookie, refresh credential or remembered device.

Publish one strict ControlBootstrap JSON document to a uniquely named
`<instanceId>.behalvo-bootstrap` in the configured private directory with the
existing exclusive private-publication helper. Use mode 0600 in a mode 0700
directory. The server interface returns only the public origin and file path,
never its secret. Never overwrite a pre-existing file. Record the final file's
device/inode identity and remove only that owned identity after successful
exchange, expiry or shutdown. Failure to remove a consumed file does not restore
its authority; shutdown attempts cleanup again without printing file contents.
A leftover file after a crash is invalid in the next process.

The UI reads the selected pairing file locally, validates its exact shape and
origin, posts the token in an Authorization header, clears the input, and keeps
the returned bearer only in a private JS closure. No browser cookie or
local/session storage is used. Reload, logout, expiry or a lost bootstrap
response requires restarting serve to issue a new file. This intentional local
limitation is shown in the pairing UI and documentation. No stdin re-pair command
or HTTP re-pair endpoint is included.

## Review, approval and cancellation semantics

The review response includes the complete immutable command, full digest,
action/work IDs, work title, original and current work revisions, phase,
current action status, and existing approval expiry. Command fields retain the
original provider, subject, connection generation, operation/version, affected
resources, precondition and expected result. The current connection is displayed
separately, including its label, status and generation. Missing or changed
bindings must not be hidden by a friendly label.

A review issues a fresh random one-use receipt with a two-minute lifetime.
Bind it to the exact issued session, process instance, workspace, owner, action,
digest, original work revision and displayed approval expiry. Hold at most one
pending receipt per session/action and at most 100 pending receipts per service;
replace the previous receipt on a new review, prune expired entries, and reject
overflow. Store token digests only.

For an approvable proposed action, the displayed absolute approval expiry is
exactly ten minutes after review issuance. It is not silently recomputed when
the owner clicks. A reviewed existing approval displays its existing expiry.
A terminal/otherwise unapprovable action without approval has null expiry.
The UI must render the full review before enabling a separate deliberate
decision button. A server-issued review is evidence of an offered snapshot, not
proof of human attention.

Approval requires exact ControlDecisionInput, a current receipt and an exact
full digest. Recompute commandDigest, require proposed status, current open work
at action.workRevision, and an active current connection matching the immutable
provider/subject/generation binding. Call approveBatch for one action with the
receipt's fixed expiry; never accept client expiry or command/work/owner fields.

Reserve a valid receipt before invoking synchronous domain mutation so it cannot
serve two requests. The trusted append guard rechecks the issued session and
receipt deadlines, binding, eligibility and fixed approval expiry after SQLite
acquires its writer lock. A reserved receipt may be checked by its own guard but
may not be claimed by another request. Consume the receipt on either success or
mutation failure; refresh is required after uncertainty. Lost response/replayed
POST must not append a second event or cause automatic retry.

Cancellation uses a fresh review receipt and exact digest, authenticates through
the same session, and calls cancelAction with the fixed reason
`Cancelled through authenticated local owner control.`. Allow cancellation only
from proposed/approved. Stale work or a revoked/changed connection does not
prevent revoking that immutable pending action. Recheck its current cancellable
status and digest inside the append guard. No cancellation request may settle,
stop or undo running/accepted/failed/unknown effects. Already-cancelled/replayed
decisions return conflict without a new event.

Logout and server shutdown revoke browser authority but do not revoke already
journaled approvals. Display this before sign-out. Expired approved actions
cannot be renewed through this API: existing approveBatch accepts proposed
actions only. They can be cancelled; a separately prepared replacement is a
later owner action. No new approval-renewal transition is added.

## HTTP adapter and responses

~~~ts
// src/control/http-server.ts
import type { OwnerControlApp } from './local-app.js';

export interface ControlAssets {
  html: string;
  javascript: string;
  css: string;
}
export interface OwnerControlServer {
  readonly origin: string;
  readonly bootstrapPath: string;
  close(): Promise<void>;
}
export function startOwnerControlServer(options: {
  app: OwnerControlApp;
  bootstrapDirectory: string;
  assets: ControlAssets;
  port?: number;
}): Promise<OwnerControlServer>;
~~~

Server close stops admitting requests, invalidates session/review state, closes
connections/listener and cleans up its owned bootstrap file. The caller then
closes OwnerControlApp to close SQLite/release the lock. On startup failure close
the listener and any published bootstrap file; the caller still closes the app.

| Method/path | Request | Response |
| --- | --- | --- |
| GET / | No credentials; static shell only | text/html |
| GET /app.js | Static fixed asset | text/javascript |
| GET /styles.css | Static fixed asset | text/css |
| POST /api/session/bootstrap | Authorization: Bearer bootstrap-token; body {} | 200 ControlSession |
| POST /api/session/logout | Authorization: Bearer session-token; body {} | 204, no body |
| GET /api/actions[?after=ID] | Bearer session token; optional one cursor | 200 ControlActionPage |
| POST /api/actions/:id/review | Bearer session token; body {} | 200 ControlReview |
| POST /api/actions/:id/approve | Bearer session token; ControlDecisionInput | 200 ControlActionSummary |
| POST /api/actions/:id/cancel | Bearer session token; ControlDecisionInput | 200 ControlActionSummary |

No endpoint accepts workspace or owner selectors. Unsupported paths/methods,
query fields, duplicate query values, body fields and command overrides fail.
Reject unknown query parameters even on static assets. Unknown routes never
reveal workspace contents.

All requests require exactly the canonical origin's URL.host authority,
including its port when non-default. Reject
non-loopback peers and any Forwarded or X-Forwarded-* headers. Require origin-form
request targets, reject duplicate Host/Origin/Authorization/Content-Length/
Transfer-Encoding headers, and reject absolute request URLs. No CORS response
headers or cross-origin OPTIONS support are emitted.

Every POST requires the exact configured Origin. If Origin appears on a GET it
must match; do not require it on same-origin GET because browsers may omit it.
If Sec-Fetch-Site is present, APIs accept only same-origin; static top-level
navigation can also use none. If the header is absent, bearer authentication and
the other checks still apply. Origin is an additional boundary, never identity.

Only application/json, optionally with charset=utf-8, is accepted for POST.
Reject content encodings, nonobjects, arrays, null, trailing junk and unknown
fields. Bound headers to 16 KiB, request targets to 2048 bytes and bodies to
4096 bytes. Bound the encoded review response to 512 KiB and reject overflow
instead of truncating. List responses are bounded to 256 KiB. Limit active
connections to 16, header receipt to five seconds and full request receipt to ten
seconds. Do not log bodies, tokens, headers or raw exceptions.

Return JSON `{"error":"<code>"}` for API errors. Map invalid_request to 400,
unauthenticated to 401, forbidden to 403, not_found to 404, conflict to 409,
rate_limited to 429 and unavailable to 503. Unexpected failures return 500 with
`{"error":"internal_error"}`. Payload overflow can return 413 with invalid_request.
Unsupported methods return 405 with invalid_request. No error includes submitted
values, filesystem contents or stack traces.

Apply these headers to assets, API responses and errors:

- Cache-Control: no-store
- Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'
- X-Content-Type-Options: nosniff
- X-Frame-Options: DENY
- Referrer-Policy: no-referrer

Client requests use a bearer Authorization header and credentials: 'omit'.
Mutations are separate JSON POSTs. No automatic mutation retry is allowed.
This removes ambient cookie authorization; strict origin checks and denial of
cross-origin custom-header requests supply the CSRF boundary. See
[OWASP's CSRF guidance](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html).
These choices do not make loopback HTTP a deployable remote authentication
system.

## UI, CLI and model-free fixture

Create fixed static `index.html`, `app.js` and `styles.css` in
`src/control/web/`. Use a small asset-copy build script to place them in
`dist/control/web/`; do not depend on a checkout-relative runtime URL or a CDN.

~~~ts
// src/control/assets.ts
import type { ControlAssets } from './http-server.js';
export function loadOwnerControlAssets(): ControlAssets;

// src/control/demo-fixture.ts
export const OWNER_CONTROL_DEMO_WORKSPACE = 'owner-control-demo';
export interface OwnerControlDemoFixture {
  dbPath: string;
  workspaceId: string;
  ownerId: string;
  approveActionId: string;
  cancelActionId: string;
}
export function initializeOwnerControlDemo(
  dbPath: string
): Promise<OwnerControlDemoFixture>;

// src/cli/owner-control-main.ts
export type OwnerControlCommand =
  | { kind: 'help' }
  | { kind: 'init-demo'; dbPath: string }
  | { kind: 'serve'; dbPath: string; workspaceId: string;
      bootstrapDirectory: string; port: number };
export interface OwnerControlCliDependencies {
  cwd?: string;
  writeStdout?: (text: string) => void;
  writeStderr?: (text: string) => void;
  signal?: AbortSignal;
}
export function parseOwnerControlArgs(
  argv: readonly string[], cwd?: string
): OwnerControlCommand;
export function runOwnerControlCli(
  argv: readonly string[], dependencies?: OwnerControlCliDependencies
): Promise<number>;

// src/control-demo.ts
export interface OwnerControlDemoResult {
  mode: 'local-owner-control';
  realModelCalls: 0;
  realExternalEffects: 0;
  authenticatedDecisions: number;
  rejectedApprovalReplays: number;
  verifiedSyntheticActions: number;
  cancelledActions: number;
  journalReplaysMatch: boolean;
}
export function runOwnerControlDemo(): Promise<OwnerControlDemoResult>;
~~~

CLI syntax:

~~~text
npm run owner-control -- init-demo --db data/owner-control-demo.db
npm run owner-control -- serve --db data/owner-control-demo.db --bootstrap-dir data/control-bootstrap
npm run owner-control:demo
~~~

init-demo requires --db. serve requires --db and --bootstrap-dir; optional
--workspace defaults to owner-control-demo and --port defaults to 0. Accept only
integer ports 0..65535. Reject duplicate/unknown flags, unexpected positional
arguments, :memory:, empty values and unsupported --flag=value syntax. No
environment fallback or auth/model/storage-key/host option exists. Bare invocation
or --help alone prints help.

The fixture acquires the shared process lock, checks the main database, its
SQLite sidecars and the persistent synthetic sidecar family are all absent, and
creates the new synthetic database/workspace. Use owner ID `owner`. Call existing
openSyntheticOperations with the existing versioned handlers. Create two
distinct works before preparing either action. Prepare contact.update to set
`owner-control@example.test` and subscription.cancel with reason
`Synthetic owner-control demonstration`, using stable fixture keys. Return the
actual action IDs. Close the provider/store and release the lock. Initialization
failure leaves an explicitly incomplete private fixture; never silently delete,
reuse or reseed it. Choose a new path or inspect it under exclusive maintenance.

serve prints only the bound origin, JSON-quoted bootstrap path and local/synthetic
scope. It never reads Pi auth/settings or their environment variables. Handle
SIGINT/SIGTERM with orderly server/app close; remove only signal listeners
installed by this invocation. The optional trusted signal dependency exercises
the same shutdown path in tests and cannot bypass authentication.

The UI has a pairing-file input, workspace/action list, full review, separate
Approve and Cancel controls, refresh and sign-out. Use semantic labels, keyboard
access and a readable single-column layout at 390 px. Show exact command JSON
and current binding metadata without truncation; wrap long values and make the
digest copyable. All data uses textContent, not HTML/Markdown rendering.
Disable decisions while a request is pending, discard expired/replaced review
tokens and refresh after completion/conflict. Never show optimistic success
before the server response. No automatic polling is required.

The demo uses the same server and private-file exchange as the UI, through real
node:http/fetch requests with exact origin and bearer headers. No special
authentication path, predictable token or test header is added to production.
Approve the contact action, reject a replay, and cancel the subscription action.
Assert there are no started effects while the server is active. Stop/close the
server and app, reacquire the shared lock, open the persistent synthetic provider,
execute and verify only the approved action, and confirm the cancelled action
cannot execute. Reopen/rebuild and compare the journal-derived state. Output
only the summary result; expected counts are 2 decisions, 1 rejected replay,
1 verified action and 1 cancelled action, with zero real model calls/effects.

## File decomposition and implementation units

1. Local process ownership, sessions and scoped review service:
   process-lock.ts; SqliteStore.localMode; local-app lock wiring; control types,
   sessions, factory and review service; trusted append guards; focused tests.
2. HTTP adapter, authentication exchange, private bootstrap publication and
   security tests: http-server.ts and actual-request tests. Use supplied static
   fixture assets while testing; they are dependency data, not an auth bypass.
3. Actual UI, assets build, init/serve CLI, deterministic fixture/HTTP acceptance
   demo, CI script and user documentation.

The implementation plan is
`docs/superpowers/plans/2026-09-14-owner-control.md`. No broad kernel rewrite,
persistent auth database, model loop modification or credential-vault work is
needed.

## Verification and remaining gates

Behavior tests must cover process exclusion in both CLI/control directions,
same-process reference counting, unsafe/alias paths, ownership-safe release,
crash locks, existing-mode/workspace preflight and no implicit seeding. Cover
bootstrap/session expiry, replay, origin binding, principal-object forgery,
logout/close, bounded receipts, full digest binding, wrong action/workspace,
stale approvals and connection changes. Exercise expiry after a real SQLite
writer-lock wait using the existing lock-helper pattern. Cancellation of stale
pending work remains possible; terminal/unknown/running states remain protected.

Actual HTTP tests cover missing/invalid auth, wrong Host/origin/port, Fetch
Metadata, forwarded/duplicate headers, request bounds, JSON/field rejection,
method/path/query allowlists, fixed errors/security headers, secret-file lifecycle
and no secret leakage. Data canaries must not appear in unauthenticated responses,
logs or error bodies. Auth/settings canary files remain unchanged.

Run npm run check, npm run demo, npm run operations:demo,
npm run owner-control:demo and git diff --check. Add the owner-control demo to
the existing Node 22.19.0/24.x CI job. Browser QA should inspect pairing and
responsive review/decision controls through supported connectivity when
available. If unavailable, report that limit; API tests do not prove visual
layout. Never expose the listener or weaken auth to obtain a screenshot.

This slice leaves issue 01 partially open. It authenticates local bearer requests
and separates owner decisions from conversation content, but does not provide
remote identity, message-send preview or actual phone connectivity. Pi
credentials/settings and evaluation reports remain outside the encrypted
database boundary; synthetic provider state remains plaintext. Real-data use
still requires protected credentials/configuration, retention/erasure,
reviewed private HTTPS access with an established owner identity system,
live-model/manual acceptance, provider authorization/readback and deployment
review. Existing approvals surviving logout/restart and unknown-action barriers
must remain explicit.
