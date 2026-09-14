# Local Owner Control Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a model-free responsive local console that authenticates a browser, displays exact synthetic operations, and journals replay-resistant approval or cancellation.

**Architecture:** A shared per-database process lock protects supported local application lifecycles. A session-bound review service uses the existing journal/runtime APIs, while a small loopback HTTP adapter owns request admission and private bootstrap publication. Static UI, strict CLI commands and an actual-HTTP synthetic demo make the boundary operable without live credentials.

**Tech Stack:** TypeScript, Node crypto/fs/http/sqlite, static HTML/CSS/JavaScript, node:test; existing pinned dependencies only.

**Spec:** `docs/superpowers/specs/2026-09-14-owner-control-design.md`

## Global Constraints

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

---

## Execution context and file responsibilities

Worktree: `/workspace/scratch/871e778ff34c/behalvo-published/.worktrees/owner-control`.
Branch: `feat/owner-control`. Read AGENTS.md, README.md, SECURITY.md and the
architecture/current feature specs before implementation. The owner has already
authorized this design, continued implementation, review/fixes and PR/CI/merge.
Do not add another user approval stop. This plan does not authorize deployment
or real account/model activity. The planning agent writes only these documents;
the executing root decides when to commit them.

Use max effort for planning/design, medium for routine implementation/tests/docs,
and high for complex implementation/security reviews. Exactly three task gates
are intended. A reviewer can reject one unit independently of the others; small
steps inside a task do not create additional feature scopes.

| File | Responsibility |
| --- | --- |
| src/storage/process-lock.ts | Cooperating local process ownership and safe release |
| src/storage/sqlite-store.ts | Read-only local-mode inspection |
| src/cli/local-app.ts | Existing CLI lock lifecycle |
| src/control/types.ts | Shared request/response types and fixed errors |
| src/control/session.ts | Bootstrap/session lifetime and issued principals |
| src/control/review-service.ts | Workspace-scoped snapshots and one-use decisions |
| src/control/local-app.ts | Existing synthetic workspace lifecycle without models |
| src/operations/service.ts; src/runtime/operator.ts | Optional trusted append guards |
| src/control/http-server.ts | Loopback admission, authentication, routes and bootstrap files |
| src/control/web/index.html; app.js; styles.css | Actual responsive browser UI |
| src/control/assets.ts; scripts/copy-control-assets.mjs | Fixed asset loading and build copying |
| src/control/demo-fixture.ts | Fresh synthetic fixture initialization |
| src/cli/owner-control-main.ts | Strict init/serve arguments and shutdown |
| src/control-demo.ts | Actual-server authentication/decision/restart acceptance |
| README.md; SECURITY.md; docs/OWNER_CONTROL.md; docs/ROADMAP.md; docs/issues/01-owner-control.md | Truthful user operations and milestone status |
| .github/workflows/ci.yml; package.json; .gitignore | Build/demo gates and secret/runtime exclusions |

Shared type declarations in the spec are normative. Import their exact names
from `src/control/types.ts`; do not invent neighboring aliases or move
authentication fields into domain events. Snippets below illustrate central
behavior, not complete copies of the future implementation.

### Task 1: Local process lock, sessions and scoped review service

**Files:**

- Create: `src/storage/process-lock.ts`
- Create: `src/control/types.ts`, `src/control/session.ts`, `src/control/review-service.ts`, `src/control/local-app.ts`
- Modify: `src/storage/sqlite-store.ts`, `src/cli/local-app.ts`, `src/operations/service.ts`, `src/runtime/operator.ts`
- Modify: `.gitignore` (add `*.behalvo-lock` and `*.behalvo-bootstrap`)
- Create: `tests/owner-control-fixture.mjs`, `tests/owner-control-lock-child.mjs`
- Create: `tests/process-lock.test.mjs`, `tests/owner-control-session.test.mjs`, `tests/owner-control-service.test.mjs`
- Extend where needed: `tests/local-app.test.mjs`, `tests/local-synthetic.test.mjs`, `tests/cli-main.test.mjs`
- Read: `tests/sqlite-lock-helper.mjs`, `tests/operation-terminal.test.mjs`, `src/storage/private-files.ts`, `src/operations/local-synthetic.ts`

