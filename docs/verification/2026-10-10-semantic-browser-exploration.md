# T1b semantic browser exploration — 2026-10-10

Scope: the approved teachable-browser design, synthetic exploration only. The
primary implemented on `codex/semantic-browser-exploration` from merged PR17
`d9a95266187d9870e11b121578e4626d4ee97edc`. No live account, real portal, email
integration, persistent personal profile or booking was used.

## Implemented boundaries

The model chooses opaque controls from fresh observations across three fixtures:
two appointment layouts and one class directory. The independent request policy
has no goal planner or preferred answer. Owner instructions, observed page data,
advisory notes and task-input authorization have separate provenance. Projection
v3 retains immutable source evidence, validates upgrades/backups and replays
without browser effects. The CLI enables this with `--synthetic-browser`.

## Development evidence

Local evidence is under `data/verification/semantic-browser/` (ignored). Missing
contracts, learning modules, note context, runtime tools and CLI mode produced
recorded RED tests before implementation. Focused GREEN runs cover contracts,
visible adapter interactions, storage/replay/migration, runtime restrictions and
CLI compatibility. Expanded race tests reproduced pre-fix dispatch, observation
and stale-settlement failures. Later coverage additions are not claimed as RED.

- `races-red.log`: four reproduced failures; `races-green.log`: 21 passing tests.
- `settlement-red.log`: stale empty-note final reply reproduced;
  `settlement-green.log`: 12 passing tests including late opening and SQLite lock.
- `select-green.log`: visible observed-option selection and filter navigation pass.
- `acceptance-build.log`: three scripted combined teach/explore/restart/correct
  browser scenarios pass. These are deterministic tests, not live-model evidence.
- `cli-green-canonical-tmp.log`: 29 tests pass after setting `TMPDIR=/private/tmp`.
  The previous copied-CLI test failure arose from macOS temporary-path symlink
  identity; no product workaround or authentication change was introduced.
- Initial full verify test stage: 1,239 passed, 63 optional tests skipped, zero
  failures. Final release evidence is recorded separately below.

Independent Sol/high and Astra/high reviewers found dispatch-time input
revocation, document freshness, stale final settlement and cleanup-reporting
issues. Each was fixed and focused re-reviewed; both reported no remaining
blockers. Reviewers did not claim to run the full suite.

Live diagnostics are retained, including failures. The first mixed instruction
and execution message produced a teaching-only acknowledgment. A subsequent run
showed the model needed explicit application-level JSON tool availability. The
protocol was clarified; its initial unconditional observation wording then caused
repeated observations, corrected to observe only an empty transcript and use the
latest evidence afterward. No call/deadline limit or acceptance criterion was
relaxed. Historical notes remain advisory even if the model recommends from them.

## Final release gates

Implementation source: `96b12878b8c4a8fdd7172c8d1fd7d4bf5d853123`.

- `npm run verify` passed all six stages on that clean, unchanged head: 1,240 tests
  passed, 63 optional tests skipped, zero failures. Summary:
  `data/verification/2026-10-11T05-15-34.609Z-810b0f1a-2783-467b-9576-d330981abb5c/summary.json`.
  Stages include check, demo, operations demo, owner-control demo, service demo and
  diff check. The earlier attempt correctly failed its overall source-fingerprint
  guard when implementation edits occurred during the run; it is not release evidence.
- `visible-final.log`: all 25 visible adapter, combined teaching/exploration and
  runtime regression tests passed, with no skips. This supplements the optional
  browser tests skipped by the default offline verification command.
- Clean-source `openai-codex/gpt-6-astra` live acceptance passed on all three sites:
  15 stages, 36 model calls, 12 browser observations/interactions, six confirmed
  browser cleanups and zero fixture effects. Report:
  `data/verification/semantic-browser/live-1791695882075.json`.
  Teach → explore/recommend/learn → reopen SQLite/rebuild/recall → correct →
  re-explore passed for both appointment layouts and the class directory.
  Model choices changed from Cedar/Maple/Drawing at 09:00 to Pine/Birch/Pottery at
  15:00 after the owner correction. The model chose opaque observed controls;
  the runtime had no scripted answer or route plan. Replies explicitly qualified
  availability and historical recall. This is one bounded successful run, not a
  statistical reliability or general human-usefulness claim.
- Independent Sol/high and Astra/high approved final source, including the protocol
  clarification. A guide-only correction now distinguishes creating a task from
  selecting it with `/work`. No executable source changed after clean verification.

Exact PR-head hosted CI and merge remain release-time gates; their results belong
in the PR record. A configured workflow alone is not evidence of passing CI.

## Limits and next increment

T1 acceptance measures synthetic teaching, exploration, remembered navigation,
restart recall and correction. It does not prove robustness on arbitrary
JavaScript sites, live session custody, portal terms, authenticated readiness,
continuous monitoring, real booking or general human usefulness. T2 requires a
separately reviewed supervised live scope and private session design; T3 requires
consequential-action approval and independent readback.
