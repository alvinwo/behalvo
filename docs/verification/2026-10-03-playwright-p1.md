# Playwright P1 local verification — 2026-10-03

## Replacement branch — verified integration

The owner authorized publication of a replacement PR and closure of stale PR #12.
`codex/playwright-p1` is based directly on master `09b99e6`, carrying the same P1
executable files and tests reviewed at `82fc957`. PR #12's installable extension
changes are excluded; existing master supplies the required shared BrowserSession and synthetic portal
dependencies; this branch adds Playwright. Both
older branches remain preserved. The clean-base source commit is `9ec85387aa9125fe136e369c74d699e28b4cc53a`.
Fresh `npm run verify` passed all six gates on that clean, unchanged head:
`data/verification/2026-10-04T01-28-51.889Z-cc7b5b8f-dc5b-492f-9bd9-5a3535b6dbb4/summary.json`.
Tests: 1118 total, 1099 passed, 19 skipped, zero failed. The lower count reflects
exclusion of PR #12's installer/bridge tests, not suppressed P1 coverage.

Exact-head visible Mac acceptance passed 15/15 and the public command exited 0,
confirming login and cleanup. Logs are under ignored
`data/verification/playwright-p1-replacement/` (`source-head.txt`,
`mac-acceptance.log`, `public-command.log`). All twelve P1 source/test/helper files
were byte-compared with approved `82fc957`; shared session/types/portal files also
match master and the previously reviewed tree. Focused independent Sol-high and Astra-high integration reviews cleared
dependency completeness and the reduced PR scope. Sol requested a wording
correction distinguishing existing shared dependencies from newly added Playwright;
that correction is included. No integration code changes were required. Only subsequent
documentation checkpoints differ from this tested executable source.

The owner authorized publication and closure of superseded PR #12, not merging.
Hosted CI for the replacement must be assessed separately after publication.

## Original stacked-branch evidence

Scope: synthetic, read-only, visible browser diagnostic on the owner's macOS
laptop. Branch `codex/playwright-browser-adapter`, based on `634c791`; extension
branch and draft PR #12 are preserved. No push, merge, live account, model call or
P2 action was performed. Hosted CI has not been run for this branch.

## Design review and implementation

The owner gave LGTM and delegated design/architecture approval before implementation.
Independent Astra max architecture and Sol high design/security reviews cleared the
revised design before executable work started. They corrected the original direct
launch proposal to a locally owned BrowserServer, required explicit cancellation
ownership, runtime GET-root-only fencing, conservative unknown-launch cleanup and
fixed-output canary tests. Approval does not extend to P2 or live accounts.

Transport tests first failed for missing behavior, then passed. Lifecycle/CLI
behavior tests also failed before implementation. Further observed RED/GREEN tests
covered a late close incorrectly upgrading a pending receipt, late invalid-profile
handles not closing, and shutdown failing to wait within its budget for a late
handle. Logs are retained under ignored `data/verification/playwright-p1/`.

One implementation adjustment: an internal owner object exposes `start()` and
`close()` instead of an async-only launch factory, so shutdown remains available
while launch is pending. This changes only an internal interface; no CLI or model
capability was added. The plan records that decision.

## Browser and suite evidence

Actual dependency: Playwright 1.63.0. Matched browser: Chromium / Chrome for Testing
153.0.8010.12, build v1243. Node v25.8.1; npm 11.11.0. Chromium was explicitly
installed; runtime does not download it. Both normal and fault tests used visible
new synthetic browsers with disposable profiles and canonical `/private/tmp`.

Initial real acceptance: 11/11 passed (`real-first.log`), including real DOM
observations through BrowserSession, changed markup, pending-read navigation,
crash, cancellation, attempted POST/off-origin/popup dispatch denial, and actual
CLI SIGINT/SIGTERM during launch. The public command also passed
(`public-command-first.log`), reporting login and confirmed browser/profile cleanup.
The screenshot `visible-login.png` was visually inspected.

Initial full verification passed all six gates on source head `20b7c7f` plus the
then-current documented/test working tree (stable fingerprint):
`data/verification/2026-10-04T01-04-57.633Z-77b60a0b-7903-4ce9-947c-f84cab7223af/summary.json`.
Tests: 1186 total, 1171 passed, 15 skipped, zero failed. Eleven skips were explicit
real-browser acceptance tests; the other four were pre-existing skips. This run
precedes the redirect fix and is not the final-source acceptance claim.