**Interfaces:**

Consumes existing `SqliteStore`, `OperationService`, `Operator`,
`OperationRegistry`, `commandDigest`, the synthetic handlers and private-file
helpers. Retain existing input validation and domain event schemas.

Produces these exact exports; shared data types are fully declared in the spec:

~~~ts
// src/storage/process-lock.ts
export interface LocalProcessLock {
  readonly dbPath: string;
  release(): void;
}
export function acquireLocalProcessLock(dbPath: string): LocalProcessLock;

// Addition to SqliteStore
localMode(): 'ordinary' | 'synthetic' | undefined;

// Existing methods gain separate trusted arguments
approveBatch(input: ApproveOperationBatchInput,
  beforeAppend?: () => void): OperationAction[];
cancelAction(workspaceId: string, ownerId: string, actionId: string,
  reason: string, beforeAppend?: () => void): void;

// src/control/session.ts
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

// src/control/review-service.ts
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

// src/control/local-app.ts
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

`src/control/types.ts` must export ControlBinding, ControlPrincipal,
ControlBootstrap, ControlSession, ControlErrorCode, OwnerControlError,
ControlActionSummary, ControlActionPage, ControlReview and ControlDecisionInput
with the exact spec fields. OwnerControlError takes only a ControlErrorCode and
selects a fixed message; caller-provided/raw error strings are not accepted.

The test-only fixture helper exports
`createOwnerControlFixture(t): Promise<{directory, dbPath, workspaceId, ownerId, approveActionId, cancelActionId}>`.
It creates a private temporary directory, a synthetic-mode SqliteStore, two
works, and two prepared actions with existing trusted APIs; register cleanup on
the node:test context. Close all setup handles before returning. It is not a
production auth bypass and is not imported by application code.

- [ ] **Step 1: Write process ownership and existing-workspace admission tests.**

Use temporary POSIX directories and a child Node process; do not merely test
two handles in one process. The child helper acquires the requested database
lock or opens the requested LocalAgent, writes a fixed readiness line, and
waits for stdin close before releasing. Test both application directions,
canonical parent aliases, unsafe leaf symlink/hardlink rejection, matching-file
release, repeated release and leftover crash locks. In-process acquisitions
must share one lock until both references release.

~~~js
const first = acquireLocalProcessLock(dbPath);
const second = acquireLocalProcessLock(dbPath);
assert.equal(second.dbPath, first.dbPath);
first.release();
assert.equal(existsSync(first.dbPath + '.behalvo-lock'), true);
second.release();
second.release();
assert.equal(existsSync(first.dbPath + '.behalvo-lock'), false);
~~~

Assert that an existing ordinary/unbound database, missing database, missing
workspace and encrypted database without a key cannot be adopted by
openOwnerControl; compare file bytes/state before and after rejection.
localMode must leave a missing mode table absent. Existing CLI startup must
fail against another process's control lock before a provider sidecar is opened.

- [ ] **Step 2: Run lock/admission tests RED.**

Run `npm run build && node --test tests/process-lock.test.mjs tests/owner-control-service.test.mjs`.
Record missing exports or missing lock exclusion as the expected failure; do not
accept an unrelated fixture/import error as behavioral evidence.

- [ ] **Step 3: Implement the process lock and lifecycle integration.**

Resolve the real parent path, reject unsafe existing leaf identities, create
the 0600 lock exclusively and keep device/inode ownership. Reference-count
within the process. `:memory:` is a no-file library handle. Acquire before
opening writable stores and release after all local app/provider handles close,
including failed startup. Never steal a lock or remove a mismatched replacement.
Use the returned canonical dbPath for both the main store and synthetic sidecar,
so the original path alias cannot split lock identity from data identity.
Require a private owner-controlled canonical immediate parent with owner write
and traversal. Existing plaintext database leaves may be 0644 under that parent;
check no-follow regular type, current effective UID, one link and stable
lstat/open/fstat identity without chmod or preparePrivateDatabasePath. Encrypted
storage retains its separate mode requirements. Add a regression opening and
reopening an existing 0644 ordinary database in a 0700 parent through LocalAgent.

