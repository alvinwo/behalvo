# Chrome M1 review fixes — laptop execution

Plan: `docs/superpowers/plans/2026-09-29-chrome-m1-review-fixes.md`.

## Reconciliation and scope

Executed directly on Darwin in `/Users/alvinwo/Documents/workspace/behalvo`.
Initial clean local master was `5d250f925ce890244c1b7fd75e3c6a15f5fade2f`;
fetch found master `09b99e6b9464b0765a7fa1bc517c34ea47cce405` and feature/PR #12
head `3cb1f1aaf72ae0f2a12aaac6aaeac0e664c5fcff`. Created the local tracking feature
branch in the existing clean checkout. No local divergence, untracked files, or
other worktrees existed. Local master was left untouched.

PR #12 was open/draft with no GitHub discussion/reviews. Run `36529196795` had
1,098 tests, 1,092 passed, two failed (both R1 regressions), four skipped on
Node 22.19; the other matrix lane was cancelled. Raw failure log retained at
`/private/tmp/behalvo-initial-ci.log`.

Ruling: execute the existing plan inline, as explicitly requested by the owner.
Use independent reviewers for required review, never self-certify. No merge or
installed Chrome/live-account action is authorized by this execution record.
The historical cloud-only workflow notes are superseded by observed laptop tools.

Pre-flight: installation metadata is consumed by broker/rendezvous/CLI; synthetic
fixtures must use the dedicated registration layout. Coordinator shutdown depends
on transport completion and rendezvous close; implement those boundaries without
introducing reconnect/recovery authority. Signal cleanup uses that same lifecycle.

## Local environment and evidence

Default Node 22.17 is below the required minimum. Local commands use installed
Node 25.8.1 (`PATH=/opt/homebrew/opt/node/bin:$PATH`) and `TMPDIR=/private/tmp`.
The default macOS temp directory has a symlink ancestor, intentionally rejected by
canonical custody validation; it masked the unrelated-directory RED on the first
attempt. With canonical temporary roots, both R1 tests failed as expected before
production edits. Logs: `data/verification/chrome-review/r1-red-canonical.log`.
Hosted Node 22.19/24 evidence is tracked separately below.

## Progress

- R1: reproduced both current tests; staging previously demanded an existing
  registration directory before creating its parent profile and accepted unrelated
  directories. Correction binds stage/load metadata to the exact dedicated profile
  location, creates the registration directory after profile creation, and migrates
  installation callers' synthetic fixtures.
- R2–R8: implemented and independently reviewed; see final gate evidence below.

## Reviews and final gates

This section records initial pending gates. Current results are in the final gate
record below; installed Chrome acceptance remains pending. No acceptance is inferred
from synthetic tests.

R1 focused GREEN: build succeeded; 19 installation/CLI/broker/rendezvous tests
passed with no failures/skips. Log: `data/verification/chrome-review/r1-green.log`.
The first regression attempt was sandbox-blocked (`listen EPERM`); rerunning with
local socket permission resolved that environmental restriction.

R6 RED: all three dangling Singleton markers permitted removal before the fix.
R7 RED: doctor stayed configured after changing an imported compiled helper.
Logs: `r6-red.log` and `r6-green-r7-red.log` in the same local evidence directory.
R6/R7 GREEN: 12 installation tests passed, no failures/skips; build passed.
Ruling: hash the compiled dist JavaScript/JSON bundle plus package module metadata,
not only the broker entry. The current broker uses local compiled helpers and Node
built-ins. Legacy metadata without a bundle pin remains readable for explicit
removal but cannot pass source verification. No signing claim is made.

Task 1 full suite: `npm test` passed 1,098 of 1,102 tests, four skipped,
zero failures (Node 25.8.1, Darwin). Log: `task1-suite.log`.

Task 1 published via authenticated Git with preserved ancestry; remote confirmed
`47afbb9706c743099a56d62eee635b0fb7be5a54` after a pre-push head check.
Focused task review requested in an independent Sol-high context (actual tool
selection `gpt-6-sol`, high; policy default is `gpt-5.6-sol`; no effort downgrade).

Task 2 R2/R3: eight new coordinator regressions failed before changes, including
channel loss followed by normal Chrome exit, all three pre-launch startup failures,
failed transport/service/rendezvous shutdown, and rejected exit observation.
Correction observes transport completion during inspection and the Chrome wait;
releases custody only after complete cleanup and either no launched Chrome or a
fulfilled exit observation. Existing lease release performs the idle-profile check.
The prior success fixture incorrectly used an already-completed channel; corrected
to a pending channel for the active session. Build and all 14 coordinator tests
passed. Logs: `r2-r3-red.log`, `r2-r3-green.log`.

