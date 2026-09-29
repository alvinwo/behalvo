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
- R2–R8: pending implementation and verification.

## Reviews and final gates

Independent task/final reviews, final local verification, exact-head hosted CI,
and installed Chrome acceptance are pending. No acceptance is inferred from tests.

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
