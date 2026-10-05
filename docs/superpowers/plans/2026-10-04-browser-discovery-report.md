# Synthetic Browser Discovery Report Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Export bounded, explicitly synthetic discovery evidence from the existing
13 read-only P2 browser cases, preserving partial coverage and all live gates.

**Architecture:** Pure verification helpers map strictly parsed browser snapshots
to a fixed metadata catalog. The existing test harness supplies observations and
cleanup results; a private workspace/run directory holds one validated report.
No production registration path consumes it.

**Tech Stack:** Node.js ESM test-support scripts, existing compiled snapshot parser,
Node test runner, Git provenance and the already-pinned Playwright acceptance path.

**Spec:** [Approved scope](../specs/2026-10-04-browser-discovery-scope.md).
Plan status: approved by independent Sol-high review on 2026-10-04 after the
state-only coverage, canonical repository boundary and installed-version clarifications. The owner
has authorized implementation/testing/review/merge within the approved scope;
this plan adds no live-access permission. Base: `3213ab1`, P2 merge `4fa2394`.

## Global Constraints

- Format `synthetic-browser-discovery-v1`; source `synthetic_owned_playwright`;
  origin `http://127.0.0.1:43117`; `liveRegistration: 'disabled'`.
- Maximum serialized report size `65_536` UTF-8 bytes, including final newline.
- Exactly the 13 existing read-only cases below; no calendar case or booking run
  added to populate the report. No browser mode, transport, runtime authority,
  production import route, dependency or authenticated discovery fixture change.
- Node `>=22.19.0`, Playwright `1.63.0`; existing visible/owned P2 limits apply.
- New implementation is verification/test support `.mjs`, not `src/` or public
  library exports. Use synthetic data; exclude raw values and arbitrary errors.
- Reports are opt-in via `BEHALVO_BROWSER_DISCOVERY_REPORT=1`; visible execution
  still independently requires `BEHALVO_PLAYWRIGHT_P2_ACCEPTANCE=1`.
- Implement behavior tests first, run affected visible tests serially, preserve
  independent reviews and exact-commit evidence before an authorized merge.

## Review Focus

1. Valid-looking snapshots with extra secret fields must reject before mapping,
   with no canary in report/error output (Task 1).
2. Skipped/missing cases or rejected cleanup must never produce an overall pass;
   seeded confirmation is not workflow or live evidence (Tasks 1 and 3).
3. Dirty or changing source must never be labeled a tested clean commit (Task 2).
4. Traversal, symlinks, existing report targets or cross-workspace destinations
   must not redirect or overwrite report output (Task 2).
5. A complete synthetic report must remain unusable as an authenticated live
   fixture, adapter registration or grant authority (Tasks 1 and 3).

---

## Fixed catalog and report contract

Use the current loop's exact order and matching page-state names:
`login`, `security_question`, `group_roster`, `booking_review`, `challenge`,
`session_expired`, `forbidden`, `rate_limited`, `terms_changed`, `unknown`,
`confirmation`, `ambiguous_submission`, `appointment`.

Every case has `page_state`; additional applicable checks are fixed:

| Case | Additional checks and strictly parsed source fields |
| --- | --- |
| `group_roster` | `identity_digest`, `subject_digest`, `roster_digest`, `terms_version` from the corresponding required fields |
| `booking_review` | `review_contract` from the complete strict booking-review snapshot |
| `confirmation` | `booking_contract` from its complete strict booking object |
| `ambiguous_submission` | `intent_field` from its required intent ID |
| `appointment` | `booking_contract`, `appointment_complete` from booking and `complete: true` |
| Other cases | No additional checks: the strict observation proves only the synthetic page-state contract, with no control/credential coverage |

Check values are only `observed`, `unobserved`, `rejected`; no values/digests from
snapshots are exported. Strictly call `parseBrowserSnapshot(raw)` before reading
fields and require the expected case state. Unknown/extra fields, wrong state or
malformed nested data reject; do not sanitize an invalid snapshot into validity.