~~~ts
const descriptor = openSync(lockPath,
  constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
  0o600);
const ownedIdentity = fstatSync(descriptor);
~~~

The lock file records only version, PID and a random instance ID. Directory
policy comes from the existing private-file primitives; current plaintext
domain/storage schemas do not change. Implement localMode as inspection, with
no CREATE TABLE or mode adoption. Implement openOwnerControl's read-only
preflight and writable recheck under the same held lock; build an empty
OperationRegistry and no model gateway. Preserve same-process workspace
isolation tests instead of weakening their assertions.

- [ ] **Step 4: Write session/bootstrap lifetime and principal tests, then run RED.**

Tests use a controllable trusted clock and real random tokens. Verify one
bootstrap issuance, one exchange, exact origin, five-minute bootstrap expiry,
ten failed credential attempts, one-hour absolute/fifteen-minute idle session
limits, object-identity principal validation, logout and close. Session
authentication can extend idle expiry only up to absolute expiry; assertActive
cannot extend it.

~~~js
let now = Date.now();
const sessions = new OwnerControlSessions(
  { workspaceId: 'owner-control-demo', ownerId: 'owner' }, () => now);
const bootstrap = sessions.issueBootstrap('http://127.0.0.1:44001');
const ticket = sessions.exchangeBootstrap(bootstrap.token, bootstrap.origin);
const principal = sessions.authenticate(ticket.token);
assert.throws(() => sessions.assertActive({ ...principal }),
  error => error.code === 'unauthenticated');
assert.throws(() => sessions.exchangeBootstrap(bootstrap.token, bootstrap.origin));
now += 15 * 60_000;
assert.throws(() => sessions.authenticate(ticket.token),
  error => error.code === 'unauthenticated');
~~~

Run `npm run build && node --test tests/owner-control-session.test.mjs`.

- [ ] **Step 5: Implement the volatile session authority.**

Use fresh 32-byte base64url random tokens, strict token encoding/length, SHA-256
digests and fixed-length comparisons. Keep the exact issued principal object
private to the session manager. Exchange consumes the bootstrap synchronously
before returning the bearer. No re-pair method, cookie, refresh token,
persistent authentication file/database or deterministic token option exists.

~~~ts
const token = randomBytes(32).toString('base64url');
const digest = createHash('sha256').update(token, 'ascii').digest();
const expiry = new Date(now + 5 * 60_000).toISOString();
~~~

Use the same injected/default clock for all session comparisons; HTTP will
supply the already-bound literal origin. Clear internal authority on logout
and close; repeated close is harmless.

- [ ] **Step 6: Write scoped review/decision tests, then run RED.**

Using createOwnerControlFixture, authenticate through the session authority,
review the exact action, approve once, and reject the same receipt again.
Verify fixed expiry is based on review issuance, not click time. Assert all
returned metadata/command fields and current/original revisions literally.

~~~js
const fixture = await createOwnerControlFixture(t);
let now = Date.now();
const app = openOwnerControl({
  dbPath: fixture.dbPath, workspaceId: fixture.workspaceId, clock: () => now
});
t.after(() => app.close());
const bootstrap = app.sessions.issueBootstrap('http://127.0.0.1:44001');
const ticket = app.sessions.exchangeBootstrap(bootstrap.token, bootstrap.origin);
const principal = app.sessions.authenticate(ticket.token);
const review = app.service.review(principal, fixture.approveActionId);
const expiresAt = review.approvalExpiresAt;
now += 30_000;
const input = { reviewToken: review.reviewToken, digest: review.action.digest };
const approved = app.service.approve(principal, fixture.approveActionId, input);
assert.equal(approved.status, 'approved');
assert.equal(approved.approvalExpiresAt, expiresAt);
assert.throws(() => app.service.approve(principal, fixture.approveActionId, input),
  error => error.code === 'conflict');
~~~

