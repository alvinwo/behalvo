# Browser Exploration Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. The primary chat is the sole product/test writer under the owner's selected execution method. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove per-navigation approval prompts and recover from proven browser
pre-activation rejection while retaining real unknown-effect barriers.

**Architecture:** Extend the existing live controller, broker and exploration
loop. Version-2 browser commands record authority and exact link destinations;
fixed isolated-world receipts prove known no-dispatch failures. Existing action
evidence carries allowlisted diagnostics, and healthy recovery obtains new page
references without repeating the gesture.

**Tech Stack:** TypeScript modular monolith, Node.js >=22.19.0, existing SQLite
journal, pinned Playwright 1.63.0, `node:test` synthetic fixtures.

**Spec:** [Approved design](../specs/2026-10-14-browser-exploration-recovery-design.md).

## Global Constraints

- Keep every version-1 browser command and digest unchanged.
- No additional permission setting, agent, dependency, persistent browser profile, trace service or storage migration is introduced.
- Keep the eight-call and 120-second limits.
- Never silently repeat the original gesture.
- A timeout or cancellation settled first remains unknown; a late receipt cannot rewrite it.
- Synthetic browsing policy is unchanged.
- Use synthetic fixtures and test-first implementation.
- This work authorizes no real booking, login, unknown-action reconciliation or change to the owner's running process.

## Review Focus

- A hostile page/model labels a form action as navigation: native semantics and
  strict authority/operation validation still control which actions need review.
  Pin in Task 1.
- A different target appears after authority selection: the exact destination and
  current descriptor checks prevent dispatch to the replacement. Pin in Task 1.
- A helper reply arrives after timeout: unknown is immutable without owner
  reconciliation and no late observation or action is published. Pin in Task 2.
- The no-dispatch proof is valid but recovery observation fails: the original
  action remains failed and lifecycle cleanup is reported honestly. Pin in Task 3.
- An unknown action has no live window after restart: status and next-turn guidance
  still expose its ID without allocating a browser or calling the model. Pin in Task 3.

---

### Task 1: Standing navigation authority and durable provenance

**Files:**

- Modify: `src/kernel/browser-action.ts`
- Modify: `src/browser/live-playwright.ts`
- Modify: `src/browser/managed-session.ts`
- Modify: `src/runtime/browser-actions.ts` (authority terminology only as needed)
- Test: `tests/managed-browser-actions.test.mjs`
- Test: `tests/managed-browser-session.test.mjs`
- Test: `tests/managed-browser-acceptance.test.mjs`

**Interfaces:**

- Preserve the version-1 member of `BrowserActionCommand` exactly.
- Add version 2 with required `authority: BrowserActionAuthority`, where the
  union is `'owner_open' | 'navigation_policy_v1' | 'owner_review'`.
- Require `destination: string` only for version-2 `interact`/`navigate`.
- The private adapter-to-controller proposal supplies operation and current
  bindings/destination. The controller adds version 2 and authority before
  passing the immutable command to `BrowserActionBroker.perform`.
- Keep `perform`'s current Action/approval/started/settlement flow and trusted
  authorization callback; only the controller's owner-review path prompts.

- [ ] **Step 1: Write failing contract and controller behavior tests.** Assert
  legacy open digest remains
  `d1e65b9fa55a64b8afa18832e67a269f67a02715a535bf389e7ba89e8e86c609`;
  v2 authority/destination alter digests; invalid combinations, unknown fields and
  model-supplied authority reject. Assert automatic `visit`/native-link
  `navigate` call review zero times, while click/fill/select call it once each and
  rejected mutation dispatches zero times. Direct owner open has separate
  `owner_open` provenance. Journal action is running before target traffic.
- [ ] **Step 2: Run the focused tests and record expected RED.** Run
  `npm run build`, then
  `node --test tests/managed-browser-actions.test.mjs tests/managed-browser-session.test.mjs`.
  The new authority expectations must fail for the intended missing behavior.
- [ ] **Step 3: Implement strict v2 validation and controller authority.** Bind
  exact destination from the adapter's current descriptor; compare it at final
  dispatch. Keep all current guard checks and v1 canonical serialization. Do not
  infer policy from labels, verbs or URLs, and do not add model approval fields.
- [ ] **Step 4: Add and run product-path synthetic acceptance.** Use
  `BEHALVO_MANAGED_ACCEPTANCE=1 node --test tests/managed-browser-acceptance.test.mjs`.
  Natural chat visits/follows a link without prompt; mutation still prompts;
  destination changes after selection dispatch zero times; cookies/scope and
  effect-free replay remain intact. Replace superseded per-visit rejection tests
  with direct trusted-review regression and mutation rejection coverage.