Every report also lists fixed gaps, always `unobserved`: `calendar_pagination`,
`live_identity`, `complete_roster`, `terms_permission`, `live_origin_graph`,
`polling_plan`, `authenticated_profile_custody`, `live_state_reachability`.
A group digest cannot prove full membership; directly seeded pages never prove a
live transition. `passed` means this synthetic fixture catalog passed, not that
these gaps are resolved.

Top-level exact keys: `format`, `source`, `origin`, `liveRegistration`,
`workspaceId`, `runId`, `versions`, `provenance`, `cases`, `gaps`, `counts`,
`cleanup`, `result`. Hardcode format/source/origin/liveRegistration. Versions are
`{ adapterId: 'us-visa-china', adapterVersion: 1, playwright: '1.63.0',
node: process.versions.node, browser: string | null }`. Read the installed Playwright package version and adapter constants, then validate the supported exact pin; do not substitute a literal for observed package metadata. Browser comes from owner
ready results and must agree across executed cases, using numeric version syntax.
A missing version prevents pass. Workspace is fixed `synthetic-browser-discovery`;
run ID is a generated UUID. These are verification identifiers, not owner identity.

Each case has exact keys `caseId`, `pageState`, `provenance: 'fixture_seeded'`,
`outcome`, `code`, `checks`, `cleanup`, `gestureCount`, `postCount`.
`outcome` is `observed | rejected | skipped | missing`; code is respectively
`none`, a fixed `observation_failed | assertion_failed | cleanup_pending |
unexpected_request`, `not_enabled | filtered`, or `missing_case`.
No raw Error/cause or arbitrary message is retained. Request counts are
nonnegative safe integers, or `null` when unavailable after failure; a passing
case requires measured zero gestures and zero portal POSTs.
Cleanup is `confirmed | pending`; no acquired resources means confirmed cleanup,
but never converts a skipped case into observed evidence.

The builder emits all 13 cases in catalog order and rejects duplicate/unknown
case IDs. Missing rows become `missing` with unobserved checks. Rejected cases
have rejected checks; skipped/missing rows have unobserved checks. Counts contain
`expected: 13`, `executed` (observed + rejected), `skipped`, `missing`, `rejected`.
Overall `result` is `failed` for any rejected case, pending cleanup, unexpected
request or changed source; otherwise `incomplete` for skipped/missing cases or
missing version; otherwise `passed`. Recompute/validate counts, checks and result
when serializing; callers cannot supply a fabricated aggregate pass.

## Task 1: Strict catalog, mapping and authority separation

**Files:** Create `tests/helpers/browser-discovery-report.mjs` and
`tests/browser-discovery-report.test.mjs`. Read, do not modify,
`src/browser/types.ts` and `src/adapters/us-visa-china/discovery.ts`.

**Interfaces:** Export `DISCOVERY_CASES` (frozen catalog),
`mapDiscoverySnapshot(caseId, rawSnapshot)` (fixed check-status object),
`buildDiscoveryReport({ workspaceId, runId, versions, provenance, cases })`
(validated plain report), and `serializeDiscoveryReport(report)` (bounded UTF-8
Buffer with final newline). Document shapes above with JSDoc; reject extra keys.

- [ ] Write tests `strict_snapshot_mapping`, `fixed_partial_catalog`,
  `nonpassing_aggregate`, `report_size_bound`, `sensitive_canary_exclusion`, and
  `report_cannot_become_live_fixture`. Use actual strict fixture snapshots and
  random extra-field canaries; assert extra fields reject rather than disappear.
  Pin every catalog mapping, exact counts, deterministic order, duplicate rejection,
  skipped/missing/rejected/pending nonpass and gap statuses. Representative checks:

  ```js
  assert.throws(() => mapDiscoverySnapshot('login', { state: 'login', password: canary }));
  assert.equal(partial.result, 'incomplete');
  assert.equal(pending.result, 'failed');
  assert.equal(full.liveRegistration, 'disabled');
  assert.equal(full.gaps.complete_roster, 'unobserved');
  assert.equal(serialized.includes(Buffer.from(canary)), false);
  ```