Add negative cases for unknown fields, wrong action/owner/workspace, copied
principal, modified digest, receipt expiry/replacement, session logout/close,
stale or closed work, changed/revoked connection and unknown action/provider.
Test 100-item pagination and the 100-receipt bound. Review overflow must reject
without approving a partial command. Cancellation remains allowed for stale
proposed/approved actions but never for running/unknown/terminal actions.
A lost/replayed decision creates no second journal event.

Run `npm run build && node --test tests/owner-control-service.test.mjs`.

- [ ] **Step 7: Implement review receipts and trusted runtime guards.**

Keep a receipt map bound to the exact principal and immutable action snapshot.
Replace a prior receipt for that session/action; prune expiries and bound its
size. For approval recompute commandDigest and enforce the spec's work and
connection rules; cancellation checks exact immutable action and current
cancellable status without requiring fresh/open work or active connection.

~~~ts
// Existing approveBatch's final append retains its existing events/metadata.
this.store.append(input.workspaceId, state.version, events,
  { actorId: input.ownerId, recordedAt: now }, beforeAppend);
~~~

Implement reserve -> guarded synchronous mutation -> consumed receipt behavior.
The callback passed by OwnerControlService validates the live issued session,
receipt deadline, fixed approval expiry and relevant current binding after
the SQLite writer lock is acquired. Consume on success or failure. Never put
auth/session fields in ApproveOperationBatchInput or domain events. Cancellation
uses exactly `Cancelled through authenticated local owner control.`.

- [ ] **Step 8: Add and run the real writer-lock wait regression.**

Use the existing SQLite lock-helper pattern to hold a writer lock while a
review/session approaches expiry; invoke the decision in another controlled
process so the clock can pass while DatabaseSync waits. Assert the append
guard rejects the expired authority and the journal contains no decision.
Also assert a control-service cancellation cannot change a running action.
Run the complete focused Task 1 tests, then `npm run check` and
`git diff --check`. Record actual outcomes and any POSIX-only skip.

- [ ] **Step 9: Review the complete unit and commit when directed by the executing root.**

Inspect errors and exports for secret/raw-string exposure, lock bypasses,
automatic recovery and accidental model imports. Suggested task commit:
`feat: add scoped local owner control and process ownership`. This task is
independently reviewable without an HTTP listener.

### Task 2: Loopback HTTP authentication, bootstrap files and security tests

**Files:**

- Create: `src/control/http-server.ts`
- Create: `tests/owner-control-http.test.mjs`, `tests/owner-control-http-helpers.mjs`
- Read/consume: `src/control/types.ts`, `src/control/session.ts`, `src/control/review-service.ts`, `src/control/local-app.ts`
- Read/consume: `src/storage/private-files.ts`
- Reuse: `tests/owner-control-fixture.mjs`
- No UI assets, CLI/model integration or alternate test authentication route in this task

**Interfaces:**

Consumes `openOwnerControl({dbPath, workspaceId, clock?}): OwnerControlApp`,
`app.sessions.issueBootstrap(origin): ControlBootstrap`,
`exchangeBootstrap(token, origin): ControlSession`,
`authenticate(token): ControlPrincipal`, and the service's exact list/review/
approve/cancel/logout signatures from Task 1. It consumes
`publishPrivateFile(destination, write): Promise<void>` and private-directory
validation from the existing storage module.

Produces exactly:

~~~ts
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

The test HTTP helper exports
`requestControl(origin, method, path, token, body): Promise<{status, headers, body}>`
using node:http. It sends exact Origin and optional Bearer Authorization,
JSON-encodes a supplied body, collects bounded response data and returns parsed
JSON or text. Individual malformed/raw-header tests use node:http or node:net
directly; no production route/header changes are permitted.

- [ ] **Step 1: Write actual-request authentication and bootstrap-file tests.**

Use the Task 1 fixture and real port 0 loopback listener. Supply minimal static
asset strings through the normal dependency. Assert an unauthenticated list is
401 with no action/work canary, bootstrap mode/directory/file ownership is
private, no API response reveals the bootstrap, and one actual file exchange
permits a list. The server object must not expose a token.

