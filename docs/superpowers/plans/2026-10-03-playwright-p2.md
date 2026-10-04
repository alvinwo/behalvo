# Playwright P2 Synthetic Actions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Demonstrate authorized synthetic scheduling through a visible owned
browser, with durable authorization at dispatch and no retry of unknown effects.

**Architecture:** Keep the existing service-owned `BrowserSession`, monitoring,
reservation and verification paths. A separate P2 transport submits actual DOM
forms through one-use intercepted request permits; synchronous service fences
supply final authority. Share only process ownership with the P1 adapter.

**Tech Stack:** Node.js, TypeScript, SQLite journal/projections, Playwright/Chromium,
Node's test runner, existing synthetic portal and paired local control API.

**Spec:** [Playwright P2 design](../specs/2026-10-03-playwright-p2-design.md).
Status: independent Sol-high design/security review approved implementation on 2026-10-03.
The owner has delegated technical approval, so route findings to the designated
specialists rather than asking the owner to review code.

## Global Constraints

- Node `>=22.19.0`; Playwright exactly `1.63.0`; its installed Chromium build.
- Origin exactly `http://127.0.0.1:43117`; fixture `visa-beijing-group-v1`.
- Context: `javaScriptEnabled: false`, `serviceWorkers: 'block'`,
  `acceptDownloads: false`; visible browser and disposable owned profile only.
- Startup `15_000 ms`; each observation/gesture `10_000 ms`; retirement/shutdown
  `5_000 ms`; run `180_000 ms` plus `5_000 ms` shutdown. Earlier caller deadlines
  and cancellation win. No retry or redirect following.
- HTML `262_144` UTF-8 bytes; form `8_192` bytes; parsed snapshots `32_768` bytes;
  `_behalvo_dispatch` exactly 64 lowercase hex characters; at most `1_024` retired
  epoch tombstones, then terminate without evicting old tombstones.
- P1 remains read-only. No personal profiles, real sites/accounts, models, paid
  resources, generic browser tools or publication. No new domain schema/events.
- Work in a feature branch, behavior tests before executable changes. New visible
  text uses the English catalog and the app-i18n skill. Update operational status
  only when implemented and verified; record actual evidence, not configured CI.

## Review Focus

1. A durable change with no abort notification lands after async preflight:
   the synchronous guard rejects before dispatch. Covered by Task 2.
2. A fulfilled redirect, duplicate POST or late old-document request bypasses the
   active permit: zero extra/off-origin dispatches. Covered by Tasks 1 and 3.
3. A rejected close/late launch is mistaken for retirement, allowing a new browser:
   retain pending receipt and refuse new launch. Covered by Tasks 1 and 4.
4. The service sends candidate epoch sequence 1/2 before adopting resume, or a
   fresh transport receives a historical retirement request: fresh read preflight
   works; unowned retirement fails closed. Covered by Tasks 3 and 4.
5. Submit reaches the provider but response/readback is lost: unknown, no resubmit,
   and only exact rendered readback resolves it. Covered by Tasks 3 and 4.

---

## Task 1: Prove the redirect-free form and shared ownership boundary

**Files:**

- Modify: `src/synthetic-portal/server.ts`, `src/browser/playwright-owner.ts`.
- Create: `src/browser/playwright-process-owner.ts`.
- Create tests: `tests/synthetic-portal-document.test.mjs`,
  `tests/playwright-actions-mechanics.test.mjs`.
- Reuse regression tests: `tests/playwright-*.test.mjs`.

**Interfaces:**

- Preserve `startSyntheticPortal` result `Promise<SyntheticPortalServer>`; add
  optional input `formResponse?: 'redirect' | 'document'`, default `'redirect'`.
- Produce internal `PlaywrightProcessOwner` constructed with
  `{ signal: AbortSignal }` and existing `PlaywrightOwnerDependencies`.
  `start<T>(install: (browser: Browser, signal: AbortSignal, deadline: number) =>
  Promise<T>): Promise<{ value: T; browserVersion: string }>`; preserve
  `close(): Promise<PlaywrightCleanup>`, `receiptPath: string`,
  `finishReceipt(confirmed: boolean, code: PlaywrightFailureCode | null,
  success: boolean): void`.
