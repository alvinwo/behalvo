# Read-only Playwright Browser Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** One local command opens an isolated visible Chromium browser, validates the synthetic login page through BrowserSession, and confirms cleanup.

**Architecture:** A read-only transport contains Playwright page access. An owned BrowserServer supplies process lifecycle evidence; the diagnostic coordinator owns deadlines, cancellation and cleanup. No kernel, service worker, grant, model or domain mutation is introduced.

**Tech Stack:** TypeScript, Node.js >=22.19, Playwright exactly 1.63.0, existing node:test and BrowserSession.

**Spec:** [Reviewed design](../specs/2026-10-03-playwright-browser-adapter-design.md).

## Global Constraints

- P1 only: synthetic, login-only, all gestures rejected before dispatch.
- Fixed origin `http://127.0.0.1:43117`; only GET of its exact root is admitted.
- Visible matched Chromium; explicit one-time browser install, no runtime download.
- Setup 15 seconds, observation 10 seconds, total cleanup 5 seconds.
- No existing browser attachment, user-selected profile/URL/script/selector/args, old extension profile access, publication or merge.
- Local loopback BrowserServer endpoint stays private; sole CLI signal ownership.
- Fresh private operational receipt records run/phase and cleanup; no domain journal claims.
- English-first documentation; CLI copy uses one keyed English catalog following this repository's single-language baseline. No localization framework is introduced.
- One implementation writer in this checkout; independent design reviewers do not implement.

## Review Focus

- Launch can fail after allocating resources but before returning a handle: report unknown cleanup, retain receipt, never retry (Task 2).
- Page requests can reach same-origin mutation routes: deny method/path before dispatch, including popup requests (Tasks 1 and 3).
- Caller cancellation can precede promise settlement: invalidate immediately and retire late resources (Tasks 1 and 2).
- Browser close may suppress profile-removal errors: success needs exact process termination and profile absence (Task 2).
- Port conflict or missing browser can look like setup success: fail with fixed actionable codes and clean only resources actually owned (Tasks 2 and 3).

---

### Task 1: Read-only session transport

**Files:** Create `src/browser/playwright-transport.ts`, `tests/playwright-transport.test.mjs`; modify `package.json`, `package-lock.json`.

**Interfaces:**
- Consumes existing `BrowserRequest`, `BrowserEpoch`, `BrowserSessionTransport`, `parseBrowserRequest` and `SYNTHETIC_PORTAL_ORIGIN`.
- Produces `PlaywrightReadOnlyTransport implements BrowserSessionTransport`, constructed with an internally supplied owned Page, trusted profile/connection/service bindings, AbortSignal and owner close callback.
- Produces fixed-code `PlaywrightDiagnosticError` and a bounded wait helper in `src/browser/playwright-errors.ts`; arbitrary exception messages never enter diagnostic output.
- The transport's tab handle is 1; only the owning coordinator receives it. Playwright objects never enter BrowserSession responses or model tools.

- [x] Write tests asserting actual response envelopes and login snapshots through BrowserSession using a narrow fake Page boundary for deterministic races: wrong each binding, replay/gap, duplicate in-flight request, stale epoch, missing/multiple/changed main markers, navigation during pending read, closure/disconnect, cancellation, observation timeout, revocation, and every gesture rejected without authorization or page action.
- [x] Run `npm run build && node --test tests/playwright-transport.test.mjs`; expected RED for missing transport behavior. If module absent, first assert export availability using a guarded dynamic import so failure is explicit.
- [x] Pin `playwright` at `1.63.0` with a lockfile; implement only the transport/errors contracts. Recheck page identity/document/lifecycle after every asynchronous read; strict parse requests and construct only known response fields. Bind first epoch once, enforce consecutive sequence, disallow concurrent reads, terminalize protocol/page/cancellation failures. Main-frame navigation changes document identity and invalidates an in-flight read. Close/revoke settle pending reads immediately.
- [x] Run focused tests and TypeScript checks; expected all pass. No browser download or browser launch belongs to offline tests.
- [x] Commit the tested transport/dependency changes locally.

### Task 2: Owned browser lifecycle and diagnostic command

**Files:** Create `src/browser/playwright-owner.ts`, `src/browser/playwright-diagnostic.ts`, `src/cli/playwright-main.ts`, `src/cli/playwright-messages.ts`, `tests/playwright-owner.test.mjs`, `tests/playwright-diagnostic.test.mjs`, `tests/playwright-cli.test.mjs`; modify `package.json`.

**Interfaces:**
- Owner `new PlaywrightBrowserOwner(input: {profileId, connectionGeneration, serviceGeneration, signal}, dependencies?)` creates the receipt before launch; `start()` returns transport, tabId and actual browser version, while `close()` is available during pending startup and returns cleanup evidence; dependencies are trusted in-process test seams only, never CLI/model options.
- `runPlaywrightDiagnostic({signal}, dependencies?)` returns a discriminated result: success only with login and confirmed cleanup; otherwise fixed failure code, cleanup state, and private receipt path when retained. No raw exception, endpoint, DOM or ambient environment is returned.
- `runPlaywrightCli(argv, dependencies?) -> Promise<number>` accepts exactly `['diagnostic']`, maps result codes through the English message catalog and installs/removes the sole signal handlers in its executable entry point.

