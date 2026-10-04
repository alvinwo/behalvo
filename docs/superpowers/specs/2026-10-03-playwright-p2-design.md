# Playwright P2 — authorized synthetic browser actions

Status: approved for implementation by independent Sol-high design/security review
on 2026-10-03 after Astra-max architecture planning. Base: merged P1 `6b6ef82`, checkpoint `3aae3aa`. The owner delegates
technical approval to specialists; this document grants no publication permission.

## Outcome and constraints

Run the existing synthetic monitored-action workflow in an application-owned,
visible Chromium browser through `SyntheticMonitoringBrowserFactory`. The service
continues to own review, arm, scheduling, reservation, durable intent, execution,
verification and journal reduction. Playwright supplies actual DOM observations
and the existing six typed form commands. No generic model-to-Playwright interface.

The explicit entry point is `npm run browser:playwright -- synthetic-actions`:
a bounded scripted acceptance run through the normal paired local control API,
including simulated human challenge completion. P1 `diagnostic` remains read-only;
compiled extension acceptance remains separate evidence.

- Node `>=22.19.0`; Playwright exactly `1.63.0`; its installed Chromium build.
- Origin exactly `http://127.0.0.1:43117`, fixture `visa-beijing-group-v1`; no port
  fallback or attachment to an existing portal/browser/profile/CDP connection.
- Visible `launchServer`, private loopback ephemeral endpoint and exact owned
  disposable profile. Preserve P1 environment refusal, sole CLI signal ownership,
  late-launch cleanup and receipt semantics. No private Playwright internals.
- Context: `javaScriptEnabled: false`, `serviceWorkers: 'block'`,
  `acceptDownloads: false`. Fixed trusted DOM evaluations are permitted.
- Startup `15_000 ms`; each observation/gesture `10_000 ms`; retirement/shutdown
  `5_000 ms`; entire acceptance run `180_000 ms` plus `5_000 ms` shutdown.
  Effective operation deadline is the earliest local, caller and run deadline.
- No retry, redirect following, arbitrary URL/selector/script/options, real
  accounts/sites, model call or paid resource. No OS network-sandbox claim.
- New visible CLI copy uses the English message catalog. No domain schema change;
  domain mutation stays journaled and replay never executes effects.

## Architecture and interfaces

Keep the [factory contract](../../../src/service/config.ts),
[typed protocol](../../../src/browser/types.ts),
[synthetic execution adapter](../../../src/adapters/us-visa-china/adapter.ts) and
[service-owned session](../../../src/service/synthetic-monitoring.ts). The kernel
remains independent of Playwright; transports never read SQLite or grant policy.

Extract only launch/cleanup from `playwright-owner.ts` into internal
`playwright-process-owner.ts`. Its `start<T>(install: (browser: Browser,
signal: AbortSignal, deadline: number) => Promise<T>)` returns
`Promise<{ value: T; browserVersion: string }>`; `close`, `receiptPath` and
`finishReceipt` retain P1 semantics. Keep P1 page policy in its existing wrapper.
Add `playwright-actions-owner.ts` for the separate P2 context/transport,
`playwright-actions-dom.ts` for fixed DOM operations,
`playwright-actions-transport.ts` for protocol/permits/epochs, and
`playwright-actions-demo.ts` for bounded synthetic supervision.

The P2 owner exposes the same internal `start`, `close`, `receiptPath` and
`finishReceipt` shape as the P1 owner, but its ready result contains
`BrowserSessionTransport`, tab `1` and browser version. Raw Browser/Page objects
never enter control APIs, model tools, CLI arguments or result receipts.

## Actual browser requests, without redirects

The probe found that a fulfilled 303's subsequent GET did not re-enter the context
route. Consequently P2 must not fulfill or follow redirects.

`startSyntheticPortal` gains `formResponse?: 'redirect' | 'document'`, default
`redirect`. In `document` mode the existing `POST /gesture` applies the typed
command and directly returns the actual resulting HTML using the same renderer
as root GET: status `200`, or `403`/`429` only for rendered `forbidden`/`rate_limited`.
No redirect or `Location` header. Default 303 behavior and its tests stay intact.

Document-mode form bodies require one reserved `_behalvo_dispatch` field, a random
64-character lowercase hex token. The server validates/removes it before strict
`parseBrowserGesture`; missing/duplicate/malformed/other extra fields fail. Default
redirect mode retains its existing fields. The token is correlation only, never
authorization, a credential, or provider idempotency.

Allowed document URLs are exact root `/` and `/gesture`, with no credentials,
query or fragment. An owned one-use load permit allows GET root for initial load,
fresh service start or candidate resume. GET `/gesture`, `/api/*`, subframes,
popups, workers, WebSockets, downloads and other resources/origins are denied.
Unexpected requests invalidate pending permits. Unsolicited navigation, new
frames/pages, closure or disconnection makes the transport terminal.

