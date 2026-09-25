# Task 8B fix-round-2 scoped re-review

## Scope and verdict

Exact range: `34df4b6d45f86e5d9bbc0d340f866b4eeeb47bba..6a5c7b5211b008d37231c62d421c38b7dd5f57b7`. HEAD matched the requested head on `feat/monitored-actions`; the worktree was clean before this report. This report is the only repository file written. No implementation, tests, index, HEAD, or branch changes were made.

**SPEC FAIL / QUALITY FAIL.** R1.1/B3 is addressed. R1.2/B4 is substantially narrowed but retains one Important commit-boundary gap, reproduced below. No Critical or Minor findings. This is a scoped task re-review, not a final whole-product, hosted-CI, release, or live-acceptance gate.

Read the repository AGENTS, Behalvo development/review-release/recovery instructions, model policy/configuration, README/SECURITY, architecture and monitored-action specifications, Task 8 plan/brief/wiring design, Task 8B brief/report, both prior Task 8B reviews, and progress. Inspected the complete exact diff, new raw evidence, and relevant monitoring, storage, reducer, operation recovery, runtime, and test paths. The external `requesting-code-review` skill was unavailable after the environment reset; the controller confirmed that limitation and directed use of repository review instructions and evidence-first review. No unavailable skill was claimed as read.

## Findings disposition

| Finding | Assessment |
| --- | --- |
| B1: queued/unclaimed recovery | Remains addressed in this range. The protected queued-envelope/receipt/observation/attempt checks and real `recoverLocalService` regression are unchanged; claimed work retains unknown recovery. |
| B2: work cancellation/revision | Remains addressed. Mutation fences still check current work revision and closed phase; readback remains exempt. |
| R1.1/B3: prior durable intent downgraded by a later unbound job | Addressed. The stop transaction reads action intent/confirmation before choosing failed settlement. Exact prior intent produces immediate unknown plus retained unknown settlement and stops the later job as ineligible atomically. Inconsistent attempt/confirmation provenance throws before writes. |
| R1.2/B4: freshness at actual commit boundary | Partially addressed. The new callback samples current time after writes and catches the earlier event-construction crossing. However, a whole projection read/decode and action clone still occur after that callback and before COMMIT. |

The deterministic scheduled identity, duplicate-before-capacity ordering, 64-waiting-job cap, single worker, purpose-specific transaction, automatic due-monitor dispatch path, rollback wrapper, and replay-only behavior are unchanged by this range. No Task 8C feature work or general transaction API was added.

## Evidence inspected and reviewer probes

- `task-8b-fix-r2-red.log`: build succeeded; final regressions on the recorded base failed 0/2 with `action_failed` and missing freshness rejection, exit 1. The strengthened recovered-partial test separately failed 0/1 with `running` instead of `unknown`, exit 1.
- `task-8b-fix-r2-green-focused.log`: build and 23/23 tests, no failures/skips, exit 0. Includes B1–B4 regressions and automatic dispatch/atomicity/capacity/duplicate/recovery cases.
- `task-8b-fix-r2-compatibility-final.log`: build and 429/429 tests, no failures/skips, exit 0. This artifact is the command, short tail, and terminal summary, not a complete per-test transcript.
- Independent `git diff --check` over the exact range passed.

Reviewer execution was limited to concrete-doubt probes against the existing compiled build, whose changed guard/provenance code was checked against source. Existing test helper definitions were loaded read-only into in-memory modules; only synthetic in-memory stores were used. No broad suite or build was rerun.

B3 was independently exercised both without and with a prior durable confirmation: enqueue through the due monitor; claim execute; record exact intent (and confirmation for the second variant); interrupt the first job; admit and drain a later unbound execute. Both variants made zero executor calls and immediately became unknown with unknown settlement. Then an ordinary readback admission through the runtime reached a synthetic verifier and reconciled to accepted/verified. The fixture's in-memory registration was extended only to supply `verifyReserved`; production files were unchanged.

```text
prior confirmation: false / true
executor calls: 0 / 0
later execute reason: action_ineligible / action_ineligible
readback calls: 1 / 1
readback reason: completed / completed
final action: accepted / accepted
final settlement: accepted_verified / accepted_verified
```

