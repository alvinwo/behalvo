# Task 4 report — monitored action authority

## Result

Task 4 is implemented as a generic, replayable monitored-action authority. It introduces no visa, real portal, browser extension, native-host, Keychain, credential, or external-effect behavior from Tasks 5–7.

## Delivered

- Journaled `MonitoredActionGrant` lifecycle with exact object validation, canonical scope digest, fixed revision, one-effect v1 allowance, owner activation, expiry, revocation, settlement, and installation-generation reconciliation.
- Generic adapter registry and deterministic evaluator. Only complete, fresh, sufficiently covered observations can select one exact operation command; connection or supplied binding drift revokes the grant.
- Atomic reservation transaction containing deterministic command narrowing, `monitored_action.grant_reserved`, and the immediately following durable `action.started`. Unknown, failed, accepted-unverified, and not-satisfied outcomes never restore capacity.
- Durable recurring monitor state for due time, bounded jitter, request windows/budgets, last complete observation and coverage, exponential backoff, pause reason, and single-flight job identity.
- Service-queue/runtime integration for monitor admission, claim fencing, completion, cancellation, crash interruption, restart, coalescing, and no burst catch-up. Monitor checks call neither the model nor operation effect/readback services.
- Exact monitor request/job/result provenance in plaintext and encrypted snapshot validation and backup/restore.
- Current service schemas admit the `monitor` job kind. The prior exact service schema remains readable for legacy jobs and is migrated atomically only with explicit `upgradeExisting: true`; monitor configuration fails with upgrade guidance until then.
- Restored installations expose active grants as blocked and reject monitoring/reservation until an exact owner reconciliation binds the new installation generation.

## TDD evidence

The first focused RED run was:

`npm run build && node --test tests/monitoring-policy.test.mjs tests/monitoring-storage.test.mjs tests/monitoring-service.test.mjs`

It failed all three test files because `MonitoringRegistry` and the Task 4 surface did not exist (0 passed, 3 failed). Production code was added only after that failure.

Later review-driven RED/GREEN slices separately demonstrated and fixed:

- unexpected inspector exceptions leaving a running claim instead of bounded provider backoff;
- shutdown leaving an in-flight monitor claim instead of a durable interruption;
- inconsistent pending-grant provenance being accepted during replay;
- connection-generation drift failing without revoking authority; and
- legacy service schemas lacking an explicit monitor-job upgrade path.

Pre-review focused gate:

- 23 passed, 0 failed, 0 skipped.

Coverage includes replay-only reduction, prohibited and bounded scopes, digest/revision, explicit owner activation, expiry/revocation/material drift, routine observations without grant revision changes, complete/fresh/covered narrowing, concurrency/rollback/restart/new IDs, retained reservation, installation restore/reconciliation, encrypted backup, single-flight/coalescing, jitter, budget deferral, backoff, pause outcomes, shutdown, crash recovery, legacy schema upgrade, and zero model/effect/readback calls.

## Pre-review verification

- `npm test`: 708 tests; 706 passed, 0 failed, 2 skipped.
- `npm run verify`: passed typecheck, the same full suite, offline demo, synthetic operations demo, and owner-control demo. All demos reported zero real external effects; applicable demos also reported replay equality.
- `git diff --check`: passed immediately before the scoped commit.
- Pre-existing npm warning: unknown `http-proxy` environment config. It did not affect any gate.

## Self-review

- Confirmed ordinary owner approvals, action behavior, reminder jobs, exact legacy schema validation, and backup behavior remain covered by the full suite.
- Tightened journal validation for status/provenance combinations, exact monitored command digests, monitor window counters, budget deferral, observation timing/backoff/pause transitions, interruption timing, and terminal job evidence.
- Confirmed allowance reservation and `action.started` share one store transaction and rollback together under injected failure.
- Confirmed monitor cancellation and process-restart recovery release the worker without replaying an inspection.
- Confirmed no Task 5–7 concepts or dispatch paths were introduced.

## Remaining concerns

No Task 4 blocker is known. Real authenticated observation and mutation transport intentionally remain unavailable until the separately reviewed Tasks 5–7 provide those boundaries and adapters.

## Independent-review fix round

All six findings in `task-4-review.md` were reproduced or confirmed against the committed implementation and approved design before edits. No finding was rejected.

The fix round added these guarantees:

- Grant revocation and expiry now atomically append the terminal monitor transition and settle every bound queued/running monitor job. The reducer retains the in-flight identity until that terminal transition consumes it, and same-process invalidation aborts a non-cooperative inspector immediately. Late inspection results are discarded without faulting or retaining the serial worker. Queued/running revoke and expiry, post-inspection expiry, restart behavior, and encrypted backup provenance are covered.
- Inspection runs through the existing deadline/cancellation race and rechecks the exact grant after the await. A provider promise that ignores abort no longer owns the serial worker indefinitely; late fulfillment and rejection are consumed without journal mutation.
- The current exact service schema has an authenticated installation marker with a storage-owned random generation, activation state, and physical database identity. Encrypted backup rotates the copied marker to a fresh inactive generation before snapshot verification; a raw closed-file copy also fails its physical identity binding. Reusing the caller's configuration label cannot activate an unused copied grant. Exact owner reconciliation atomically activates/rebinds pending or active grants, and multiple restored active grants can each reconcile without reopening unrelated authority. Normal same-store restart retains the trusted marker. Prior service schemas remain readable and gain an inactive marker only through explicit upgrade.
- Signed jitter is bounded against the selected success/backoff delay, leaving at least one millisecond of positive delay. Replay validates the same bound, preventing fixed-clock retry bursts.
- `accepted_unverified` and `unknown` settlements may advance only to `accepted_verified` for the same retained reservation after the action is accepted and exact trusted verification is `satisfied`. `not_satisfied` requires matching readback evidence. Duplicate identical settlement is idempotent; no path restores capacity.
- Narrowed monitored actions are exact-validated; the 64-hex observation identity must match both action key and reservation; narrowing, reservation, and the same attempt's `action.started` must be contiguous. Complete replay and encrypted snapshot verification cross-check journal adjacency, terminal-grant/monitor provenance, active successor timestamps, final grant/action relationships, and both directions of live monitor-job binding.