Permitted requests use `route.fetch({ maxRedirects: 0, maxRetries: 0,
timeout: remaining })`, never `route.continue`. Reject redirects, `Location`,
unexpected URL/status/content type and oversized bodies before fulfill. Limits:
HTML `262_144` UTF-8 bytes; form `8_192` bytes; parsed snapshots retain the existing
`32_768`-byte protocol bound. Body collection is deadline-bounded; these checks do
not claim a streaming memory limit inside Playwright.

## Source document and one-use dispatch

Observe exactly one actual `main[data-behalvo-page-state]`. A fixed bounded DOM
reader extracts allowlisted attributes/controls and validates them with
`parseBrowserSnapshot`. Reuse the extension's field contract without coupling
P2 to extension execution. Portal APIs/fixture state are not browser evidence.
Reject duplicate/missing/mismatched controls and malformed snapshots.

A transport-generated document ID changes only on a committed main-frame
navigation. Capture the exact source ElementHandle, Page, main frame and document
revision; recheck them after every asynchronous preparation. Complete DOM evaluation before
activating the form: a paused navigation request can block renderer evaluation.
The route checks captured local document revision and handles, frame and exact
one-use token without another renderer round trip. Never trust a
page-provided document ID. Gesture responses contain the observed **source**
snapshot/document ID: existing `gestureAndWaitForNavigation` then recognizes the
new destination document. Returning the destination as source would wait for an
extra navigation.

Only one operation runs at a time. Validate the full protocol envelope, original
profile/connection/service binding, tab `1`, exact next sequence, epoch, expected
page state and command. A permit binds those fields, the exact source handles,
command body, random token, signal and deadline.

1. Capture exactly one matching real form/button. A single fixed handle evaluation
   checks current-document ownership, sets the exact `booking.intent` value if
   needed, adds `_behalvo_dispatch`, and invokes `form.requestSubmit(button)` once.
   No locator-click retry, synthesized Node POST or `/api/gesture` fallback.
2. The route captures that permit object; validate navigation request, Page/frame,
   exact URL/method/Origin/content type, duplicate-free fields, exact command and
   token. Send the browser's actual body unchanged. Old callbacks cannot borrow
   a later permit, even for an identical command.
3. After all asynchronous validation, obtain `await authorize()`. Recheck local
   document/epoch/permit state, call its synchronous guard, consume the permit and
   invoke `route.fetch` in the same JavaScript turn, with **no await between these
   last operations**. A failed guard aborts the route and dispatches zero POSTs.
4. Calling `route.fetch` is the possible-external-dispatch boundary. Validate and
   fulfill once; duplicates, late callbacks and retries never dispatch again.

Browser IPC may perform local DOM work after cancellation. The enforceable
external authority boundary is the intercepted POST, not an atomic cross-process
click. The token proves which fixed form invocation produced a request; it does
not replace source checks or durable authorization.

## Fresh synchronous durable authorization

Add optional `assertDispatchCurrent?(): void` to `TrustedExecutionFence`, separate
from `assertSettlementCurrent` (which intentionally permits deadline settlement).
Add `requireDispatchGuard?: boolean` to `BrowserSessionOptions`, default `false`.
Synthetic service composition sets it `true` for both compiled and P2 factories.
The returned synchronous browser guard requires/calls this hook and rechecks the
captured session/epoch owner, generation, signal and deadline. Navigation and
monitoring fence wrappers preserve it. A missing hook fails closed.

The runtime hook synchronously reads the workspace's current service job and
requires `running`, exact job/claim/instance IDs, active job/service generation,
healthy storage, un-aborted signal and live deadline. Monitoring then re-reads:

- Observation: current active monitor/in-flight job, exact active unexpired grant
  digest/revision, current arm plan/work revision, active exact connection/profile/
  installation. This applies to calendar pagination POSTs too.
- Execution: current running action, exact digest/attempt/reservation and blocked
  grant, current work revision, active exact connection/profile/installation,
  unrevoked/unexpired grant. Existing encrypted durable intent must already match
  the action/attempt before the adapter's intent/select/submit sequence starts.
- Readback: existing verification-only policy for exact `unknown`/`accepted`
  action/attempt/reservation and active matching connection/installation. Keep
  mutation-only expiry/work-phase restrictions out of this readback policy.

Use one synchronous read-only domain predicate per policy for both async preflight
and dispatch; recheck parent lifecycle around it. Do not call `#usableGrant`'s
journal-writing expiry branch inside the dispatch predicate. Normal service
policy journals expiry/settlement. No await, callback scheduling or DB write occurs
between final authorization and dispatch. Tests must mutate durable authority
between async authorization and guard invocation, including changes without an
AbortSignal, and prove zero portal POSTs.