Task 1 independent review found an exact-content native manifest symlink could
still pass finalization/doctor. Confirmed with a RED behavior test; now validate
the manifest as a canonical, single-link, owner-only regular file for finalization,
doctor and removal. The target is preserved on rejection.

Task 3 R4/R5: both no-input and partial-input broker children exceeded 6.5 seconds
instead of exiting after their handshake deadline; rendezvous close exceeded
750 ms with a stalled pre-enrollment subprocess. Logs: `r4-r5-red.log`.
The broker now destroys native input on handshake teardown as well as relay exit.
Rendezvous tracks all accepted sockets/handlers, destroys them on shutdown, and
closes other pending sockets when one channel enrolls. No reconnect is introduced.
Build plus 36 installation/coordinator/broker/rendezvous tests passed, including
all new subprocess regressions and the manifest-symlink regression. Log:
`task3-green.log`.

Independent Task 2/3 review (same gpt-6-sol high context) confirmed the manifest
fix and identified suppressed rendezvous cleanup errors. A new real-rendezvous
regression reproduced success with an unknown runtime artifact retained. The fix
preserves it and rejects close, so coordinator custody remains held. RED log:
`r3-runtime-red.log`.

Task 4 R8: after correcting a fixture import typo (not counted as RED), all four
SIGINT/SIGTERM × enrollment/inspected subprocess tests observed abrupt signal exit
before production edits. The correction installs/removes CLI signal handlers,
passes cancellation to the coordinator, races enrollment/inspect/Chrome wait,
bounds resource cleanup and owned Chrome termination, and reports a fixed cleanup
pending error when shutdown evidence is incomplete. Signal subprocess tests use an
actual separate synthetic Chrome process that ignores SIGTERM, plus real profile
custody. They confirm key bytes are cleared and custody retained. Build and all
23 CLI/coordinator/signal tests passed; logs `r8-red.log`, `r8-green.log`.
CLI diagnostic codes follow the existing English fixed-error pattern; no locale
catalog or UI localization framework exists, and no framework was introduced.

All-fixes full suite: `npm test` passed 1,115 of 1,119 tests, zero failures,
four skipped. This includes the real-rendezvous cleanup follow-up. Raw log:
`data/verification/chrome-review/all-fixes-suite.log`.

## Final review round and verification

