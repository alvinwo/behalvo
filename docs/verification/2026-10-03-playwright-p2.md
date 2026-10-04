# Playwright P2 verification — 2026-10-03

Scope: the approved synthetic-only P2 design, based on merged P1 `6b6ef82`.
Implementation commits include shared process ownership, redirect-free forms,
synchronous durable dispatch guards, typed DOM action transport, and the bounded
paired-service workflow. No personal accounts, old Chrome profiles, model calls,
live sites, or real recipients were used.

## Local evidence

On macOS, Node 25.8.1, with canonical `TMPDIR=/private/tmp`, `npm run verify`
passed all six gates: check, demo, operations-demo, owner-control-demo,
service-demo, and git-diff-check. The offline suite reported 1,212 tests:
1,160 passed, 52 opt-in tests skipped, zero failures.

Terminal summary:
`data/verification/2026-10-04T03-48-59.504Z-fd117740-665f-46a7-a35f-c2383f5b8cde/summary.json`.
The dirty working-tree source fingerprint was unchanged across this run:
`abd9a94fa1b7c7201da115cffaa564d59ada0d901519c0b7bb81942679455524`.
Subsequent documentation-only edits added this record and its browser-guide
link, then clarified that pending portal/service startup may have no per-browser
receipt. No executable source changed after the final local run.

The combined P1/P2 visible suite passed 57/57, zero skipped, running files
serially. It covered P1 regression, redirect-free mechanism, all typed page states
and forms, source/document/epoch/token races, guard rejection, error-status DOM,
owned cleanup, paired service grants, empty polling, restart, handoff/resume,
candidate disappearance, one booking, readback, and replay without effects.
A lost actual submission response was reconciled through a fresh service/browser
without resubmitting. Missing and actually rendered mismatched readback both
preserved durable unknown status with one submission.

Ignored raw logs are under `data/verification/playwright-p2/`, including
`final-verify.log`, `final-visible.log`, review RED/GREEN logs, and service fault
regressions. Mechanism probes were feasibility evidence only; maintained visible
acceptance supplies the product evidence. Both public commands (`diagnostic` and `synthetic-actions`) exited 0 with
confirmed cleanup, Playwright 1.63.0 and Chromium 153.0.8010.12. Their logs are
`final-cli-diagnostic.log` and `final-cli-actions.log`.

Earlier unsuccessful checks are not counted as passing: a TypeScript literal
narrowing error was corrected; a full run found an extra EOF blank line; an
accidentally overlapping verification/visible run conflicted on the fixed portal
port. The final full run above ran alone and passed. An initial mismatched-readback
fixture changed a method whose return was not rendered; the corrected fixture
changes actual appointment DOM attributes and passes.

## Independent review and decisions

One final pair of independent contexts reviewed the PR: `gpt-5.6-sol` at high
for code/lifecycle and `gpt-6-astra` at high for architecture/security. They first
reviewed Tasks 1–3, then focused on Task 4 and changed findings. Both cleared all
code findings, conditional on final verification. These are development-session
agent reviews, not GitHub account approvals.

Confirmed findings fixed with targeted regressions:

- Captured source root ownership at activation and HTTP status matching actual
  parsed source/destination state, including comment spoofing and DOM drift.
- Exact final browser destruction after a terminal unknown response, without
  weakening handoff retirement.
- Fatal storage failures across the complete composed dispatch guard faulting
  the service before transport error sanitization.
- Late startup cleanup remaining pending until it settles, cleanup failure
  retention, temporary-root removal failures, and separate startup deadlines.

The primary agent was the sole implementation writer. Architecture/design used
Astra/max and independent Sol/high approval. Final reviewers reused the existing
Sol/high and Astra/high contexts; no replacement review pair was spawned. Source
ownership and fatal-domain fixes each needed one focused follow-up correction;
late cleanup and root removal fixes passed their targeted rereviews. No usage,
quota, or token consumption is inferred.

## Limits

Synthetic foreground/awake-only macOS acceptance does not establish live-site,
personal-account, unattended monitoring, cold-crash ownership recovery, or other
platform readiness. Active-operation handoff terminates the owned browser and
fails closed. CLI copy remains in the English catalog. Hosted CI must be checked
on the exact published head separately before merge.

## Hosted timing regression follow-up

The first final-head PR matrix passed, but the push matrix exposed an existing
10 ms operation-loop test that asserted one deadline message. The action was
correctly unknown and the reply prohibited retry; nested operation/loop timers
can produce either safe stop message. The test now allows 100 ms for dispatch
setup and asserts one dispatch, unknown/no-retry reply, durable unknown state,
completed inbox handling, and rejection of late effect success after store close.
No executable implementation changed. The complete operation-loop file passed locally (32/32). Fresh full verification
also passed all six gates with unchanged source fingerprint at
`data/verification/2026-10-04T03-59-19.664Z-3d48e845-be3b-464e-a32e-ec39fd8bdee2/summary.json`.
Both independent reviewers approved the test-only follow-up. Exact-head hosted
CI remains a separate merge requirement.

## Merge evidence

Both independent reviewers approved final head
`0e26f2a90048658277a3501590f62f66c7fd2d53` after the test-only correction.
Both Node 22.19 and Node 24 jobs passed in the
[pull-request run](https://github.com/alvinwo/behalvo/actions/runs/37175739334)
and [push run](https://github.com/alvinwo/behalvo/actions/runs/37175736186).
[PR #14](https://github.com/alvinwo/behalvo/pull/14) merged at
`4fa239488bcad79d11775368fa417559cc19bd70` on 2026-10-04 04:03:56 UTC.
Local master was fast-forwarded and its tree compared equal to the reviewed head.
[Post-merge CI](https://github.com/alvinwo/behalvo/actions/runs/37175898345)
also passed on exact merge commit `4fa239488bcad79d11775368fa417559cc19bd70`.
