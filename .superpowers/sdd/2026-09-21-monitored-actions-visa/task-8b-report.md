# Task 8B report — atomic scheduled dispatch

Date: 2026-09-22
Base: `e14a17e15d37b66d80ea16939d811e332238544d`

## Delivered

- A due monitor's real complete, fresh, eligible observation now autonomously narrows the exact command and enters the existing serial execute FIFO. Neither the integration test nor production path calls the public `reserve` or owner `admitActionJob` APIs.
- `SqliteStore.completeMonitorJobAndAdmitAction` is the purpose-specific atomic boundary. One SQLite transaction records the sanitized observation, appends contiguous command narrowing / grant reservation / `action.started` / recurrence stop records, finishes the monitor job, and inserts one execute receipt and queued job.
- The transaction rechecks the claimed monitor, active grant, connection, browser profile, installation generation, work revision/lifecycle, freshness, full observation digest, exact action/command digest, attempt, and evidence binding at commit. The protected service envelope authenticates those bindings in encrypted snapshots.
- Request identity is deterministic: source `kernel:monitor-action`, request ID `<monitor-job-id>:execute`. Exact duplicates resolve before the 64-waiting-job capacity check; conflicting reuse fails closed. The ordinary owner admission API rejects protected scheduled-monitor envelopes.
- Queue-full and injected commit-fault paths leave the monitor claim retryable and append no observation, action, reservation, recurrence stop, receipt, or execute job.
- Existing recovery semantics remain authoritative: queued/unclaimed execution survives restart and runs once; claimed interrupted execution becomes unknown/verification-only; projection rebuild performs no dispatch; failed and unknown reserved allowances remain blocked and the stopped monitor cannot recur.
- Existing manual reservation behavior is preserved through the same shared contiguous reservation-event builder.

## TDD evidence

Raw logs are adjacent to this report.

- RED — `task-8b-red-automatic-dispatch.log`: focused compiled page-derived visa path failed with 0 passing / 1 failing because only the monitor job existed and no execute job was admitted.
- RED — `task-8b-red-exact-binding.log`: 0 passing / 1 failing because an early draft's duplicate equality did not bind installation evidence. The protected exact scheduled-monitor envelope closed that gap.
- GREEN — `task-8b-green-focused.log`: build passed; 9 tests passed / 0 failed / 0 skipped, covering automatic page-derived dispatch, rollback, capacity, exact duplicate identity, encrypted backup, revocation/late continuation, and queued-versus-claimed restart.
- Compatibility — `task-8b-compatibility-final.log`: build passed; 371 tests passed / 0 failed / 0 skipped across browser protocol/session/native/content, monitoring, service storage/runtime/lifecycle, encrypted storage/backup, and visa policy/adapter/runtime/recovery/observation suites.

## Independent review fix round 1/5

The independent review at `ed26cb9` reported four Important findings (B1–B4). Each was verified against the supported production path and reproduced before its production fix.

- B1: exclusive-maintenance recovery now preserves a running monitored action only when the protected scheduled-monitor envelope, receipt, finished observation job, reservation, attempt, grant, work, connection, profile, installation and evidence bindings prove its execute job is still queued and was never claimed. Claimed work retains the existing unknown/verification-only repair. Ordinary operation recovery is unchanged.
- B2: the repeated mutation fence now requires the exact current work revision and an open work phase before intent and provider dispatch. Cancellation or revision drift atomically fails the reserved attempt and job without calling the executor, releasing capacity, or restarting recurrence.
- B3: a purpose-specific pre-intent stop transaction appends the exact failed action outcome and retained failed grant settlement while terminalizing the claimed execute job with matching provenance. Connection or installation rejection therefore cannot strand a running action; persisted replay and reopen retain the terminal result. Any durable intent still preserves conservative unknown recovery.
- B4: policy selection is followed by a fresh original-fence check and a new current timestamp. Freshness is recomputed from that timestamp, and the admission transaction's commit guard synchronously rechecks abort/deadline and settlement authority. Stale evidence or cancelled lifecycle rolls back without observation completion, reservation, action, receipt, or execute job.

Round-1 raw evidence is adjacent:

- RED — `task-8b-fix-r1-red.log`: 10 tests / 1 pass / 9 expected failures. The claimed-interrupted recovery control already passed; queued recovery, both work changes, both pre-intent authority changes, and both post-selection commit guards failed as reported.
- Focused GREEN — `task-8b-fix-r1-green-focused.log`: build passed; 21 tests passed / 0 failed / 0 skipped. This includes the real `recoverLocalService` API for queued and claimed branches, ordinary recovery compatibility, work cancellation/revision, connection and inactive-installation rejection, stale time, commit-boundary cancellation, the original atomicity/capacity/duplicate/restart cases, and real page-derived dispatch.
- Adjacent compatibility — `task-8b-fix-r1-compatibility-final.log`: build passed; 427 tests passed / 0 failed / 0 skipped. The gate adds general operation recovery to the original browser, monitoring, service, encrypted-storage and visa compatibility set.

The final compatibility command was deliberately focused to Task 8B and adjacent contracts. Per the task brief, full `npm test`, `npm run verify`, hosted CI, and final product verification are deferred to the controller's Task 8 gate.