- [ ] Run `npm run build && node --test tests/browser-discovery-report.test.mjs`;
  observe failure for the missing implementation.
- [ ] Implement the fixed catalog/mapping/validation, importing only the compiled
  `parseBrowserSnapshot` for snapshot parsing. Expose fixed errors only. Reject
  non-plain objects, accessors, extra keys, invalid strings/numbers and oversized
  input before serializing; do not invoke arbitrary `toJSON` methods.
- [ ] Test the report as input to existing fixture creation/readiness validation:
  it rejects, and the default registry still exposes the live adapter as disabled.
  Keep existing authenticator/HTTPS/complete-state validators unchanged.
- [ ] Run the report test plus `tests/us-visa-discovery.test.mjs`; expect pass.
  Commit as `feat: define sanitized synthetic browser discovery reports`.

## Task 2: Honest provenance and bounded private persistence

**Files:** Create `tests/helpers/browser-discovery-report-io.mjs`; extend
`tests/browser-discovery-report.test.mjs`. No generic artifact framework.

**Interfaces:** `captureDiscoverySource(repoRoot): Promise<{ head, dirty,
fingerprint }>`; `createDiscoveryReportRun(repoRoot): { workspaceId, runId,
runDirectory }`; `persistDiscoveryReport(run, report): string` returns exact final
path. `head` is a Git commit hex ID and `fingerprint` is SHA-256, not source text.
The returned run is an opaque helper-owned handle capturing its canonical root
and directory identity; reject forged/reused handles and mismatched report IDs.

- [ ] Write tests `clean_and_dirty_provenance`, `source_changed_is_nonpassing`,
  `workspace_run_path_is_private`, `unsafe_or_existing_target_rejected`,
  `atomic_bounded_report_write`, and `persistence_errors_are_fixed`. Exercise
  staged/unstaged/untracked source changes, wrong workspace/run, traversal,
  symlinks, existing targets, oversized output and write/publish failure.
- [ ] Run the report test; observe the new behavior failing.
- [ ] Implement provenance using the existing `scripts/verify.mjs` strategy:
  hash tracked diff and nonignored untracked file contents, observe staged and
  unstaged dirtiness, and capture HEAD before/after the cases. Keep Git invocation
  shell-free and bounded; never export diffs, filenames, remote URLs or stderr.
  Do not alter `scripts/verify.mjs` for this increment.
- [ ] Emit one discriminated provenance object: `{ kind: 'clean_commit', commit }`
  only when both snapshots are clean and identical; otherwise
  `{ kind: 'dirty_tree', baseCommit, beforeFingerprint, afterFingerprint,
  changedDuringRun }`. A HEAD/fingerprint change sets `changedDuringRun: true`
  and overall failure. Stable dirty evidence may pass fixture assertions but is
  never described as clean-commit evidence. Provenance collection failure fails
  the run rather than guessing a clean revision.
- [ ] Persist only below canonical repository
  `data/verification/browser-discovery/synthetic-browser-discovery/<run-UUID>/`.
  No output-path environment variable or user-selected workspace is introduced.
  Create dedicated output/workspace/run directories owner-only (`0700`); reject
  symlinks, non-directories, wrong owners, unsafe existing modes and workspace/run
  mismatches. Canonicalize the repository root. Check ownership and reject group/other write permissions on that root and every output-path descendant, rejecting symlinks below the root. Do not impose these requirements on system ancestors above the canonical root: sticky `/private/tmp` is valid for temporary test repositories.
- [ ] Serialize/validate before writing. Create a private temporary regular file
  exclusively with `0600` and no symlink following; write/fsync, then publish
  `report.json` without replacing an existing target (exclusive hard-link publish
  is sufficient), remove only the exact temporary file and sync the directory.
  Recheck exact directory identity before publication. Failure never yields a
  claimed successful report; leave unrelated files untouched. No recursive cleanup
  or report pruning. A directory with no finalized report is not passing evidence.
