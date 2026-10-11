# Agent Browser Navigation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. The user selected the primary chat as the sole implementation writer. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Let an owner task drive reviewed public HTTPS navigation without a prerequisite `/browser open` command.

**Architecture:** Add `visit` to the existing browser loop and journaled broker. A lazy owned port creates or reuses the current scoped session only when browsing is requested, while legacy owner-open authority stays distinct.

**Tech Stack:** TypeScript modular monolith, existing SQLite journal, pinned Playwright/Chromium and Node test runner. No new dependencies.

**Spec:** [Approved design](../specs/2026-10-11-agent-browser-navigation-design.md).

## Global Constraints

- Use synthetic data only; preserve all managed-browser security boundaries.
- Keep old command payloads and digest serialization unchanged; replay is read/reduce only.
- Never retry unknown navigation; no resource allocation for an ordinary direct answer.
- English is normative. Use the existing message catalog for user-visible copy.
- One implementation writer; final independent Sol/high and Astra/high review.

## Review Focus

- A model tries `observe` before first `visit`: recoverable feedback, zero allocation (Task 3).
- Initial URL review is rejected or handed off: zero target traffic (Tasks 1–2).
- Navigation changes only a fragment: stale controls/input bindings expire (Task 1).
- Cancellation wins a pending session creation: late resources cannot survive or navigate (Task 2).
- Historical owner-open actions replay after the new command: unchanged digests and no effect (Task 1).

### Task 1: Reviewed URL command and adapter

**Files:** `src/kernel/browser-action.ts`, `src/browser/semantic-types.ts`, `src/browser/live-playwright.ts`; tests in `tests/managed-browser-actions.test.mjs` and `tests/managed-browser-live.test.mjs`.

**Interfaces:** Add optional `SemanticBrowserPort.visit(context, url): Promise<BrowserObservation>` and `LivePlaywright.visit(context, url): Promise<BrowserObservation>`. Add the exact `operation: 'visit'; url: string` union branch; share private navigation mechanics where useful while keeping public `open` and `visit` distinct.

- [x] Add failing tests for exact visit shape, URL/origin/digest bindings and fixed legacy digest fixtures; adapter visits require broker approval, reuse its page, and invalidate controls/input descriptors even for fragment navigation.
- [x] Build and run the targeted action/live tests; record the expected failures.
- [x] Implement strict command validation and one-shot reviewed `visit`; preserve legacy `open`, exact dispatch guard, fresh capture and handoff handling.
- [x] Re-run targeted tests. Assert reject/handoff has zero destination requests and approved navigation observes `action.started` before the first request.
- [x] Commit the command and adapter change with its tests.

### Task 2: Lazy owned session acquisition

**Files:** `src/browser/managed-session.ts`; tests in `tests/managed-browser-session.test.mjs` and `tests/managed-browser-live.test.mjs`.

**Interfaces:** `exploration().open(context, binding)` returns a lazy `SemanticBrowserPort`; its `visit` materializes/reuses the exact scoped session. Expose `sessionState(scope): 'absent' | 'connected'`, preserving `available(scope)` semantics. Retire a never-materialized port without claiming retained resources.

- [x] Add failing tests for zero allocation on port acquisition, one allocation across repeated visits/turns, unchanged capacity and cross-scope isolation, review rejection/handoff, cancellation during creation, late allocation and unconfirmed cleanup.
- [x] Build and run the session tests; record the expected failures.
- [x] Factor creation from trusted owner `open`; make the lazy port own in-flight creation and cleanup before its first allocating await. Route `visit` to review and keep owner `open` authority inaccessible from the model port.
- [x] Re-run session/live tests. Assert no late navigation or session resurrection, correct retained/human/closed disposition, and durable unknown barriers.
- [x] Commit the lifecycle change with its tests.

### Task 3: Task-driven protocol and CLI composition

**Files:** `src/runtime/browser-exploration.ts`, `src/runtime/agent-service.ts`, `src/cli/main.ts`, `src/browser/live-messages.ts`; tests in `tests/browser-exploration-loop.test.mjs`, `tests/managed-browser-cli.test.mjs`, `tests/managed-browser-acceptance.test.mjs`.

**Interfaces:** Add optional `BrowserExplorationOptions.sessionState(scope)` using the type from Task 2. Live mode selects the existing loop for a resolved task regardless of existing session availability. Exact `visit` arguments are `{url: string}`; absent observation/handoff returns fixed tool feedback with no resource creation.

- [x] Add failing tests for natural task → visit → final without owner-open, final without allocation, absent observe recovery, synthetic-mode visit rejection, malformed URL rejection before allocation and truthful protocol state.
- [x] Build and run exploration/CLI tests; record expected failures.
- [x] Implement the live protocol and tool dispatch, retaining completion/deadline/recall bounds, source validation, safe retirement, and synthetic behavior. Wire the controller state callback through production CLI composition.
- [x] Re-run targeted tests, then the gated real-Chromium synthetic acceptance path. Prove first visit owner review, subsequent URL reuse, fresh journal evidence and no effects during encrypted rebuild.
- [x] Commit the product path and tests.

### Task 4: Documentation, final verification and review

**Files:** `README.md`, `SECURITY.md`, `docs/PLAYWRIGHT_BROWSER.md`, the relevant implementation-status table and a scoped verification record.

- [x] Update descriptions to make natural-language navigation operational and `/browser open` optional. State that URL navigation is reviewed and public HTTPS access is separate authority.
- [x] Run `npm run verify` on the final tree and inspect terminal summary plus raw logs. Record actual browser/model acceptance categories and cleanup results; do not infer hosted CI from local tests.
- [x] Obtain the one independent Sol/high plus Astra/high final review pair, fix supported findings and run appropriate verification for changed code.
- [ ] Under the existing user authorization, prepare the PR, verify exact-head hosted CI, merge and perform repository cleanup.

## Delegated approval

The architecture reviewer approves this spec and implementation plan for the
primary writer's execution. No product or test code was changed during design
review. Implementation evidence and the required independent final review pair
remain pending.