- [ ] **Step 5: Run focused tests to GREEN and commit Task 1.** Stage only the
  files changed by this task and use `feat: authorize ordinary browser navigation`.

### Task 2: Trusted no-dispatch receipts and fixed diagnostics

**Files:**

- Create: `src/browser/live-failure.ts` (typed fixed failures and diagnostics only)
- Modify: `src/browser/live-world.ts`
- Modify: `src/browser/live-playwright.ts`
- Modify: `src/runtime/browser-actions.ts`
- Test: `tests/managed-browser-actions.test.mjs`
- Test: `tests/managed-browser-live.test.mjs`

**Interfaces:**

- `LiveWorld.dispatch(action: WorldAction): Promise<WorldDispatchReceipt>` uses
  the exact receipt union in the spec and validates the host-returned shape.
- `BrowserActionDiagnostic` contains `code` and `phase` from the spec's closed
  sets. `BrowserNoDispatchError` carries only a validated pre-activation receipt;
  other typed failures carry a diagnostic without claiming no dispatch.
- `BrowserGestureResult` retains its existing statuses and carries fixed
  diagnostics on failures. The broker can distinguish proven failed/no-dispatch
  from generic failed-before-marker and unknown-after-marker outcomes.
- `BrowserActionStopped` transports action ID, result status and diagnostic from
  the live adapter to the exploration loop. Its data contains no raw error text.

- [ ] **Step 1: Write failing broker and Chromium tests.** Add a synthetic page
  with an overlay covering a visible native link. Assert helper result is
  `not_dispatched`/`control_covered`, handler/server activation count is zero,
  broker action becomes failed even after the RPC mark, and durable evidence
  includes `validation`/`control_covered`. Cover stale control, ambiguous field and
  stale option rejection without input values in errors. Assert arbitrary helper
  exception and malformed result remain unknown after the marker.
- [ ] **Step 2: Run tests and record expected RED.** Run `npm run build`, then
  `node --test tests/managed-browser-actions.test.mjs`, then
  `BEHALVO_MANAGED_ACCEPTANCE=1 node --test tests/managed-browser-live.test.mjs`.
  The covered control currently throws and cannot supply a no-dispatch receipt.
- [ ] **Step 3: Implement receipts before activation and safe propagation.**
  Replace only the helper's known pre-activation branches with allowlisted
  returns. Keep unexpected exceptions uncertain; keep hit testing, synchronous
  validation/activation and the pre-RPC mark. Translate valid receipt to the
  trusted typed failure. Record fixed phase/code through existing action evidence.
  Attribute navigation/observation failures at their known host boundaries.
- [ ] **Step 4: Add timeout, late-reply and redaction regressions.** A timeout
  after the mark remains unknown even if a valid no-dispatch receipt arrives
  later. A dispatched gesture with unavailable fresh observation remains unknown.
  Inject synthetic secret canaries into arbitrary errors and assert they are
  absent from action evidence, returned results and diagnostics. Run the same
  focused commands to GREEN.
- [ ] **Step 5: Commit Task 2.** Stage only the files changed by this task and use
  `fix: distinguish browser rejection from uncertain dispatch`.

### Task 3: Fresh-observation recovery and actionable unknown stops

**Files:**

- Modify: `src/browser/managed-session.ts`
- Modify: `src/runtime/browser-exploration.ts`
- Modify: `src/browser/live-messages.ts`
- Modify: `src/cli/browser-commands.ts` (audit/status presentation as needed)
- Test: `tests/browser-exploration-loop.test.mjs`
- Test: `tests/managed-browser-session.test.mjs`
- Test: `tests/managed-browser-cli.test.mjs`
- Test: `tests/managed-browser-acceptance.test.mjs`

**Interfaces:**

- Only the trusted typed stopped result from Task 2 can authorize recovery.
- Existing `SemanticBrowserPort.observe` supplies the recovery observation;
  existing observation journaling supplies source provenance and fresh refs.
- Recovery transcript entry contains `actionId`, `status: 'failed'`,
  `disposition: 'not_dispatched'`, diagnostic and the fresh observation.
- `ManagedBrowserController.status(scope)` reports an absent session alongside
  durable unresolved action IDs; live session fields are optional when absent.
- The loop checks existing running/unknown browser actions for the work before
  model invocation and renders fixed action-specific barrier guidance.

- [ ] **Step 1: Write failing end-to-end recovery tests.** Through the product
  loop, encounter the covered-link fixture, receive failed/no-dispatch feedback
  and a fresh observation, select a different available link, finish, and retain
  the session. Assert zero automatic overlay dismissal, zero original activation,
  one failed action, distinct observation refs and no owner resolve requirement.
  Keep all calls in the current eight-completion/deadline budget.