- [x] Write owner tests: no launch when pre-cancelled or ambient remote/debug overrides exist; fixed launch/env options; setup timeout; late launch closes without connect; missing executable; profile captured from only returned process; normal close needs exit/server close/profile absence; profile retained despite successful close; graceful timeout then exact owned kill within remaining budget; repeated close uses one result; unresolved close remains pending; no broad kill/deletion.
- [x] Write coordinator/CLI tests: fresh registry/bindings, actual BrowserSession read (not coordinator DOM access), explicitly empty worker ownership, missing-browser instruction, occupied portal port, cancellation during setup/read, late portal retirement, total cleanup budget, failure cannot become success after late read, strict args, fixed safe output and no secret-bearing errors. Inject canaries in exception text, stderr, page DOM and endpoint; assert absent from CLI/logs and allowlisted private receipts. Assert CLI signal ownership during pending launch as well as read.
- [x] Run new tests; expected RED for missing lifecycle/diagnostic behavior.
- [x] Implement lifecycle with loopback ephemeral `chromium.launchServer`, matched Chromium executable preflight, fixed options and minimal child environment. Install route/serviceworker/WebSocket/download/popup/frame restrictions before navigation. Keep exact ChildProcess reference and canonical private profile identity; never delete its profile directly. Close gracefully first and use only owned BrowserServer.kill for escalation. Confirm termination plus profile absence. Before launch persist a mode-0600 receipt under a fresh mode-0700 temporary run directory; update fixed phases and retain all uncertain cleanup evidence. If no handle returns, profile identity is explicitly unavailable.
- [x] Implement coordinator using real synthetic portal and BrowserSession; shared cancellation aborts transport/session immediately; bound setup and each observation separately; single cleanup promise covers all resources and late handlers. Close both portal and browser even when one fails. Receipt removal uses exact owned file unlink and empty directory removal only after confirmed success.
- [x] Wire `npm run browser:playwright -- diagnostic`. Reject ambient override/debug logging before importing Playwright, sanitize failures and browser version output, use bounded entry-point exit when cleanup is pending. Do not add Chrome channel options in P1.
- [x] Run focused tests and build; expected all pass. Commit locally.

### Task 3: Real-browser acceptance, documentation and independent code review

**Files:** Create `tests/playwright-acceptance.test.mjs`, `docs/PLAYWRIGHT_BROWSER.md`, `docs/verification/2026-10-03-playwright-p1.md`; modify README implementation status, SECURITY.md as needed, RESUME.md and this plan's completion markers.

**Interfaces:** Acceptance invokes the production coordinator/transport; trusted fixture wrappers capture only newly launched test-browser references for fault injection. Normal offline tests skip explicit real-browser tests unless `BEHALVO_PLAYWRIGHT_ACCEPTANCE=1`; no implicit downloads or live-site access.

- [x] Write real acceptance before declaring browser behavior operational: visible matched Chromium, real DOM through BrowserSession; missing contract; pending-read navigation; browser crash and subsequent rejection; popup/off-origin/same-origin POST blocked before dispatch; cancellation during launch/read; SIGINT/SIGTERM child CLI shutdown; repeated close and exact profile cleanup. Assert no non-GET reaches synthetic server and no other browser is affected. Use a synthetic preflight endpoint to prove ambient Selenium rejection makes no connection.
- [x] Explicitly install the pinned matched Chromium and run acceptance with `TMPDIR=/private/tmp` on macOS; expected pass with actual versions and cleanup evidence. Record failures and corrections honestly. Exercise the public single command separately.
- [x] Write the one-time install and one-command guide, limitations (including unknown launch cleanup), error recovery, synthetic-only scope and separate P2 status. Update status only after acceptance passes. Record exact source head and evidence paths; no hosted CI claim without a run.
- [x] Run `npm run verify` with supported Node and canonical TMPDIR; expected all gates pass. Run `git diff --check`; expected clean. Commit final source/docs locally, then record exact-head Mac acceptance.
- [x] Obtain independent Sol high and Astra high code reviews of the P1 diff against `634c791`. Resolve supported blockers with RED/GREEN tests and reverify affected code; if source changes, rerun full final verify and exact-head acceptance. Preserve existing extension branch/PR. Report completed scope, remaining limitations and actual model-routing ledger; no push/merge.

## Review and execution authority

The owner approved the direction and explicitly requested design/architect approval followed by implementation on 2026-10-03. Native execution by the primary is retained. Implementation starts only once both design reviews clear the revised spec; no additional owner approval loop is required by this plan.