- Keep existing P1 owner constructor/start/exports compatible. Re-export moved
  dependency/cleanup types from `playwright-owner.ts` to avoid caller churn.

- [ ] Write portal contract tests before changing its handler. Assertions:

  ```js
  // document_mode_returns_actual_destination_without_redirect
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('location'), null);
  assert.match(await response.text(), /data-behalvo-page-state="calendar"/);
  // document_mode_rejects_missing_duplicate_or_extra_dispatch_fields
  assert.equal(invalidResponse.status, 400);
  // default_form_contract_still_redirects
  assert.equal(legacyResponse.status, 303);
  ```

- [ ] Run `npm run build && node --test tests/synthetic-portal-document.test.mjs`.
  Expect the new document-mode behavior to fail against the current 303 handler.
- [ ] Add the explicit mode, strict token-field validation and shared HTML response
  helper. Preserve legacy fields, CSP, Origin checks and no-store headers.
- [ ] Write opt-in visible mechanism tests using the actual document-mode portal.
  Use `BEHALVO_PLAYWRIGHT_P2_ACCEPTANCE=1` to opt in; default test runs skip visible
  browser launch. Test fixed handle `requestSubmit` with JavaScript disabled,
  source handle/token attribution, one POST/one initial GET/one final guard,
  redirect response rejected before fulfill and zero sentinel-origin requests.
  Hold a browser POST, invalidate its permit and release: assert zero portal POSTs.
  Expected observed destination URL is exactly `${origin}/gesture`, a new document.
- [ ] Run the mechanism test before the production transport exists; it is the
  feasibility gate, not an action implementation. If it fails, stop and revise
  the design; do not implement a Node POST or redirect fallback.
- [ ] Extract existing process ownership without changing P1 behavior. Add/retain
  tests for late launch, startup cancellation, repeated close sharing one promise,
  close rejection, exact process/profile absence and pending receipts. Install
  callbacks run under the original startup deadline and inherit late cleanup.
- [ ] Run `npm run build && node --test tests/synthetic-portal-document.test.mjs
  tests/playwright-*.test.mjs`, then run the visible mechanism test explicitly.
  Expect all selected tests passing, explicit visible tests executed, and cleanup
  confirmed. Record actual browser/version/probe distinctions.
- [ ] Commit only this task's files with message
  `feat: add redirect-free synthetic forms and shared browser ownership`.

## Task 2: Make final dispatch authorization synchronous and durable

**Files:**

- Modify: `src/operations/execution-context.ts`, `src/runtime/service-runtime.ts`,
  `src/monitoring/service.ts`, `src/browser/session.ts`,
  `src/service/synthetic-monitoring.ts`.
- Create test: `tests/playwright-dispatch-authority.test.mjs`.

**Interfaces:**

- Produce `TrustedExecutionFence.assertDispatchCurrent?(): void`.
- Produce `BrowserSessionOptions.requireDispatchGuard?: boolean`, default `false`;
  synthetic service composition sets it `true` for every factory implementation.
- Preserve `BrowserSessionTransport.gesture(request, authorize, authority)`;
  `authorize: () => Promise<() => void>` now returns a guard that invokes the
  required hook and then rechecks session/epoch/signal/deadline.
- Runtime/monitoring produce the hook; transport consumes only the existing
  callback. `assertSettlementCurrent` retains its different settlement semantics.

- [ ] Write behavior tests using a real temporary encrypted SQLite store and a
  held fake transport, not implementation-mirroring mocks. Cover current job
  claim/instance replacement, action/attempt/reservation change, grant revision,
  revocation/expiry, connection generation/status, work revision, installation,
  service generation, signal/deadline and missing required hook. Between async
  authorization and synchronous guard execution, change durable authority:

  ```js
  // durable_change_after_async_preflight_blocks_dispatch
  const guard = await authorize();
  changeDurableAuthority();
  assert.throws(() => guard());
  assert.equal(dispatchedPosts, 0);
  // navigation_and_monitor_wrappers_preserve_dispatch_guard
  assert.equal(finalGuardCalls, 1);
  // readback_retains_verification_only_policy
  assert.equal(readbackDispatches, 1);
  assert.equal(submitDispatches, 0);
  ```