## Handoff, restart and unknown outcomes

Transport states: unbound, active, retiring, human, terminal. First recognize
binds sequence `1`; keep retired epoch tombstones, capped at `1_024`, terminating
at the cap instead of forgetting replay protection.

`revoke` invalidates unused permits synchronously, retires the exact owned epoch
and settles pending handlers within `5_000 ms`. Idle confirmed retirement keeps
this isolated browser for the synthetic human checkpoint. An already-dispatched
operation may remain unknown. Unsettled retirement rejects and makes transport
terminal with owned cleanup; it must not acknowledge a clean handoff.

The existing service persists pause before revocation and releases its worker
through its lifecycle. After confirmed retirement, candidate recognize sequence
`1` performs a fresh controlled root GET; candidate inspect sequence `2` verifies
fresh bindings. The service's existing preflight/commit adopts that epoch. No
service gesture runs during candidate preflight. A failed candidate must itself
retire; ambiguity leaves the monitor faulted. Reload destroys old source handles.

`reconcileRevocation` succeeds only for an exact already-confirmed retired epoch
owned by this transport and service generation. It always rejects historical
generations and unowned/unknown resources. A fresh browser cannot certify old
browser retirement.

Restart scope is deliberately concrete: one in-memory acceptance supervisor,
clean service stop plus exact owner cleanup confirmation before another factory
launch, fresh browser/profile for each service generation, same synthetic portal
state and encrypted service database. Register owners immediately on construction,
including partial starts. Inspect every `allSettled` result; rejected service or
session close is not successful cleanup. Aggregate run confirmation includes
service, browser and portal. Pending cleanup retains the P1 receipt, ends the run
and forbids another launch. Never scan/kill broad processes, delete guessed
profiles, or infer that a timed-out launch never created resources.

The current runtime shutdown folds browser `allSettled` outcomes into an
unconditional settled value. Fix that boundary: `shutdown(): Promise<boolean>`
returns `true` only when its active work and every browser shutdown fulfilled
within budget, and `false` for rejection or timeout. Preserve the local service's
shared shutdown promise and require an actual `true` before supervisor restart.

Cold supervisor restart and historical ownership receipt recovery are deferred.
Confirmed clean restarts are supported; persisted ambiguous handoff retirement
remains fail-closed. This is not machine-crash durability evidence.

Keep durable reservation and encrypted intent before external booking operations.
After possible dispatch, timeout/abort/network failure/rejected response/document
loss is unknown, never proof of nonexecution. Existing action policy quarantines
unknown and blocks allowance reuse. No submit retry or late journal write.
Transport failure terminates that transport; consume late promises. After exact
owned cleanup, the same supervisor can restart for existing verification-only
readback. Only rendered authoritative appointment data matching intent, identity,
roster, slot and reference resolves success; absent/mismatched readback stays
unknown. Normal rendered `ambiguous_submission` also uses existing readback.
Replay/rebuild invokes no browser factory and changes no provider counters.

## Evidence and implementation gate

Disposable local probes used Playwright `1.63.0` / Chromium `153.0.8010.12`:
303 produced a follow-up GET outside route interception; redirect-free HTML
produced one browser POST, one initial GET and one guard with JavaScript disabled;
revoking a held POST produced zero dispatched POSTs. Each reported confirmed
cleanup. Raw ignored evidence is in `data/verification/playwright-p2/`. These are
mechanism probes, not product acceptance or proof of the complete protocol.

The first implementation task turns these assumptions into maintained tests
against the actual document-mode portal: source/token attribution, exact one POST,
redirect refusal and zero off-origin sentinel requests. Failure stops action
implementation for design revision; no redirect/API fallback.

Final acceptance must cover paired review/arm, empty poll, coalesced clean restart,
human pause/resume, disappeared candidate, one booking and rendered readback;
durable authority races; duplicate/stale/late requests; postdispatch unknown with
no resubmit; absent/mismatched readback; historical retirement refusal; rejected
and late cleanup; replay without effects. P1 tests and visible diagnostic must
still pass. Run `npm run verify` and opt-in visible P2 acceptance on macOS, record
actual commit/results, and obtain independent implementation/security reviews
before an authorized merge. Headless/synthetic-only tests are not visible desktop
acceptance. Result receipts contain fixed codes and synthetic counts, not page
bodies, tokens, endpoints or arbitrary exceptions.

See the [implementation plan](../plans/2026-10-03-playwright-p2.md),
[architecture](2026-09-07-architecture-v0.md),
[P1 design](2026-10-03-playwright-browser-adapter-design.md),
[security](../../../SECURITY.md) and
[development workflow](../../../.agents/skills/behalvo-development/SKILL.md).