Review-driven RED evidence included stranded queued/running terminal jobs, revocation retaining a non-settling inspector, a non-settling inspector past its 20 ms deadline, an observation accepted after expiry, reusable active encrypted backup and raw-file copies, multi-grant and pending-only restore reconciliation dead ends, negative jitter scheduling in the past, rejected unresolved-to-verified settlement, accepted `not_satisfied` without evidence, malformed reservation journals accepted without a start, invalid terminal-stop/successor provenance, and inconsistent live job bindings accepted by encrypted backup. Each focused slice was observed failing before its production fix.

Final fix-round verification:

- Focused Task 4: 44 passed, 0 failed, 0 skipped.
- Service/storage/encrypted-backup compatibility: 170 passed, 0 failed, 0 skipped.
- Full `npm test`: 729 tests; 727 passed, 0 failed, 2 skipped.
- `npm run verify`: all five steps passed with identical before/after source fingerprint; offline demos reported zero real external effects. Evidence: `data/verification/2026-09-21T11-22-31.061Z-3659f4f9-d7d0-4b3d-a70d-152bce4bdd65/summary.json`.
- `git diff --check`: passed after the final source and evidence edits.

The first read-only code review after these fixes reported no Critical, Important, or Minor issues. A subsequent repeated race and recovery review found the two narrower P2 cases resolved below. The caller-facing `installationGeneration` option is retained for source compatibility but is no longer an authority input; the authenticated storage marker and physical database binding own that decision. Tasks 5–7 remain unimplemented.

## Independent-review fix round 2

The updated `task-4-review.md` retained two P2 findings. Both were reproduced against `e23903c` before production edits:

- A deterministic fence with an already elapsed local deadline and a deliberately not-yet-aborted signal resolved a monitor job as `provider_unavailable` instead of propagating `OperationDeadlineError`.
- A retained `not_satisfied` reservation rejected a later exact `satisfied` readback with `Invalid monitored grant settlement`; separately, a verification timestamp older than the stored negative readback was accepted.

The second fix round added these guarantees:

- Typed `OperationStoppedError` and `OperationDeadlineError` values from `withinExecution()` bypass provider-failure normalization independently of `AbortSignal` timing. Ordinary inspector exceptions still become bounded `provider_unavailable` observations. The regression executes 80 deterministic pre-abort deadline orderings without wall-clock race assumptions. The held-inspector deadline cases continue to prove worker release, and late resolution or rejection is consumed without any journal version change.
- `not_satisfied` joins the existing same-reservation unresolved outcomes that may advance only to `accepted_verified`. The action must still be accepted and carry exact trusted `satisfied` verification. The grant keeps its original action and attempt identities, stays blocked until verification, becomes consumed without another action, rejects a second reservation, and treats the identical final settlement as an idempotent no-op.
- For a prior negative settlement, both the satisfied verification record time and its provider observation time must be strictly later than the negative settlement time; equality is not fresh. Existing exact action/provider/subject/connection-generation/resource checks reject foreign evidence before settlement. The freshness rule is scoped to the newly introduced negative-to-positive transition, so historical non-monotonic verification records remain replayable without authorizing consumption.

Second-round verification:

- Focused Task 4: 47 passed, 0 failed, 0 skipped.
- Deterministic deadline stress: 80 pre-abort deadline-order iterations within the focused regression, plus late resolve/reject fencing.
- Service/storage/encrypted-backup compatibility: 170 passed, 0 failed, 0 skipped.
- Full `npm test`: 732 tests; 730 passed, 0 failed, 2 skipped.
- `npm run verify`: all five steps passed with identical before/after source fingerprint; offline demos reported zero real external effects. Evidence: `data/verification/2026-09-21T11-42-36.985Z-b2d9c720-905e-47b5-aab0-8e97a94c4aee/summary.json`.
- The only emitted warning remains npm's pre-existing unknown `http-proxy` environment-config warning.

Fresh read-only review accepted the deadline fix and identified one Important issue in the initial settlement freshness guard: it ignored the provider observation time and retroactively constrained legacy replay. The final TDD fix scopes strict record/observation freshness to `not_satisfied -> accepted_verified`; equal time, older observation time, and legacy non-monotonic record time are covered. The post-fix focused, compatibility, full, and five-step verification gates above all passed.

No Tasks 5–7 behavior was added.
