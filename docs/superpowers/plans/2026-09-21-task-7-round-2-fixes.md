# Task 7 Round-2 Review Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close review findings R1.1–R1.5 with durable current-authority checks, exact compiled-page evidence, recognized-state readback, bounded execution, and a real journal-to-portal intent bridge while live registration remains disabled.

**Architecture:** `MonitoringService` owns an authority fence derived from current encrypted domain state and the active service claim. `BrowserSession` remains the sole gesture capability, while its narrow protocol gains non-mutating page recognition and synthetic intent installation before selection. The compiled content script derives every visa safety field from bounded DOM attributes, and the loopback synthetic server owns the only intent endpoint.

**Tech Stack:** TypeScript, Node test runner, encrypted SQLite journal, MV3 background/content protocol, local synthetic HTTP portal.

**Spec:** `.superpowers/sdd/2026-09-21-monitored-actions-visa/task-7-review.md`

## Global Constraints

- Strict TDD: every production behavior change follows an observed failing regression.
- Live adapter/native-host registration remains disabled; no real portal, credential, browser installation, or external effect.
- Mutation requires the exact durable action/attempt/grant/connection/profile/installation/service/browser binding.
- Unknown or late results never authorize resubmission or late storage access.
- Produce one scoped commit after focused, full, verification, and diff gates pass.

## Review Focus

- Grant expiry or connection revocation during held selection prevents submit and consumption.
- Missing or contradictory DOM safety attributes fail before submission or satisfied verification.
- Recovery reads only from the exact currently recognized readback-capable page state.
- Never-settling and late-settling adapter calls release the worker without late mutation/storage.
- Journaled intent reaches the synthetic server before selection and survives portal restart without test-only injection.

---

### Task 1: Durable Current-Authority Fence

**Files:**
- Modify: `src/monitoring/service.ts`
- Modify: `src/storage/sqlite-store.ts`
- Test: `tests/us-visa-runtime.test.mjs`

**Interfaces:**
- Consumes: claimed execute job, running action, blocked grant, active connection/installation, `TrustedExecutionFence`.
- Produces: a composed fence whose `assertCurrent()` rereads exact durable bindings and expiry before every adapter/browser continuation.

- [ ] Add real encrypted-runtime tests for expired-before-dispatch and connection revoke/generation drift while selection is held; assert zero submit, no consumed grant, and safe terminal state.
- [ ] Run the focused runtime test and confirm each case fails with a mutation or accepted result.
- [ ] Compose lifecycle and durable-authority checks, including exact grant digest/revision/reservation, connection status/generation, profile, installation, action attempt, and current time.
- [ ] Run the focused runtime test and confirm the new cases pass.

### Task 2: Exact Compiled DOM Evidence

**Files:**
- Modify: `extension/content.ts`
- Modify: `src/synthetic-portal/server.ts`
- Test: `tests/browser-extension-e2e.test.mjs`
- Test: `tests/browser-protocol.test.mjs`

**Interfaces:**
- Consumes: bounded `data-behalvo-*` attributes rendered by the synthetic portal.
- Produces: exact review/confirmation/appointment snapshots without synthesized positive safety facts.

- [ ] Add manifest-compiled tests with missing/contradictory appointment absence, booking type, timezone, location, status, roster, and terms; assert rejection, zero submit, and no satisfied appointment evidence.
- [ ] Run the compiled-content tests and confirm the hardcoded fields incorrectly pass.
- [ ] Parse exact allowlisted literals/digests from DOM attributes and fail closed on all absent, unknown, or contradictory values; render matching exact attributes from the server.
- [ ] Run browser protocol and compiled-content tests and confirm the new cases pass.

### Task 3: Recognized-State Readback and Durable Intent Bridge

**Files:**
- Modify: `src/browser/types.ts`
- Modify: `src/browser/session.ts`
- Modify: `extension/protocol.ts`
- Modify: `extension/content.ts`
- Modify: `src/browser/native-host.ts`
- Modify: `src/adapters/us-visa-china/adapter.ts`
- Modify: `src/synthetic-portal/server.ts`
- Test: `tests/browser-extension-e2e.test.mjs`
- Test: `tests/us-visa-runtime.test.mjs`

**Interfaces:**
- Consumes: exact current browser snapshot, journaled intent ID and slot/action/attempt binding.
- Produces: typed non-mutating `intent.record` delivery and inspect-then-readback using the recognized confirmation/ambiguous/appointment state.

- [ ] Add compiled/native/runtime tests showing ambiguous and appointment recovery currently sends confirmation, and execution without transport-side `recordDurableIntent` performs zero mutation.
- [ ] Run the focused tests and confirm wrong-state rejection and missing-intent failure.
- [ ] Add the narrow typed intent command through session/background/content to the loopback `/api/intent` control, and inspect the exact current state before issuing readback with that state.
- [ ] Run focused tests, including crash/restart with portal durable intent, and confirm no test-only provider-state mutation remains.

### Task 4: Bounded Non-Cooperative Execution

**Files:**
- Modify: `src/monitoring/service.ts`
- Test: `tests/us-visa-runtime.test.mjs`
- Test: `tests/service-runtime.test.mjs`

**Interfaces:**
- Consumes: `withinExecution`, composed authority fence, execute/readback adapter promises.
- Produces: deadline-bounded worker settlement with consumed late resolve/reject and no late storage/gesture.

- [ ] Add real-runtime tests for never-settling execute/readback, late success, and late rejection; assert queue progress and no browser shutdown dependency.
- [ ] Run the tests and confirm `drain()` remains blocked before the fix.
- [ ] Wrap every adapter await in the trusted execution race and classify post-intent stop as unknown while preserving fatal storage propagation and fencing late continuations.
- [ ] Run focused timing tests repeatedly and confirm bounded completion and no late writes/mutations.

### Task 5: Documentation and Final Gates

**Files:**
- Modify: `.superpowers/sdd/2026-09-21-monitored-actions-visa/task-7-report.md`
- Modify: `.superpowers/sdd/2026-09-21-monitored-actions-visa/progress.md`
- Modify: `README.md`
- Modify: `SECURITY.md`

**Interfaces:**
- Consumes: focused/full verification evidence.
- Produces: exact round-2 disposition, test counts, artifact path/fingerprint, and remaining live gates.

- [ ] Run the focused adapter/runtime/compiled-browser/storage compatibility gate.
- [ ] Run the complete test suite and record pass/fail/skip counts.
- [ ] Run `npm run verify`, inspect its summary, and run final `git diff --check`.
- [ ] Update report, ledger, and security documentation without claiming live acceptance.
- [ ] Commit the entire round once with a scoped message and verify a clean worktree.