~~~js
const fixture = await createOwnerControlFixture(t);
const app = openOwnerControl({
  dbPath: fixture.dbPath, workspaceId: fixture.workspaceId
});
const server = await startOwnerControlServer({
  app,
  bootstrapDirectory: join(fixture.directory, 'bootstrap'),
  assets: { html: '<!doctype html><title>Control</title>',
    javascript: "'use strict';", css: 'body { color: black; }' }
});
t.after(async () => { await server.close(); app.close(); });
const anonymous = await requestControl(server.origin, 'GET', '/api/actions');
assert.equal(anonymous.status, 401);
const bootstrap = JSON.parse(await readFile(server.bootstrapPath, 'utf8'));
const login = await requestControl(server.origin, 'POST',
  '/api/session/bootstrap', bootstrap.token, {});
assert.equal(login.status, 200);
const page = await requestControl(server.origin, 'GET',
  '/api/actions', login.body.token);
assert.equal(page.status, 200);
assert.equal(page.body.items.length, 2);
~~~

Also test bootstrap replay, expiry, wrong origin, logout, file collision,
unsafe/symlink directory or leaf, startup failure cleanup, owned-inode cleanup
and restart invalidation. On successful exchange/expiry/shutdown no still-live
bootstrap secret file remains; cleanup failure cannot restore token authority.

- [ ] **Step 2: Run the HTTP tests RED.**

Run `npm run build && node --test tests/owner-control-http.test.mjs`.
Record missing server/route behavior rather than accepting a fixture failure.

- [ ] **Step 3: Implement listener startup and private bootstrap lifecycle.**

Bind only `127.0.0.1` and port 0 by default. Derive the canonical origin from
server.address using `new URL('http://127.0.0.1:' + assignedPort).origin`; compare
Host to that URL's host authority so default port normalization is consistent.
Then call issueBootstrap once. Publish its strict JSON to the
private unique instance-named file, remember device/inode identity, and expose
only origin/path. If startup publication fails, close the listener before
propagating a fixed safe error.

~~~ts
const bootstrap = app.sessions.issueBootstrap(origin);
await publishPrivateFile(bootstrapPath, stagedPath =>
  writeFile(stagedPath, JSON.stringify(bootstrap) + '\n', 'utf8'));
~~~

Clean up only that owned file on consumption/expiry/shutdown. Server.close
invalidates session/review state and stops/settles its listener/connections;
the caller closes OwnerControlApp afterward. No re-pair API exists.

- [ ] **Step 4: Write the transport-admission matrix before routing mutations.**

Test exact/foreign/missing Host; wrong Origin/port; missing POST Origin;
permitted missing GET Origin with valid bearer; rejected cross-site/same-site
Fetch Metadata; forwarded headers; duplicate critical headers; absolute request
targets; unknown method/path/query/body fields; JSON arrays/null/trailing junk;
wrong content type/encoding; body/target/header limits. All failures must leave
journal version/action status unchanged.

~~~js
const forged = await requestControl(server.origin, 'POST',
  '/api/actions/' + fixture.approveActionId + '/approve', sessionToken,
  { reviewToken: review.reviewToken, digest: review.action.digest,
    ownerId: 'owner', workspaceId: fixture.workspaceId });
assert.equal(forged.status, 400);
assert.deepEqual(forged.body, { error: 'invalid_request' });
~~~

Here sessionToken/review come from the preceding real bootstrap/review HTTP
requests in that test. For duplicate-header tests build raw HTTP bytes with
node:net so the client library cannot normalize the adversarial input away.

- [ ] **Step 5: Implement strict admission and the six API routes.**

Use the exact HTTP table/error mapping in the spec. Authenticate from Bearer
Authorization, never body/cookie/query parameters. Parse and enforce admission
before calling any service method. GET /api/actions supports only one optional
after cursor; every mutation requires exact-origin JSON. Static routes are
only /, /app.js and /styles.css, and contain no workspace data.

