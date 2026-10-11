# Managed browser implementation plan

Status: approved by the delegated architecture reviewer for implementation.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the owner and agent use an isolated live browser across turns with scoped access, supervised gestures and manual login handoff.

**Architecture:** A process-local controller owns disposable Chromium sessions and lends fresh run leases. Typed browser commands reuse the existing Action journal lifecycle; a checked-address CONNECT gate enforces exact public HTTPS destinations.

**Tech Stack:** TypeScript, Node >=22.19.0, existing Playwright 1.63 and SQLite journal; no new dependency.

**Spec:** ../specs/2026-10-11-managed-browser-design.md

## Global Constraints

- Synthetic accounts/data only; separate non-sensitive public HTTPS smoke.
- At most two managed sessions, eight exact origins per session, ten-minute idle expiry.
- No public test seams, personal profile, remote CDP, arbitrary selectors/scripts, credentials, uploads, downloads, WebSockets or service workers.
- Run leases are distinct from session cleanup; cookies persist only in the owning process/browser until closure.
- All domain changes use deterministic journal events; no browser effects in replay.
- Every model gesture requires fresh exact owner approval; unknown outcomes block further gestures for that work and never auto-retry.
- New user-facing text uses English catalogs; normal Node/platform verification and independent Sol high/Astra high reviews before integration.

## Review Focus

- DNS rebinding/private-address variants must never reach a dial not bound to the validated address.
- Owner approval races with DOM replacement, task correction, cancellation and navigation must stop before dispatch.
- Retiring a run must invalidate refs without killing a healthy session or permitting a late callback.
- An uncertain effect must remain blocked after window closure, new sessions and replay.
- Manual login must survive a later turn while passwords/OTP inputs never appear in observations or model controls.

### Task 1: Browser action authority

**Files:** Create `src/kernel/browser-action.ts`, `src/runtime/browser-actions.ts`, `tests/managed-browser-actions.test.mjs`; modify `src/kernel/types.ts`, `src/kernel/policy.ts`, `src/kernel/reducer.ts` and typed consumers.

**Interfaces:** Produce the spec's minimal `BrowserActionCommand` union: common kind/version/thread/session/generation/grantRevision/origin, then either owner-authored `operation: open` with exact URL, or `operation: interact` with document ID, control fingerprint and existing navigate/click/fill/select reference arguments. Initial open has no invented observation/control; handoff is not a credential action. Produce `isBrowserActionCommand`, `validateBrowserActionCommand`, `assertNoUnknownBrowserAction`. Broker consumes trusted binding `{workspaceId,ownerId,workId,ownerRecordId,expectedWorkRevision}`, a review callback and guarded dispatch callback; uses Action proposal/approval/start/finish and returns recognized accepted/failed/unknown outcomes only.

- [ ] Add RED tests for exact digest fields and unknown fields, owner-only approval, started-before-dispatch, rejection/handoff without dispatch, same-work running/unknown barrier across new session IDs, cancellation after dispatch becoming unknown, late outcome ignored and owner reconciliation without redispatch.
- [ ] Implement typed validation, digest discrimination preserving old formats, reducer start barrier, and broker using `finishActionAttempt`. Extend action inspection safely; no generic Operator effect driver accepts browser commands.
- [ ] Run build and focused browser-action/kernel/operation tests; commit.

### Task 2: Public network boundary

**Files:** Create `src/browser/public-network.ts`, `tests/managed-browser-network.test.mjs`; modify narrow internal options in `src/browser/playwright-process-owner.ts`.

**Interfaces:** Produce canonical `publicHttpsUrl`, `isPublicAddress`, and `PublicNetworkGate` with `start`, `allow`, `assertAllowed`, `close`, `proxyUrl`, grant revision and bounded blocked-origin reporting. Production DNS/dial defaults always validate the checked IP; test-only constructor dependencies may resolve/dial synthetic servers. Process owner receives only a validated loopback proxy URL and fixed network-hardening args, not caller-supplied launch options.

- [ ] Add RED tests for URL/userinfo/scheme/origin canonicalization; IPv4, IPv6 and mapped private/reserved addresses; mixed DNS results; exact-IP dialing; redirect/dependency host denial; closed/expired grant; tunnel/server closure and no direct fallback configuration.
- [ ] Implement HTTPS CONNECT only, at most 32 concurrent tunnels, 2,048 routed requests and 128 MiB aggregate tunneled traffic per session, ten-second dial timeout and sixty-second tunnel inactivity timeout, fixed errors and bounded metadata. Enforce the route counter in context routing and aggregate bytes in the gate. Destroy tunnels on close/revocation and use current origin authority on every request/tunnel admission; no automatic retry on limits.
- [ ] Run network and process-owner tests; commit.