The clean implementation head `efcaab8ba09819e5a98346324fdf5a30d98e7b1a`
(tree `01772738c01b102786a4e75056266e2f2199f084`) passed laptop `npm run verify`.
All six steps exited zero; HEAD and source fingerprint were unchanged and the tree
was clean. Terminal summary/raw logs:
`data/verification/2026-09-29T06-52-44.615Z-e514179c-dad6-4355-a462-5fa87bd2faac/`.
Published with normal Git after remote ancestry check. Hosted PR run
[36533577896](https://github.com/alvinwo/behalvo/actions/runs/36533577896)
passed both Node 22.19 and Node 24 at that head. These results do not certify later
changed code.

Independent full-PR Astra-high review found one P2: ordinary enrollment/channel
failure can finish coordinator cleanup after five seconds yet keep the CLI alive
through an unconfirmed owned Chrome process handle/stderr. A subprocess regression
confirmed no process exit after 7.5 seconds (RED `r8-nonsignal-red.log`). The fix
destroys the owned stderr pipe and unreferences the owned child after failed exit
observation; it never releases custody or retries. All incomplete cleanup now
reports the fixed cleanup-pending result, including non-signal failures. Build and
24 CLI/coordinator/signal subprocess regressions passed (`r8-nonsignal-green.log`).
Final verification and focused reviewer confirmation must target the corrected head.

Ruling: retain R2's conservative fail-stop rule. Native-port closure before an
observed Chrome exit cannot become success merely because Chrome exits later.
Actual normal Chrome shutdown ordering is an owner-laptop acceptance uncertainty,
not established by synthetic tests. M2/M3/live readiness and merge permission are
outside the review's approved M1 scope.

Astra's focused re-review cleared the non-signal shutdown finding at `8587bd5`.
That clean head independently passed all six laptop `npm run verify` steps;
summary: `data/verification/2026-09-29T06-58-18.618Z-925cfe90-fd08-41ee-ac5b-8a37216b8d8e/summary.json`.

Sol's full-PR review independently confirmed the same shutdown issue and found a
second R3 edge case: a confirmed OS spawn failure was treated as an unconfirmed
running Chrome process. A missing-executable test with real profile custody
reproduced the stranded lease (RED `r3-spawn-red.log`). The launcher now records
whether the OS emitted `spawn`; an error before that event is explicit
never-launched evidence. Only that known outcome permits release after complete
cleanup and the existing idle-profile check. Unknown rejected exit observations
remain fail-closed. Build and all 15 coordinator regressions passed
(`r3-spawn-green.log`).

Sol completed the full PR review and cleared both lifecycle corrections through
`e38ef38`. Its remaining P2 was dangling generated-artifact conflicts: `existsSync`
missed metadata/launcher/extension symlinks, allowing partial setup writes before
failure. All three cases reproduced that mutation before the fix. Setup preflight
now detects entries without following links. Logs: `r1-conflicts-red.log` and
`r1-conflicts-green.log`; build and 16 installation tests passed.

## Reviewed final code and laptop gate

Final code head: `0d554eb3afce1af2ae1c93962693881f0ad42aa6`.
Tree: `422e45d658b595064fa557eae1557f08ccff0373`.
Review base: `09b99e6b9464b0765a7fa1bc517c34ea47cce405`.

Both independent required full-PR review contexts cleared all supported findings
through this code head after focused re-review:

| Role/context | Model | Effort | Result |
| --- | --- | --- | --- |
| Focused Tasks 1–3, `installation_review` | gpt-6-sol | high | Manifest symlink and suppressed runtime cleanup findings reproduced and corrected; final pair reviewed the later result. This task seat used a newer Sol model rather than the configured gpt-5.6-sol default. |
| Independent final, `final_sol_review` | gpt-5.6-sol | high | Three P2 findings reproduced and corrected; no outstanding supported defects through `0d554eb`. |
| Independent final, `final_astra_review` | gpt-6-astra | high | One P2 finding reproduced and corrected; later Sol corrections also cleared in focused re-review through `0d554eb`. |
| Sole implementation writer | Primary session; exact model/effort not exposed in session metadata | Unchanged | Local implementation, test execution, Git/gh publication; no implementer self-certification. |

No reviewer rebuilt or edited the shared checkout. They inspected full PR source,
focused corrections, and recorded raw RED/GREEN verification. Astra also reproduced
the retained child-handle failure with an independent synthetic subprocess. Review
retries: zero unsuccessful fix attempts; follow-ups were focused re-reviews of
supported changed findings. No paid/provider fallback or new runtime agent added.

Laptop `npm run verify` on this exact clean head **passed**: **1,124 tests,
1,120 passed, zero failed, four skipped**. Check, demo, operations-demo,
owner-control-demo, service-demo and git-diff-check each exited zero. HEAD, clean
status and source fingerprint were unchanged across the run.

- Terminal summary and raw logs:
  `data/verification/2026-09-29T07-02-38.538Z-153cbb4d-2778-4ce0-ab93-1690bc4ed52c/`.
- Combined output: `data/verification/chrome-review/verify-0d554eb.log`.
- Runtime: Node 25.8.1, npm 11.11.0, Darwin, canonical `/private/tmp` fixtures.
- Normal Git publication confirmed the exact remote branch head `0d554eb` after
  verifying the previous remote head was `efcaab8`. No reset, force-push or merge.

The subsequent handoff checkpoint changes documentation only. Its GitHub checks
and laptop terminal summary identify that documentation commit separately; it does
not change the reviewed executable code. Use the exact current PR SHA and terminal
`summary.json` status when resuming, not an inferred pass from configured CI.

Hosted final-code PR run
[36534553233](https://github.com/alvinwo/behalvo/actions/runs/36534553233)
completed **successfully** on exact head
`0d554eb3afce1af2ae1c93962693881f0ad42aa6`. Both `check (22.19.0)` and
`check (24.x)` passed their `npm run verify` gates. Observed Node 22.19 summary:
1,124 tests, 1,120 passed, zero failures, four skipped. Raw hosted log retained at
`data/verification/chrome-review/ci-0d554eb.log`; GitHub also retains per-lane
verification artifacts. PR #12 remains draft; no merge occurred.

## Remaining gates and next action

Installed owner-laptop Chrome acceptance is **not performed**. No everyday profile
or live account was opened. Real native messaging invocation, enrollment, normal
Chrome shutdown ordering and clean custody release require supervised acceptance
in the exact dedicated synthetic profile. The explicit no-reconnect/no-live-authority
scope remains. Merge requires separate owner authorization. See `RESUME.md` for
continuation; do not restart exhausted historical object recovery.
