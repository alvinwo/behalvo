# Synthetic browser discovery report verification — 2026-10-04

Scope: test-only metadata exporter, approved in the
[scope](../superpowers/specs/2026-10-04-browser-discovery-scope.md) and
[plan](../superpowers/plans/2026-10-04-browser-discovery-report.md).
Base: merged P2 `4fa239488bcad79d11775368fa417559cc19bd70`.
Primary is the sole implementation writer in the continuing feature checkout.

## Evidence actually obtained

Environment: macOS, Node 25.8.1, installed Playwright 1.63.0, synthetic loopback
portal only. `PATH` selected Homebrew Node; `TMPDIR=/private/tmp` used canonical
private temporary paths. Browser and full verification runs were serial.

- `node --test tests/browser-discovery-report.test.mjs`: 16 passed, zero failed.
  New failure-label, nested serialization-hook and consumed-handle regressions
  were each observed failing before fixes and passing afterward.
- `npm run verify`: all six steps passed, 1,176 tests passed, 52 opt-in/platform
  skips, zero failed. Initial summary:
  `data/verification/2026-10-05T04-02-09.213Z-4846af97-9d44-4634-a6db-037f3b60c72d/summary.json`.
  This was a stable dirty tree at `7abb803`; a subsequent Windows path
  normalization correction passed all 16 focused tests. Final committed-tree
  verification is a release gate, not implied by this initial run.
- `BEHALVO_PLAYWRIGHT_P2_ACCEPTANCE=1 BEHALVO_BROWSER_DISCOVERY_REPORT=1 node --test --test-concurrency=1 tests/playwright-actions-acceptance.test.mjs`:
  25 passed, zero failed/skipped; exit 0. Report below has 13 executed catalog
  cases, zero missing/skipped/rejected, zero gestures/POSTs, confirmed cleanup,
  stable `dirty_tree` provenance, `result: passed`, all eight gaps unobserved.
- The same command filtered to only the login contract: exit 1; one executed,
  12 missing, `incomplete`, confirmed cleanup.
- Report opt-in without visible opt-in: exit 1; all 13 skipped, `incomplete`,
  confirmed cleanup. No browser was launched.

Local report paths under
`data/verification/browser-discovery/synthetic-browser-discovery/`:

| Run | UUID / report.json |
| --- | --- |
| Full visible acceptance | `5a96b3d7-7847-4a52-ac5f-5df6ff996ee6/report.json` |
| Filtered login only | `1448ee26-5170-4955-9278-2c4e615ffcc9/report.json` |
| Browser disabled | `21066f4d-05c3-4d3d-bf95-690ce9c0f00f/report.json` |

Raw local logs are in `data/verification/discovery-report/`. Generated reports
and logs are ignored; this record contains no raw page or credential values.

## Independent review and model ledger

- Architecture/plan: existing Astra (`gpt-6-astra`), max; one plan with focused
  corrections from the existing Sol reviewer; approved before implementation.
- Code/design review: existing Sol (`gpt-5.6-sol`), high; failure-code consistency,
  observation/assertion phases and Windows gating/path normalization corrected;
  code approved after focused rereview.
- Independent security review: existing Astra (`gpt-6-astra`), high; nested
  `length` serialization hook and reusable publication handle corrected;
  conditional merge approval after focused rereview.
- No new reviewer contexts or implementation agents were spawned. Terra was not
  available in the callable model list; the policy-permitted Sol/Astra pair was
  reused. Both reviewers require final verification and actual exact-head CI.

## Limits and release gate

Persistence is POSIX-only. Windows ownership/mode tests are explicitly skipped;
no Windows run is claimed. No live portal/account discovery was performed.
`passed` describes the fixed synthetic catalog only. Reports are not authenticated
fixtures, approvals, grants, or evidence of live readiness. Calendar pagination,
identity, complete roster, terms permission, origins, polling, authenticated
profile custody and live reachability remain unobserved.

Before merging: final committed-tree `npm run verify`, serial visible report,
local documentation links/diff check, both reviewer approvals and passing hosted
checks on the exact PR head. Publication and merge are authorized by the owner.
