# Browser exploration recovery verification

Date: 2026-10-14 (America/Los_Angeles). Executable source:
`5c576fcdaeba94a64c6158a6aa5d2271ce97a50c`.

## Behavior and diagnosis

Public HTTPS URL visits and observed native-link navigation now proceed under
controller-issued `navigation_policy_v1` authority without a private prompt.
Click, fill and select retain fresh owner review. New version-2 action commands
bind that authority and exact link destination; version-1 commands/digests remain
unchanged. The one-use explicit open command records `owner_open` authority.
Navigation can cause remote effects; the adapter cannot prove arbitrary business
semantics and the model must not use navigation to evade owner confirmation.

A private helper's strict no-dispatch receipt can distinguish a known covered,
missing, stale or ambiguous control from possible activation. A recoverable
rejection settles failed, receives one fresh observation within the current turn
budget and retains a healthy session. No gesture is silently repeated and no
overlay is automatically dismissed. Unexpected errors, malformed receipts and
post-dispatch missing evidence remain unknown; late receipts cannot rewrite a
settled unknown. Diagnostics contain fixed phase/code values only.

`/actions` displays diagnostics, authority and evidence references. Unknown stops
identify the action and reconciliation commands, including through deadline
settlement. `/browser status` reports unresolved actions without a live session.
Focused-task turns with an unresolved action stop before model calls/allocation.
No existing owner action or running process was modified or reconciled.

Independent review identified a crash-recovery gap: a persisted running action
cannot use the unknown-action resolve command. The approved amendment adds
status-aware guidance and explicit `storage recover-browser` maintenance. With
all workers stopped and the database process lock held, it validates the existing
file/key/workspace read-only, then journals exact running browser attempts as
unknown. It never dispatches, retries, creates storage/workspaces, changes
unrelated actions or steals a stale lock. Repeated maintenance is idempotent;
ordinary replay remains read/reduce only.

The owner-authorized read-only trace investigation established public-page loading,
63 observed controls, two review waits totaling approximately 49 seconds, and an
unknown settlement about 14 ms after starting a native-link action. The old trace
did not retain its exception. An independent fresh, unauthenticated public-page
probe reproduced a `Covered control` exception before activation when an
announcement overlay covered the selected public information link. This is a
matching failure mechanism, not proof of the original historical exception.
No authenticated portal, appointment change or owner profile was used in probes.
Operational trace identifiers and page contents are excluded from this document.

## Tests

Observed RED→GREEN tests cover v2 contract rejection/legacy digest, covered-control
classification, recovery without closure, absent-session unknown status, fixed
trace output, and unknown guidance through failed cleanup/deadline settlement.
The initial focused action/session/exploration/CLI run passed **67 tests**.
After the review fix, the five-suite focused run including storage CLI passed
**76 tests**, zero failures/skips. Its real SQLite reopen test reproduces the
running-action dead end, performs synthetic exclusive maintenance, and permits
subsequent owner reconciliation. Plaintext/encrypted CLI tests cover flags,
missing/empty files, missing workspaces, invalid keys, process-lock contention,
other-workspace and non-browser/terminal-action preservation, and replay.

Real Chromium synthetic suites exercised **27 cases** (17 adapter, 10 complete
chat/controller cases): all passed across the combined run and a focused rerun.
The combined run reported 26 pass and one accidental test-only assertion in the
existing manual-login case; that assertion was restored and its focused rerun
passed. A duplicate-field fixture was also corrected to preserve both implicit
labels; the final atomic dispatch regression passed without changing the guard.
On the final executable source, the three Chromium cases for lost mutation
response, unknown visit and covered-link recovery also passed with zero skips.

Coverage includes automatic visits/links and exact destination evidence, private
review for click/fill/select, zero denied mutation traffic, one failed covered
link followed by an alternative link with fresh refs, no overlay dismissal,
late-proof timeout immutability, malformed-helper uncertainty, secret-canary
redaction, recovery observation/cancellation/revision/deadline failures, unchanged
completion budget, retained cookies, manual handoff, replay without effects,
network isolation and process/profile/proxy cleanup. Tests use synthetic data.
There was no new live-model acceptance run or authenticated H-1B flow test.

Commands (with `PATH=/opt/homebrew/opt/node/bin:$PATH TMPDIR=/private/tmp`):

- `npm run build`
- `node --test tests/browser-exploration-loop.test.mjs tests/managed-browser-session.test.mjs tests/managed-browser-cli.test.mjs tests/managed-browser-actions.test.mjs`
- `BEHALVO_MANAGED_ACCEPTANCE=1 node --test tests/managed-browser-live.test.mjs tests/managed-browser-acceptance.test.mjs`
- `BEHALVO_MANAGED_ACCEPTANCE=1 node --test --test-name-pattern='manual synthetic login' tests/managed-browser-acceptance.test.mjs`
- `node --test tests/storage-cli.test.mjs tests/managed-browser-session.test.mjs tests/managed-browser-cli.test.mjs tests/managed-browser-actions.test.mjs tests/browser-exploration-loop.test.mjs`
- `BEHALVO_MANAGED_ACCEPTANCE=1 node --test --test-name-pattern='lost mutation response|unknown explicit visit|covered native link' tests/managed-browser-acceptance.test.mjs`
- `npm run verify`

Raw focused evidence is under `data/verification/browser-recovery/` (ignored).

## Release gates

Required POSIX `npm run verify` passed on Node 25.8.1/npm 11.11.0: all six steps
(check, kernel demo, prepared-operation demo, owner-control demo, service demo,
and diff check) exited zero. The final default suite reported **1,500 tests: 1,406
passed, 94 opt-in skips, zero failures**. The actual Chromium runs above cover the
managed-browser tests skipped by that default suite.

Terminal summary:
`data/verification/2026-10-15T04-39-50.055Z-17cc210e-f8e7-4a8c-a3be-118ed22d1494/summary.json`.
The clean executable source remained `5c576fc` before and after verification;
the recorded fingerprint is
`db97e5f862e55e3ac41e473f43412e8786a2b1936f1e3f9694e2e547deac4b37`.
This evidence-only documentation update follows verification. Exact-head hosted
CI remains a separate integration gate, pending at this record's creation.

Startup, stop/reconciliation and diagnostic labels use the existing English
catalog `src/browser/live-messages.ts`; no other locale is supported. The model
protocol and normative documentation now describe the same navigation policy.

## Delegation ledger

- Architecture: `gpt-6-astra`, max; approved design and plan, then the narrow
  crash-recovery amendment; one amendment follow-up, no failed design retries.
- Independent review: `gpt-6-astra`, high; approved the initial full diff and
  focused maintenance delta through `5c576fc`; one focused re-review.
- Independent review: `gpt-5.6-sol`, high; requested the running-action recovery
  fix, then approved the focused delta through `5c576fc` and independently reran
  46 focused tests successfully; one fix and focused re-review. Both reviewers
  are separate non-writer contexts required for unknown effects and
  storage/concurrency boundaries.