- [ ] **Step 2: Run focused tests and record RED.** Run `npm run build`, then
  `node --test tests/browser-exploration-loop.test.mjs tests/managed-browser-session.test.mjs tests/managed-browser-cli.test.mjs`,
  then the real-Chromium acceptance command from Task 1. Current failure closes
  and produces generic stop text instead of recovery feedback.
- [ ] **Step 3: Implement bounded recovery and unknown guidance.** Stop closing
  a current healthy session for the allowlisted recoverable no-dispatch codes.
  Settle first, refresh once, journal, and continue the existing model loop. Do
  not redispatch. Unknown still closes and reports action ID plus `/actions` and
  `/browser resolve`, with no suggestion that another turn clears the barrier.
  Show unresolved IDs in absent-session status and short-circuit blocked browser
  turns before model/allocation. Keep clean retirement and process cleanup distinct.
- [ ] **Step 4: Add guard and failure-path regressions.** During refresh, change
  task revision, cancel or expire the execution, and fail observation. Assert no
  further gesture and no false retained/cleanup claim; proven failed remains
  failed. After unknown and replay/restart, status and next-turn guidance expose
  the same action, with zero model calls/allocation. Verify manual handoff and
  mutation rejection behavior remain honest and bounded. Run focused tests to
  GREEN.
- [ ] **Step 5: Commit Task 3.** Stage only the files changed by this task and use
  `fix: recover browser exploration after rejected controls`.

### Task 4: Documentation, verification and independent review

**Files:**

- Modify: `README.md`
- Modify: `SECURITY.md`
- Modify: `docs/PLAYWRIGHT_BROWSER.md`
- Modify relevant live startup/protocol text in the files from Task 3.
- Create: `docs/verification/2026-10-14-browser-exploration-recovery.md`

**Interfaces:**

- Documentation describes actual authority, failed versus unknown outcomes and
  available recovery commands. It does not claim automatic navigation is read-only.
- Verification evidence records exact source head, executed commands/results,
  synthetic/public evidence categories, limitations and review/CI state.

- [ ] **Step 1: Update normative documentation and implementation status.**
  Remove superseded claims that every navigation needs fresh review. Explain
  navigation effects, persistent unknown barriers, fixed diagnostics and retained
  recovery. Read/apply `app-i18n` before changing user-facing copy. Keep English
  as the source of truth and do not copy actual owner traces or account data.
- [ ] **Step 2: Run focused real-Chromium synthetic suites after final changes.**
  Run `npm run build`, then
  `BEHALVO_MANAGED_ACCEPTANCE=1 node --test tests/managed-browser-live.test.mjs tests/managed-browser-acceptance.test.mjs`.
  Confirm these tests execute rather than skip. Record results and any relevant
  public-page reproduction separately, without calling it historical certainty.
- [ ] **Step 3: Run final repository verification.** Run `npm run verify` on
  POSIX. Record the resulting `data/verification/` summary and actual outcomes.
  Do not substitute configured hosted checks for passing CI.
- [ ] **Step 4: Commit documentation and request the final independent pair.**
  Use Sol/high plus Astra/high per `docs/MODEL_USAGE.md`. Supply this spec, plan,
  exact diff and verification evidence. Re-review only changed findings; the
  primary remains sole implementation writer.
- [ ] **Step 5: Complete authorized integration only after passing reviews and
  exact-head hosted CI.** Attach any created PR. Preserve the owner's process,
  existing unknown action and private operational data. Record actual usage and
  final evidence without claiming unperformed checks.

## Design approval and handoff

The delegated architect approves this concrete plan against the companion spec.
The primary may implement it now using the already selected execution method.
No new owner approval is required for the described implementation work. Any
expansion of live mutation authority, automatic reconciliation or unproven
geometry/navigation changes is outside this approval.

## Review amendment: interrupted running actions

Approved by the same delegated architect after Sol identified that running
actions cannot use the unknown-action resolve command. The primary remains the
sole writer. A real SQLite crash/reopen test first reproduced the dead end;
the existing service recovery path does not handle browser actions.

- [x] Add status-aware running/unknown guidance, including mixed states.
- [x] Add the narrow `storage recover-browser` command and broker maintenance
  method described in the amended spec. Reuse the process lock and journal
  settlement; authenticate/validate existing storage before writable access.
- [x] Test real restart/resolution, explicit maintenance, lock contention,
  plaintext/encrypted storage, invalid keys, missing database/workspace,
  unchanged unrelated actions/workspaces and idempotent effect-free replay.
- [x] Run the focused storage/browser suite: 76 passed, zero failures/skips.
- [ ] Re-run repository verification and obtain focused approval from both
  original reviewers before authorized integration.