- [ ] Run `npm run build && node --test tests/playwright-dispatch-authority.test.mjs`;
  expect the stale durable authority and missing-hook cases to fail before changes.
- [ ] Add the hook and runtime exact current `running` job/claim/instance checks
  through `store.serviceJob(workspaceId, job.id)`. Check fatal storage, active
  generation/job, signal and wall-clock deadline synchronously.
- [ ] Extract read-only synchronous monitoring predicates reused by async and
  final checks: observation checks active monitor/in-flight job/current arm plan,
  work/grant/connection/profile/installation; reserved execution checks the exact
  running action/attempt/reservation and mutation authority; readback preserves
  existing unknown/accepted verification policy. Check encrypted intent ordering
  before adapter execution. Do not invoke journal-writing `#usableGrant` expiry
  handling inside a dispatch guard.
- [ ] Preserve/invoke the hook through monitoring controller wrappers, reserved
  action fences and `gestureAndWaitForNavigation`'s navigation fence. Configure
  synthetic sessions to require it. Do not alter unrelated callers' default.
- [ ] Run the new test, `npm run check`, and `npm run service:demo`. Expect the
  existing compiled workflow passing under mandatory synthetic dispatch hooks.
- [ ] Commit the task with message `fix: recheck durable authority at browser dispatch`.

## Task 3: Implement the strict action transport and epoch lifecycle

**Files:**

- Create: `src/browser/playwright-actions-dom.ts`,
  `src/browser/playwright-actions-transport.ts`,
  `src/browser/playwright-actions-owner.ts`.
- Modify: `src/browser/playwright-errors.ts` to add fixed `action_timeout` for
  gesture/run budget exhaustion; keep arbitrary upstream errors out of receipts.
- Create tests: `tests/playwright-actions-transport.test.mjs`,
  `tests/playwright-actions-acceptance.test.mjs`.

**Interfaces:**

- `PlaywrightActionsTransport implements BrowserSessionTransport`, constructor
  input `PlaywrightBinding & { page: Page; signal: AbortSignal;
  runDeadline: number; close: () => Promise<void> }`;
  `initialize(deadline: number): Promise<void>` installs policy before its first
  controlled root load. Existing transport method signatures stay unchanged.
- `PlaywrightActionsOwner`, constructor input
  `PlaywrightBinding & { signal: AbortSignal; runDeadline: number }`, optional
  `PlaywrightOwnerDependencies`; `start(): Promise<{ transport:
  PlaywrightActionsTransport; tabId: 1; browserVersion: string }>` plus shared
  owner `close`, `receiptPath`, `finishReceipt` methods.
- DOM module produces `capturePlaywrightSource(page: Page): Promise<{
  root: ElementHandle<HTMLElement>; snapshot: BrowserPageSnapshot }>` and
  `preparePlaywrightForm(root: ElementHandle<HTMLElement>, command:
  BrowserGestureCommand): Promise<{ form: ElementHandle<HTMLFormElement>;
  button: ElementHandle<HTMLButtonElement> }>`.
  `activatePlaywrightForm(prepared, command: BrowserGestureCommand,
  dispatchToken: string): Promise<void>` performs only the fixed evaluation.
  Export the returned preparation shape as `PreparedPlaywrightForm` and use that
  name for the activation argument. Transport bounds/rechecks every awaited call.