~~~ts
const principal = app.sessions.authenticate(bearerToken);
const result = app.service.approve(principal, actionId, decision);
~~~

Implement the spec's fixed errors, 16 KiB header/2048-byte target/4096-byte body
bounds, connection/request timeouts and response limits. Reject response
overflow rather than truncating review data. Do not log raw errors or request
material. Set the exact CSP/no-store/nosniff/frame/referrer headers on all
response paths; omit all CORS grants.

- [ ] **Step 6: Run end-to-end decision and no-leak security cases.**

Through actual HTTP: review/approve once, reject replay, cancel the other action,
logout, and reject old tokens/receipts. Assert no action.started records and no
provider/model callbacks. Check complete command metadata and fixed expiry;
cross-action receipt use must fail. Inject title/command/error canaries and
assert unauthenticated responses, failure bodies and captured stdout/stderr do
not disclose them. Secret token strings must never appear in errors or journal
content. Verify every documented error status/security header.

Run `npm run build && node --test tests/owner-control-http.test.mjs`,
then the focused Task 1 suite and `git diff --check`. Review auth/lifecycle
races before the executing root commits the unit. Suggested commit:
`feat: add authenticated loopback owner control HTTP adapter`.

### Task 3: Responsive UI, strict CLI, synthetic acceptance and operations docs

**Files:**

- Create: `src/control/web/index.html`, `src/control/web/app.js`, `src/control/web/styles.css`
- Create: `src/control/assets.ts`, `scripts/copy-control-assets.mjs`
- Create: `src/control/demo-fixture.ts`, `src/cli/owner-control-main.ts`, `src/control-demo.ts`
- Create: `tests/owner-control-cli.test.mjs`, `tests/owner-control-demo.test.mjs`, `tests/owner-control-assets.test.mjs`
- Modify: `package.json`, `.github/workflows/ci.yml`
- Create: `docs/OWNER_CONTROL.md`, `docs/verification/2026-09-14-owner-control.md`
- Modify: `README.md`, `SECURITY.md`, `docs/ROADMAP.md`, `docs/issues/01-owner-control.md`, `docs/VERIFICATION.md`
- Reuse: Task 1 application/process-lock interfaces; Task 2 server/types; existing synthetic handlers/provider
- No version bump, credential vault, auth bypass, remote host or deployment configuration is required

**Interfaces:**

Consumes exactly `acquireLocalProcessLock(dbPath): LocalProcessLock`,
`openOwnerControl({dbPath, workspaceId, clock?}): OwnerControlApp` and
`startOwnerControlServer({app, bootstrapDirectory, assets, port?}): Promise<OwnerControlServer>`.
UI requests/responses use ControlBootstrap, ControlSession, ControlActionPage,
ControlReview, ControlDecisionInput and ControlActionSummary from the spec's
fixed HTTP table. The UI does not receive ControlPrincipal.

Produces exactly:

~~~ts
// src/control/assets.ts
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

- [ ] **Step 1: Write fresh-fixture and CLI argument/lifecycle tests, then run RED.**

Assert init-demo creates two proposed actions with exact synthetic arguments,
fixed workspace/owner and no model. A second initialization or any pre-existing
main/sidecar path must fail without modifying it. Incomplete fixtures are not
silently repaired. Test required flags, defaults, duplicate/unknown flags,
empty values, :memory:, --flag=value rejection and port bounds.

~~~js
const command = parseOwnerControlArgs([
  'serve', '--db', 'data/demo.db', '--bootstrap-dir', 'data/bootstrap'
], directory);
assert.equal(command.kind, 'serve');
assert.equal(command.workspaceId, 'owner-control-demo');
assert.equal(command.port, 0);
assert.throws(() => parseOwnerControlArgs([
  'serve', '--db', 'data/demo.db', '--bootstrap-dir', 'data/bootstrap',
  '--host', '0.0.0.0'
], directory));
~~~

Run `npm run build && node --test tests/owner-control-cli.test.mjs`.
Add subprocess tests for serve startup, clean SIGINT/SIGTERM shutdown,
cross-CLI lock refusal and working directories containing spaces. Place auth/
settings canaries and model/auth environment variables nearby; their contents
must remain untouched and must not appear in output.