The persisted reopen/rebuild and real exclusive-recovery evidence is supplied by the inspected new regression and focused log, not represented as an independent rerun.

## Important residual finding

### R2.1 / B4 — Projection reconstruction still runs after the freshness/lifecycle guard

**Locations:** `src/storage/sqlite-store.ts:1153-1155`, `src/storage/sqlite-store.ts:139-145`; guard at `src/monitoring/service.ts:562-569`.

`completeMonitorJobAndAdmitAction` invokes `checkBeforeCommit()`, then evaluates its return object with `structuredClone(this.state(workspaceId).actions[input.action.id]!)`. `state()` reads and decodes the complete projection, including protected payload work where configured. Only after that function returns does `#transaction` execute COMMIT. Thus the new freshness read is after all writes but not after all transaction work. The same placement also leaves the original deadline check before this remaining work.

**Deterministic reproduction:** keep the existing fixture observation exactly at its allowed 60,000 ms age through the new callback. Wrap the public store method's existing guard only to mark that it has returned; wrap `state()` only to advance the injected clock by 1 ms during the following projection read. Neither wrapper modifies observation, state, journal data, admission fields, transaction results, or guard behavior. This models elapsed synchronous projection decoding after the check.

Observed result:

```json
{"ageAtReturn":60001,"limit":60000,"lateReadCount":1,"jobs":[["monitor","finished"],["execute","queued"]],"action":"running","grant":"blocked"}
```

The stale observation still irreversibly reserves the allowance and admits execution. The newly added regression advances time during event construction, before the guard, so it does not cover this final remaining phase. Ordinary projection read/decode/clone time can cross the same boundary without any second writer; the test only makes that elapsed-time boundary deterministic.

**Required fix:** finish constructing the result, including the final projection read and clone, before invoking the purpose-specific final guard. Keep the fresh observation-age check and original abort/deadline/settlement checks as the last meaningful work before COMMIT, preserving rollback on rejection. Add a regression that crosses freshness during this last result/projection construction step. No general transaction API or redesign is needed.

### Minimal probe core

Use the prior review's read-only fixture-loading prelude, exporting `fixture`, `configure`, `eligible`, `iso`, `base`, `currentFence`, and `workspaceId` from the current test helper prefix. Run from the reviewed worktree against its current `dist/index.js`.

```js
const clock = { milliseconds: base };
const f = fixture({ clock, observations: [eligible(iso(base))],
  beforeSelection() { clock.milliseconds = base + 60000; } });
configure(f, { jitterMs: 0 });
f.monitoring.admitDueMonitors({ instanceId: 'scheduler', at: iso(base), limit: 1 });
const job = f.store.claimServiceJob(workspaceId, 'worker', iso(base));
const originalAdmit = f.store.completeMonitorJobAndAdmitAction.bind(f.store);
const originalState = f.store.state.bind(f.store);
let guardReturned = false;
let lateReadCount = 0;
f.store.completeMonitorJobAndAdmitAction = (...args) => {
  const guard = args[3];
  args[3] = () => { guard(); guardReturned = true; };
  return originalAdmit(...args);
};
f.store.state = (...args) => {
  const state = originalState(...args);
  if (guardReturned) {
    clock.milliseconds++;
    lateReadCount++;
    guardReturned = false;
  }
  return state;
};
await f.monitoring.runJob(job, currentFence()); // unexpectedly commits
// Inspect originalState(workspaceId), serviceJobs, clock, and lateReadCount.
f.store.close();
```

## Assessment and ledger

B3's uncertainty/readback boundary is now correct in the reviewed scenarios. B4 needs one small ordering correction before the scoped gate can pass. Final Task 8 verification, independent high-risk final reviews, and later live/owner-laptop gates remain separate and pending; their absence is not a new Task 8B finding.

| Role | Model | Effort | Reason | Retries | Result |
| --- | --- | --- | --- | ---: | --- |
| Independent scoped re-reviewer | Controller-selected; identifier not exposed here | Controller-selected; not independently observable here | B3/B4 round-2 validation and B1/B2 regression inspection | 0 delegated retries | SPEC FAIL / QUALITY FAIL; one reproduced Important B4 residual |

No subagents, implementation edits, publication, network/provider effects, or external coordination were performed.