- [ ] Write transport tests covering every typed snapshot/command and strict
  envelope/sequence binding; duplicate/malformed/oversized DOM and forms; wrong
  Page/frame/origin/URL/body/token; response redirect and wrong content type;
  stale source handle/document; concurrent operation; cancelled/expired permit;
  duplicate and late request after a later permit. Key assertions:

  ```js
  // duplicate_or_stale_request_cannot_consume_a_later_permit
  assert.equal(portalPosts, 1);
  // gesture_returns_source_then_session_observes_new_document
  assert.notEqual(destination.documentId, source.documentId);
  assert.equal(gestureResponse.documentId, source.documentId);
  // historical_reconciliation_never_claims_retirement
  await assert.rejects(freshTransport.reconcileRevocation(oldEpoch, 1));
  // same_run_resume_reads_candidate_sequences_one_and_two
  assert.deepEqual(candidateSequences, [1, 2]);
  assert.equal(candidateGestures, 0);
  ```

- [ ] Run `npm run build && node --test tests/playwright-actions-transport.test.mjs`;
  expect failure until the new module/contracts exist.
- [ ] Implement fixed bounded DOM extraction using `parseBrowserSnapshot` and
  exactly matching existing attributes. Implement fixed form handles and a single
  `requestSubmit` evaluation that inserts the token and exact intent value.
- [ ] Implement load/dispatch permits and routes. Route captures its original
  permit; async preparation finishes before `await authorize()`, then local
  checks, synchronous guard, permit consumption and `route.fetch` occur without
  an intervening await. Validate/fulfill the browser-originated response once;
  never rewrite POST body or follow redirects. Preserve actual source-response
  semantics and observe the destination separately.
- [ ] Implement epoch states/tombstones and exact retirement. Candidate resume
  starts with fresh GET plus reads at sequence 1/2 after confirmed retirement;
  failed candidate retirement remains faulted. Reconciliation accepts only exact
  confirmed same-owner/same-generation tombstones. Timeout/abort after possible
  dispatch terminates the transport and cannot become a definitive failure or
  retry. Bound revocation/close and consume late promises without callbacks into
  completed service jobs.
- [ ] Add visible acceptance tests, enabled by the same opt-in variable, against
  actual document-mode HTML for the form/source/route cases above. Include held
  POST revocation, duplicate route, document change during authorization, response
  lost after provider mutation and forbidden/rate-limited rendered destinations.
- [ ] Run the transport test and visible actions acceptance test, plus P1 browser
  tests. Expect zero unexpected/sentinel POSTs, exact command counts, correct
  source/destination observations and confirmed owned cleanup.
- [ ] Commit the task with message `feat: add fenced synthetic Playwright actions`.

## Task 4: Compose the supervised service workflow and publish precise evidence

**Files:**

- Create: `src/browser/playwright-actions-demo.ts`,
  `tests/playwright-actions-service.test.mjs`,
  `docs/verification/2026-10-03-playwright-p2.md`.
- Modify: `src/cli/playwright-main.ts`, `src/cli/playwright-messages.ts`,
  `src/runtime/service-runtime.ts`, `README.md`, `SECURITY.md` and the
  implementation status in `docs/superpowers/specs/2026-09-07-architecture-v0.md`.
- Reference `src/service-demo.ts` for paired control setup/review/arm and scenario
  progression; extract small shared helpers only if needed, preserving its output.

**Interfaces:**

- `runPlaywrightActionsDemo(input: { signal: AbortSignal }):
  Promise<PlaywrightActionsResult>`; trusted test dependencies may shorten budgets
  or supply fixture owners/services, never via CLI/model input.
- `PlaywrightActionsResult`: success has `ok: true`, `synthetic: true`,
  `cleanup: 'confirmed'`, `playwrightVersion: '1.63.0'`, `browserVersion: string`
  and checked booleans for `emptyPoll`, `cleanRestart`, `handoffResume`,
  `candidateRace`, `singleBooking`, `authoritativeReadback`, `replayNoEffects`.
  Failure has `ok: false`, fixed `code: PlaywrightFailureCode`,
  `cleanup: 'confirmed' | 'pending'` and optional exact `receiptPaths: string[]`.
- Factory retains `(context: Readonly<SyntheticMonitoringBrowserContext>) =>
  Promise<{ transport: BrowserSessionTransport; tabId: number }>`; supervisor
  closes over workspace, run deadline, cancellation and its exact owners.