## Independent code-review corrections

Astra high reproduced an HTTP redirect escaping `route.continue()` to a second
synthetic loopback server. The new real regression observed one forbidden request
before the fix (`redirect-red.log`). The adapter now fetches the approved root
with redirects and retries disabled, rejects every non-200 or changed URL response,
and fulfills the browser request only after a current-run check. The focused
regression passed (`redirect-green.log`). Both off-origin and same-origin
wrong-path redirect cases are included in the expanded real suite.

Additional coverage includes a browser-stderr canary, a synthetic Selenium endpoint
that must receive no connection, and a second isolated test browser that must stay
usable when the diagnostic browser crashes. These do not access personal browsers.

Sol high reproduced piped-output truncation from immediate process.exit with
asynchronous writes (`output-drain-red.log`). The CLI now writes its fixed output
synchronously before bounded exit; the spawned/piped regression passed
(`output-drain-green.log`), preserving the cleanup receipt path.

The first expanded real run stalled during changed-DOM test teardown and was
stopped. Instrumentation showed all body assertions completed. The fixture had
awaited portal closure before browser closure; an open browser connection kept
that first cleanup pending. Browser-first fixture teardown and per-test deadlines
resolved the isolated scenario (`changed-dom-instrumented.log`). The production
coordinator already shuts both resources down concurrently under one deadline.
The stalled run is retained, not counted as passing evidence.

## Final reviewed-source gates

Both independent code reviewers approved source commit
`82fc9578b8e3f76ecbd2c7f3d3845c34a58a6335`: Sol high cleared ownership, cancellation,
request/output boundaries and receipt truth; Astra high cleared the redirect fix,
expanded acceptance and synchronous output. No actionable blockers remain from
those reviews. There were no deferred minor findings.

Full final `npm run verify` passed on that exact clean, unchanged commit:
`data/verification/2026-10-04T01-18-13.766Z-f7ae6cfc-db71-43ad-9adc-02f69864cf76/summary.json`.
All six gates exited 0: check, demo, operations-demo, owner-control-demo,
service-demo and git-diff-check. Test counts: 1192 total, 1173 passed, 19 skipped,
zero failed. Fifteen skips are the explicitly enabled real-browser suite; four
pre-existing skips remain. Source fingerprints and heads were unchanged before
and after verification, and both dirty flags were false.

Exact-head visible macOS acceptance then passed **15/15**, no skips or failures:
`data/verification/playwright-p1/real-final-head.log`. The public command also
exited 0 and reported synthetic login with confirmed cleanup:
`data/verification/playwright-p1/public-command-final.log`. The head and empty
status were captured in `final-source-head.txt` and `final-source-status.txt`.
Only documentation/handoff completion records follow this tested source commit.

P1 is operational within the documented synthetic-only limits. P2 actions,
authenticated profiles, live websites and durable service composition remain
outside scope. The accepted unknown-launch cleanup limitation remains explicit;
no generic production-readiness or hosted-CI claim is made.

CLI text is centralized in the English-only
`src/cli/playwright-messages.ts` catalog; no additional locale files exist or were
added. Output-delivery, redaction, build and verification checks passed.

## Model-routing ledger

| Role | Model | Effort | Reason | Retries | Result |
| --- | --- | --- | --- | --- | --- |
| Architecture design review | gpt-6-astra | max | New browser ownership/lifecycle design | One focused re-review | Approved revised P1 design |
| Design/security review | gpt-5.6-sol | high | Independent P1 boundary and acceptance review | Focused correction check | Approved revised design |
| Independent final code review | gpt-5.6-sol | high | Reused non-implementer review context | One output fix re-review | Approved 82fc957 |
| Independent final architecture review | gpt-6-astra | high | New transport/network/lifecycle risks | Focused redirect and output re-review | Approved 82fc957 |
| Replacement integration review | gpt-5.6-sol | high | Reused P1 reviewer; direct-master dependencies/scope | One documentation wording correction | Cleared |
| Replacement integration review | gpt-6-astra | high | Reused P1 reviewer; removal of PR12 prerequisites | Zero retries | Approved |

The primary implemented locally with its existing session settings; no model or
reasoning override, paid provider fallback or runtime agent was introduced.