### Task 3: Live semantic adapter

**Files:** Create `src/browser/live-playwright.ts`, `tests/managed-browser-live.test.mjs`; modify `src/kernel/browser-contract.ts` and `src/browser/semantic-types.ts`.

**Interfaces:** Produce `LivePlaywright` constructed with session owner/network gate, exposing `observe(lease)`, prepared current-control description, guarded `interact(lease,command)`, descriptor-only input authorization, `handoff`, `resume`, `close`. BrowserObservation shape remains bounded (32,768 UTF-8 bytes/100 controls/100 options per control); HTTPS origin validation is shape-only, not authority. Checkbox/radio controls use existing button/click semantics with checked state bound to the fingerprint and shown in text/review. No raw model locator/evaluate input.

- [ ] Add RED Chromium tests against generic dynamic synthetic pages for JS/resources/fetch, semantic links/buttons/select/fill/check, stale refs/DOM replacement, inaccessible/sensitive fields, denied popup/download/WebSocket/service worker and current field descriptor input binding. Prove owner authorization between turns works only after a fresh unique descriptor match; old executable refs, changed/ambiguous fields, navigation and handoff never disclose a bound value.
- [ ] Implement fixed DOM snapshot extraction with opaque handle refs and sanitized text, no values/HTML/hidden fields. Native interaction rechecks current descriptor and scope around trusted review; then dispatches through the broker. Fresh observation after accepted gesture; unavailable evidence after possible dispatch is unknown.
- [ ] Run browser tests using trusted synthetic network seams and prove cleanup by owned receipts; commit.

### Task 4: Retained sessions and run leases

**Files:** Create `src/browser/managed-session.ts`, `tests/managed-browser-session.test.mjs`; modify `src/runtime/browser-exploration.ts`, `src/runtime/agent-service.ts`.

**Interfaces:** Produce `ManagedBrowserController` keyed by workspace/owner/thread/work, trusted `open/allow/status/input/handoff/resume/close/shutdown`, and `borrow(context,threadId)` returning a SemanticBrowserPort lease. Add explicit port retirement `{leaseRetired,sessionDisposition,cleanupConfirmed?}`; synthetic ports retain per-turn close. Retain only the bounded owner input descriptor catalog across ordinary lease retirement, using separate input refs and a session/document/origin/epoch/fingerprint purpose hash. `/browser input` journals an exact source binding without acquiring a lease or transmitting data; a fresh lease must uniquely match it before `resolveTaskInput`. Handoff advances the input epoch; navigation, work revision change and closure invalidate the catalog. Browser options provide mode and current binding availability; historical notes cannot select capabilities.

- [ ] Add RED tests for successive-turn cookies with fresh refs, cross-work/chat isolation, handoff blocking observe/model calls, resume fresh snapshot, task revision changing refs, idle expiry, task closure, cancelled/late/unknown work, session capacity and full shutdown cleanup.
- [ ] Implement controller state machine and run guard. Bind all async callbacks to lease generation. Permit final progress only after confirmed lease retirement; retain healthy session, close uncertain state. Operation reasoning remains available when no matching live session is selected.
- [ ] Run session and existing synthetic exploration/continuity tests; commit.

### Task 5: Product CLI and acceptance

**Files:** Create `src/cli/browser-commands.ts`, `src/browser/live-messages.ts`, `tests/managed-browser-cli.test.mjs`, `tests/managed-browser-acceptance.test.mjs`; modify `src/cli/main.ts`, `src/cli/repl.ts`, `src/cli/action-review.ts`.

**Interfaces:** CLI flag `--browser live` composes controller only in interactive live-model mode. `/browser` lifecycle/input/allow/resolve commands follow the spec; one-shot review accepts approve/reject/handoff. Public parsing never accepts proxy/resolver/profile/engine/certificate test overrides.

- [ ] Add RED command tests for enabling/composing, focused scope, exact origin commands, hidden-state handoff, input quoting, safe status/action inspection, stale reconciliation and noninteractive refusal.
- [ ] Wire shutdown on normal exit and signals; preserve model/provider login and synthetic fixture flags, rejecting incompatible modes. Add catalog copy/help/examples.
- [ ] Exercise two unrelated dynamic synthetic websites through actual CLI/agent path, a synthetic manual login across turns, approved one-shot mutation with lost response, restart barrier, encrypted replay, cancellation and cleanup. Separate public HTTPS smoke and live-model synthetic acceptance from scripted evidence; record actual outcomes.
- [ ] Update README, SECURITY, browser guide, implementation status and verification report. Run `npm run verify`, independent final pair review, address findings, publish authorized PR, exact-head hosted checks and merge.