## Independent re-review fix round 2/5

The scoped re-review at `34df4b6` found two remaining Important issues, R1.1/B3 and R1.2/B4. The interrupted writer's three-file partial diff was recovered without discarding its valid tests or guards, then tightened where its first B3 assertion still left the intended action running until maintenance.

- R1.1/B3: `stopMonitoredActionJobBeforeIntent` now treats the action projection's exact durable intent and attempt as authoritative. A later unbound job cannot use its own absent `attemptId` to claim that no intent exists. Exact prior intent atomically records the existing attempt as `unknown`, retains the allowance with an `unknown` settlement, and stops only the later unbound job as ineligible. Confirmation without its exact intent, or any intent/confirmation attempt mismatch, fails closed as conflicting provenance. No executor runs, no failed downgrade is journaled, the action is immediately readback-eligible, and reopen/rebuild plus exclusive recovery preserve the result without another repair.
- R1.2/B4: the purpose-specific scheduled-admission transaction's final callback retains the original abort/deadline and settlement checks and now samples the injected clock again after observation-event construction, current-state work, reservation events, monitor completion, and execute receipt/job insertion. Crossing the durable monitor freshness limit at that boundary throws inside the transaction and rolls all observation, action, reservation, receipt, and job writes back.

Round-2 raw evidence is adjacent:

- RED — `task-8b-fix-r2-red.log`: against untouched base `34df4b6`, build passed and both final regressions failed (0 passed / 2 failed): the later job produced `action_failed`, and commit-boundary freshness did not reject. The recovered partial's strengthened immediate-unknown assertion separately failed 0/1 with the action still `running` before the final storage change.
- Focused GREEN — `task-8b-fix-r2-green-focused.log`: build passed; 23 tests passed / 0 failed / 0 skipped, including both residual regressions, B1–B4 round-1 cases, atomicity/capacity/duplicate/restart behavior, operation recovery, revocation, and the page-derived autonomous dispatch path.
- Adjacent compatibility — `task-8b-fix-r2-compatibility-final.log`: build passed; 429 tests passed / 0 failed / 0 skipped across browser, monitoring, service, operation recovery, encrypted storage/backup, and visa policy/adapter/runtime/recovery/observation suites.

As required by the increment brief, no full `npm test`, `npm run verify`, Task 8C work, hosted CI, or live-provider action was run. Independent round-2 re-review and the policy-mandated final high-risk review remain controller gates.

## Independent re-review fix round 3/5

The scoped round-2 re-review found one remaining Important R2.1/B4 ordering gap: the purpose-specific final guard ran after all writes but before reconstructing and cloning the transaction's return projection.

- `completeMonitorJobAndAdmitAction` now constructs the complete result, including the final projection read/decode and `structuredClone`, before invoking the existing purpose-specific guard. The guard still rechecks the original abort/deadline and settlement authority and samples the current observation age. It is now the last meaningful transaction callback work before returning directly to SQLite `COMMIT`; rejection rolls the complete admission back.
- The deterministic regression holds the observation at its inclusive 60,000 ms freshness boundary, then advances the injected clock by one millisecond only when the provisional transaction projection first contains the stopped monitor and running action. Before the ordering fix, admission committed. After it, the final guard rejects and the claimed monitor, observation, action, reservation, receipt, and execute job all roll back.

Round-3 raw evidence is adjacent:

- RED — `task-8b-fix-r3-red.log`: build passed; 0 tests passed / 1 failed with “Missing expected rejection,” exit 1.
- Focused GREEN — `task-8b-fix-r3-green-focused.log`: build passed; 24 tests passed / 0 failed / 0 skipped, covering the new last-projection crossing plus all prior Task 8B review regressions and the page-derived autonomous-dispatch path.
- Adjacent compatibility — `task-8b-fix-r3-compatibility-final.log`: build passed; 430 tests passed / 0 failed / 0 skipped across the same browser, monitoring, service, operation recovery, encrypted storage/backup, and visa compatibility boundary.

No general transaction callback, Task 8C behavior, full `npm test`, `npm run verify`, hosted CI, live-provider action, or external effect was introduced or run. Independent round-3 re-review and the policy-mandated final high-risk review remain controller gates.

## Boundaries and remaining gates

- No Task 8C composition/control/handoff work, Task 8D documentation/demo work, live adapter registration, credential use, portal access, browser installation, or external effect was added or exercised.
- The original four findings, two round-1 residuals, and sole round-2 residual are addressed, but independent round-3 re-review and the policy-mandated final high-risk review gate remain pending. This implementer does not self-certify either gate.
- The persisted observation remains the existing sanitized summary; the full candidate evidence is validated transiently at admission and represented durably by its authenticated digest, action, reservation, and protected queue envelope.

## Model-usage ledger

| Role | Model | Effort | Reason | Retries | Result |
| --- | --- | --- | --- | ---: | --- |
| Sole implementation writer | Primary session; model identifier not exposed to this writer | Not exposed | Queue/concurrency implementation and review-fix rounds under explicit one-writer/no-delegation constraint | 0 delegated retries | Four original findings, two round-1 residuals, and one round-2 residual reproduced and addressed; independent round-3 re-review pending |

No subagent, optional planner, research agent, or review context was used for Task 8B.