- `ServiceRuntime.shutdown(): Promise<boolean>` retains its signature, but
  returns `true` only when active work and every browser shutdown fulfilled
  within budget; rejection/timeout returns `false` and prevents restart.

- [ ] Write composed-service tests first. Use a fresh encrypted temporary store,
  fixed synthetic portal and normal paired control API for proposal/review/arm.
  Cover empty poll; one coalesced overdue poll after clean restart; persisted
  challenge pause and fresh candidate resume; candidate withdrawn before
  reservation; later candidate booked once and verified from rendered readback.
  Assert only one provider mutation and settled allowance; replay/rebuild leaves
  browser factory/POST/provider counters unchanged.
- [ ] Add unknown/readback tests: provider mutated but response lost -> unknown and
  no second submit; after confirmed cleanup and fresh service/browser, exact
  authoritative readback resolves; missing/mismatched readback stays unknown.
  Cover rejected service/session/owner close, one rejected `allSettled` member,
  owner registered before partial startup, late launch and historical handoff.

  ```js
  // pending_cleanup_blocks_next_factory_launch
  assert.equal(nextOwnerStarts, 0);
  assert.equal(result.cleanup, 'pending');
  // postdispatch_timeout_never_resubmits
  assert.equal(providerMutations, 1);
  assert.equal(bookingSubmitPosts, 1);
  assert.equal(action.status, 'unknown');
  // replay_is_read_reduce_only
  assert.deepEqual(countersAfterRebuild, countersBeforeRebuild);
  ```

- [ ] Run `npm run build && node --test tests/playwright-actions-service.test.mjs`;
  expect failure before the supervisor and result contracts are implemented.
- [ ] Implement the bounded supervisor and fresh owner factory. Register owners
  immediately on construction. Permit restart only after both service stop and
  exact owner cleanup confirm. Keep portal state/DB across clean service restart;
  retain receipts and exit on any pending cleanup. No cold-process recovery or
  historical receipt adoption. Reuse existing action unknown/readback rules.
- [ ] Fix runtime shutdown's current loss of browser `allSettled` member failures;
  evaluate every member and active-work outcome before returning `true`. Preserve
  the local service's shared shutdown promise. Assert a rejected member returns
  `false` and the supervisor never starts another factory from that result.
- [ ] Load app-i18n, add explicit `synthetic-actions` CLI dispatch and catalog copy;
  preserve existing diagnostic validation/output and sole SIGINT/SIGTERM/SIGHUP
  ownership. Validate result shape, use fixed failure codes and bounded exit;
  pending cleanup exits nonzero with only exact receipt paths. No raw page,
  endpoint, token or upstream exception in output.
- [ ] Run `npm run verify`; then
  `BEHALVO_PLAYWRIGHT_P2_ACCEPTANCE=1 node --test tests/playwright-actions-*.test.mjs`,
  `npm run browser:playwright -- diagnostic` and
  `npm run browser:playwright -- synthetic-actions` on visible macOS. Record
  commands, versions, exit statuses, actual executed/skipped counts, ownership
  cleanup and commit. Browser installation is an explicit local prerequisite;
  never imply a skipped acceptance test passed.
- [ ] Update implementation status, README, SECURITY and verification evidence to
  the delivered scope and explicit restart limitation. Run `git diff --check` and
  local documentation link checks. Preserve probe evidence as limited research,
  not acceptance. Review the full diff against the approved spec.
- [ ] Commit with message `feat: demonstrate authorized synthetic browser workflow`.
  Request independent implementation/security reviews at the repository-required
  routing/effort; fix supported findings and rerun affected checks. Merge or push
  only within existing owner authorization, with exact commit and actual CI status.

## Plan self-review and execution handoff

The four tasks cover the design's mechanism gate, durable dispatch authority,
DOM/epoch/unknown transport protocol, and service/lifecycle/user-visible evidence.
Each Review Focus item has an owning test step. Interface names above are the
cross-task contracts; private helper decomposition remains an implementation
choice. The product uses no new domain events, storage recovery path or generic
browser capability. Independent design/security approval is the remaining gate
before implementation; unresolved empirical failures return to the design.
