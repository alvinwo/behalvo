# Scoped Sol recovery re-review

## Scope and verdict

- Fix base: `dc7eeee9512a948bddd73203c3d8da9717a1abb4`.
- Reviewed fix commit: `388afc4a901e56c413ae6d88b5b692f0512646d8` (`fix: preserve monitored action recovery authority`).
- Review mode: disposition of S1/A1, A2, A3 and the two diagnosed test repairs, plus new-breakage-only inspection of `dc7eeee..388afc4`. The prior whole-branch reviews were not repeated.
- **S1/A1: ADDRESSED.**
- **A2: ADDRESSED.**
- **A3: ADDRESSED.**
- **Protocol-test repair: ADDRESSED.**
- **Deterministic deadline-test repair: ADDRESSED.**
- **New breakage in the scoped fix diff: none found.**
- **Scoped SPEC: PASS. Scoped QUALITY: PASS.** The controller subsequently supplied a clean exact-head full verification pass.

The worktree later advanced to documentation-only checkpoint commit `e8154101247a8dfd500ccd75fbf68670da50e18d`; that commit is outside this requested source/test range and does not change the disposition above.

## Finding disposition and evidence

### S1/A1 — ADDRESSED

`assertArmPlanReservationLifecycle` now checks only ownership/lifecycle before evaluation (`src/monitoring/policy.ts:143-150`), so an active idle monitor with connection drift reaches the canonical durable drift path. `reserve` invokes that lifecycle check first, then `evaluate`; `evaluate` revokes the grant with `material_drift`, which terminalizes its monitor, before any policy selection when the connection is revoked/regenerated (`src/monitoring/service.ts:340-377`). The full reviewed-plan check remains after evaluation and at the existing reducer/storage boundaries through `assertArmPlanReservationReady`.

Focused tests cover revoked, regenerated, and rebound connection drift, assert revoked grant/stopped monitor/no action/no policy selection/effect-free rebuild, and retain paused/queued/running/stopped rejection before evaluation (`tests/monitoring-service.test.mjs:1219-1265`). This directly resolves the reported durable connection-drift terminalization defect without weakening reservation ownership.

### A2 — ADDRESSED

`NativeMessagingTransport` retains a dispatched-but-unacknowledged activation as the exact `uncertain` binding instead of erasing it (`src/browser/native-host.ts:246-270`). Ordinary `revoke(candidate)` can therefore no longer succeed through the prior no-binding no-op: an uncertain binding fails the active-binding requirement (`src/browser/native-host.ts:197-214`), causing `BrowserSession.resume` to fault the exact candidate and call durable `candidateRetirementFailed` (`src/browser/session.ts:289-300`). A fresh transport can retire that exact binding through `reconcileRevocation` before a new activation (`src/browser/native-host.ts:217-227`). Failed native transports now reject subsequent operations as unavailable rather than returning a misleading binding-only failure (`src/browser/native-host.ts:238-243`).

The framed composition regression applies the candidate activation in the compiled background/content boundary, drops its acknowledgement, verifies the exact candidate becomes the failed durable handoff, reopens the encrypted store, proves rebuild/reconstruction emits no browser I/O, rejects plain resume, retires the old epoch with a fresh control, and only then activates a fresh epoch (`tests/monitoring-recovery.test.mjs:108-151`).

### A3 — ADDRESSED

Startup repair now appends `monitor.resume_retirement_failed` with the persisted candidate immediately before `monitor.resume_finished(interrupted)` in one store transaction (`src/storage/sqlite-store.ts:1796-1811`). The reducer requires an interrupted resume with a candidate to have a failed handoff targeting that exact candidate before it may clear `control.resume` (`src/kernel/reducer.ts:477-502`). Composition reconstruction also derives its initial fault target from a still-persisted resume candidate before runtime startup performs interrupted-job repair (`src/service/synthetic-monitoring.ts:81-103`), matching the actual service startup order.

The crash regression persists and activates a candidate, reconstructs composition before repair, verifies atomic promotion to the exact failed handoff and interrupted job, proves rebuild/recovery perform zero browser I/O, blocks ordinary resume, and requires exact retirement before a fresh epoch (`tests/monitoring-recovery.test.mjs:153-175`). A reducer-level regression independently prevents candidate erasure without the retirement handoff (`tests/monitoring-recovery.test.mjs:177-188`). Candidate-free queued resume remains on the existing paused path and does not invent a target.

### Diagnosed test repairs — ADDRESSED

- The protocol regression now expects exact repeated retirement acknowledgement with distinct fresh controls through content and background, while separately rejecting control replay and stale gesture commit and retaining zero clicks (`tests/browser-protocol.test.mjs:280-326`).
- The selection and neighboring readback non-cooperative cases now wait for explicit transport-entry signals, race that entry against premature drain, advance test-owned `Date`/`setTimeout` deadlines only after entry, and retain unknown/no-mutation/no-late-journal assertions for late resolve and reject (`tests/us-visa-runtime.test.mjs:538-604`). This exercises the intended late-settlement paths rather than expiring during preflight.

## Verification and limits

The supplied fresh focused gate for the reviewed fix reports **227/227 passed**, with its raw log at `.superpowers/sdd/2026-09-21-monitored-actions-visa/final-fix-resume-focused.log`; the targeted mapping reports **11/11 passed**. `git diff --check dc7eeee..388afc4` is clean. Per dispatch, I did not run a build, full suite, or another test command and made no tracked source/test change.

After this scoped inspection, the controller ran `npm run verify` at clean, unchanged documentation checkpoint `e8154101247a8dfd500ccd75fbf68670da50e18d`. Its terminal summary at `data/verification/2026-09-25T06-17-32.790Z-30bdcfa9-10ec-47b0-a79a-fefaebb57eb0/summary.json` records `status: passed`, identical before/after source fingerprints, all six gates passed, and check totals of 1,053 tests / 1,048 passed / 0 failed / 5 skipped. The documentation-only checkpoint contains the reviewed source commit unchanged.

This is synthetic, local evidence only. It does not establish installed-browser/native-helper, Keychain, owner-laptop discovery, real portal/account, hosted CI, live booking, push, merge, or publication acceptance.

## Actual review usage

- Reviewer: `/root/recovery_review_sol`.
- Assigned model: `gpt-5.6-sol` (controller dispatch).
- Effort: high.
- Delegated agents: zero.
- Review retries: zero.
- Result: scoped pass; all requested findings addressed; no scoped new-breakage finding; one intermediate report written outside the repository.