- [ ] Run the report test; expect pass, including mode/path/failure assertions.
  Commit as `feat: persist scoped browser discovery verification evidence`.

## Task 3: Collect from existing read-only cases and reconcile documentation

**Files:** Modify `tests/playwright-actions-acceptance.test.mjs`,
`docs/ROADMAP.md`, `docs/VISA_DISCOVERY.md`, `docs/PLAYWRIGHT_BROWSER.md`;
extend the report test; create
`docs/verification/2026-10-04-browser-discovery-report.md` after actual verification.

**Interfaces:** The existing 13-case loop uses `DISCOVERY_CASES`; collect only its
actual awaited `session.recognize` result after strict parsing and fixture-equality
assertion. The opt-in collector uses Tasks 1–2. All other acceptance tests retain
existing behavior and contribute no discovery rows.

- [ ] Write collector regressions for actual snapshot versus seeded expected data,
  failed equality assertion, skipped/filtered cases, failed setup, cleanup rejection,
  positive gesture/POST count, inconsistent browser version and finalization after
  cleanup. The current fixture swallows session shutdown rejection: replace that
  evidence loss for report cases with explicit collected cleanup results.
- [ ] Run the offline report test and observe collector behavior failing before
  wiring it. Keep dependency seams confined to trusted test support.
- [ ] Add opt-in collection with one before-run provenance capture and one final
  suite hook after all case cleanup. Observe portal POST requests independently
  of successful `state.gesture` calls, so rejected POSTs still break read-only
  evidence. Preserve existing assertions; neither catch-and-record nor report
  writing may turn a failed test into a passing test. Record fixed failure codes.
- [ ] Publish once, after cleanup and source capture. Missing/filtered cases stay
  missing/skipped. Without the visible opt-in, all cases are skipped and a
  requested report is incomplete. A requested nonpassing report makes the report
  run exit nonzero; report creation alone is not acceptance. When report opt-in
  is absent, produce no report files and preserve current test behavior.
- [ ] Run `npm run verify`, then the existing cases explicitly and serially:

  ```sh
  TMPDIR=/private/tmp BEHALVO_PLAYWRIGHT_P2_ACCEPTANCE=1 BEHALVO_BROWSER_DISCOVERY_REPORT=1 node --test --test-concurrency=1 --test-name-pattern='^visible DOM parser reads the actual .* contract$' tests/playwright-actions-acceptance.test.mjs
  ```

  Expect 13 catalog cases observed, zero gestures/POSTs, confirmed cleanup,
  `result: passed`, all fixed gaps unobserved, and an exact private report path.
  Noncatalog tests filtered by this command are not catalog skips. Also prove
  report-without-visible-opt-in emits a nonpassing report and nonzero exit.
- [ ] Reconcile ROADMAP/VISA_DISCOVERY around transport-neutral outcomes while
  retaining explicit unresolved extension/native-host/helper or replacement gates.
  Document the opt-in report command, fixed local output, provenance, synthetic
  meaning of pass, partial coverage and no live authority in the browser guide.
  Record actual commands, revision/provenance, executed/skipped counts, report
  path, cleanup and failures; never copy raw HTML or secret canaries into docs.
- [ ] Run `git diff --check`, local documentation links and the report test after
  doc changes. Commit as `feat: export read-only browser discovery evidence`.
  Obtain independent code/security reviews and fix supported findings before the
  authorized push/merge, checking exact-head local evidence and actual hosted CI.

## Self-review and handoff

All fixed cases/checks, partial/nonpassing rules, source provenance and output
boundaries are defined above; the three tasks own each Review Focus regression.
No live validator, runtime capability, grant or report-ingestion route changes.
This plan now goes to independent review; primary remains the sole implementation
writer. No further product choice is required for the synthetic increment.