- [ ] **Step 2: Implement deterministic initialization and strict CLI lifecycle.**

Hold the shared lock while checking that the database, its SQLite sidecars and
the .synthetic.sqlite sidecar family are absent. Create the synthetic-mode
workspace owner-control-demo with owner owner. Create both distinct works
before preparation, then use openSyntheticOperations and OperationService with
stable keys and the exact spec arguments. Close every provider/store handle.
Do not import Pi or instantiate even a fake model for this command.

~~~ts
const app = openOwnerControl({
  dbPath: command.dbPath, workspaceId: command.workspaceId
});
const server = await startOwnerControlServer({
  app, bootstrapDirectory: command.bootstrapDirectory,
  port: command.port, assets: loadOwnerControlAssets()
});
~~~

These lines belong to serve after strict parsing. Always pair server.close
with app.close in failure/shutdown handling. Print origin and a JSON-quoted
bootstrap path, never token contents. Register only this invocation's signal
handlers and remove them when finished; the trusted injected AbortSignal uses
the same shutdown path. Restart is the only way to re-pair.

- [ ] **Step 3: Create static assets and deterministic asset packaging.**

Implement scripts/copy-control-assets.mjs with fixed source/destination paths
resolved relative to import.meta.url. Copy only index.html, app.js and styles.css
into dist/control/web after tsc. loadOwnerControlAssets reads only those fixed
packaged paths, so a checkout with spaces works. No filesystem wildcard router.

~~~json
{
  "build": "tsc -p tsconfig.json && node scripts/copy-control-assets.mjs",
  "owner-control": "npm run build && node dist/cli/owner-control-main.js",
  "owner-control:demo": "npm run build && node dist/control-demo.js"
}
~~~

Merge these keys into the existing scripts; retain all current scripts and
dependency pins. tests/owner-control-assets.test.mjs checks the packaged assets
are nonempty, fixed paths work after copying dist to a spaced checkout, and the
HTML has no external asset dependencies. Do not substitute static string tests
for browser behavior claims.

- [ ] **Step 4: Implement the complete pairing/list/review/decision UI.**

Use a file input for the strict bootstrap document, validate its origin against
window.location.origin, exchange it through the real bootstrap POST, clear the
file input, and retain the session bearer only inside the module/closure.
Display restart-to-re-pair instructions. Render the action list and exact review,
including original/current work revisions, full command/digest, current
connection metadata and absolute displayed expiry. Use textContent throughout.

~~~js
const response = await fetch(path, {
  method: 'POST',
  credentials: 'omit',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer ' + token
  },
  body: JSON.stringify(body)
});
~~~

Here path/token/body are private UI request-function parameters, not URL/query
credentials. Explicit buttons invoke review, approve, cancel, refresh and
sign-out; no inline event handlers or auto-submit. Disable decisions while
pending; never retry a mutation automatically. Expired/replaced receipts and
conflicts require a new review. Show approval/cancellation success only from
the server response. On sign-out, state that existing approvals persist, clear
session/review memory and return to pairing.

Create readable desktop and 390 px layouts, semantic labels and keyboard
navigation. Wrap full commands/digests without truncation. Show the
synthetic/local boundary and that approval does not execute an operation.

- [ ] **Step 5: Write the actual-server acceptance demo test RED.**

~~~js
const result = await runOwnerControlDemo();
assert.deepEqual(result, {
  mode: 'local-owner-control',
  realModelCalls: 0,
  realExternalEffects: 0,
  authenticatedDecisions: 2,
  rejectedApprovalReplays: 1,
  verifiedSyntheticActions: 1,
  cancelledActions: 1,
  journalReplaysMatch: true
});
~~~

Run `npm run build && node --test tests/owner-control-demo.test.mjs`.
Test CLI stdout separately: it contains only a summary and no token/file
contents. Do not accept an in-process direct service call as HTTP acceptance.

- [ ] **Step 6: Implement the demo through the production HTTP boundary.**

Use a fresh private temporary directory, initializeOwnerControlDemo, the actual
packaged assets and startOwnerControlServer. Read the private bootstrap file in
the trusted demo, exchange it via actual HTTP, list/review/approve the contact
action, reject a replay, review/cancel the subscription action and logout.
Assert no action.started before server shutdown. Then close server/app,
reacquire the shared lock, open the persistent synthetic provider, execute and
verify only the approved contact, and assert cancelled dispatch is rejected.

~~~ts
await operations.execute({
  workspaceId: fixture.workspaceId,
  ownerId: fixture.ownerId,
  actionId: fixture.approveActionId
});
await operations.verify({
  workspaceId: fixture.workspaceId,
  ownerId: fixture.ownerId,
  actionId: fixture.approveActionId
});
~~~

operations here is the existing OperationService wired to the persistent
synthetic handler registry after the HTTP process lifecycle closes. No model
gateway is involved. Check exactly one started event, satisfied verification,
one cancelled action and replay/reopen equality. Return the exact result type;
cleanup only the demo's owned temporary directory after all handles close.

- [ ] **Step 7: Add user documentation and the CI acceptance command.**

docs/OWNER_CONTROL.md must include runnable init/serve/demo commands, selecting
the pairing file, exact approval/cancellation/expiry behavior, restart to
re-pair, shutdown, shared-lock recovery and existing approvals surviving
logout/restart. Explain loopback-local identity and responsive-layout limits:
no phone connection or production privacy is claimed. Document that trusted
filesystem ancestors are an operator precondition, not a validated ancestor
chain: ancestor replacement can defeat path and file ownership assumptions.

Update README implementation status, SECURITY, ROADMAP and issue 01 with this
partial deliverable. Keep genuine live-model acceptance, remote authentication,
Pi credential/settings protection, real-message preview and real-provider gates
open. State that persistent synthetic data remains plaintext and the HTTP
surface has no model/login/execute route.

Add `npm run owner-control:demo` to the existing .github/workflows/ci.yml job,
retaining Node 22.19.0 and 24.x, existing checks and permissions. In
docs/verification/2026-09-14-owner-control.md record commands actually run,
results, source revision/dirty state and browser/CI limitations; do not describe
configured CI as already passing. Point `docs/VERIFICATION.md` at this current
report while retaining the earlier verification records as historical evidence.

- [ ] **Step 8: Run final gates and attempt supported browser QA.**

Run `npm run check`, `npm run demo`, `npm run operations:demo`,
`npm run owner-control:demo` and `git diff --check`. Inspect results before
claiming completion. Use the actual running listener, fresh bootstrap and real
UI for browser QA if supported connectivity permits it. Inspect pairing,
keyboard controls, 390 px review layout and successful approve/cancel states.
If browser tools cannot reach the loopback server or provide the pairing file,
record precisely that limitation; keep mandatory actual-HTTP tests. Never add
a test-login endpoint, fixed secret or remote exposure to get a screenshot.

Review the finished change at high effort, including lifecycle failure paths,
private files, state races, XSS and CSRF boundaries. Fix concrete findings and
rerun affected tests plus required gates. The executing root controls commits,
PR publication, observed CI and merge under the existing owner authorization.
Suggested unit commit:
`feat: ship local owner control UI and synthetic acceptance demo`.

## Plan self-review and completion evidence

Before implementation, compare the spec's interface blocks with the three
tasks. The shared names are OwnerControlSessions, OwnerControlService,
OwnerControlApp, startOwnerControlServer, initializeOwnerControlDemo and
runOwnerControlDemo. Expiry values remain five minutes/bootstrap, two
minutes/review, ten minutes from review/approval, fifteen minutes/idle session,
and one hour/absolute session. There is no re-pair API or stdin pair command.

Each spec requirement maps to Task 1 state/ownership, Task 2 transport/files,
or Task 3 operation/UI/documentation. A unit's acceptance evidence must include
its real behavior tests, not only successful typechecking. The final user
report distinguishes working local HTTP control, any observed browser QA,
actual CI status and all remaining remote/live/privacy gates.
