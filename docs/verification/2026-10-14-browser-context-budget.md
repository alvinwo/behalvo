# Browser context budgeting repair

## Diagnosis and approved scope

Read-only inspection of the owner-authorized trace found two consecutive browser
observations of 19,836 raw JSON bytes each (12,037 visible-text UTF-8 bytes and 57
controls). Reconstructing the preceding state with read/reduce only gave 9,849
bytes of base context. That context plus two nested observations used 52,457
bytes before the browser protocol and other request fields. The complete original
model request was not persisted. Source inspection confirmed every full snapshot
was appended and initial context allocation did not reserve browser overhead.
The ordinary complete-request cap is 56,000 bytes, not a model token-window limit.
No owner database, account or running process was modified.

The architecture reviewer approved one shared request builder/counter, a soft
36,864-byte continuation reserve, complete latest observation/recall, immediate
removal of old executable handles, and oldest-first whole historical payload
omission. Pinned material has priority: only a typed measured capacity failure
may retry context construction with the remaining reserve. Other errors propagate.
No cap, call limit, deadline, navigation authority, effect recovery policy or
provider protocol changed. Browser tools still use application JSON envelopes.
The primary agent is the only implementation/test writer.

Original full browser artifacts remain journaled. Old source metadata and all
fixed outcome/diagnostic feedback survive context reduction. Omission markers
cannot establish omitted facts; chat recall still cannot retrieve browser
observations by ID. Current control validation and live DOM checks remain intact.

## Verification

Tests first reproduced the accumulation stop on multiple near-20KB pages and
optional chat history starving a large current observation. They failed with
`budget/input_limit` before implementation. Additional regressions cover exact
Unicode/nested escaping, full latest options and recall, stale-reference rejection
before dispatch, preserved no-dispatch feedback, source IDs, pinned teachings,
soft reserve behavior and propagation of storage/authorization errors.

A real Chromium synthetic product case passed: five pages over 20KB each,
complete latest controls, historical omissions, five accepted navigations, no
navigation review prompts, retained session and full journaled observations.
Scripted model responses drove this acceptance; no authenticated portal or live
provider compatibility is claimed.

An initial sandboxed full verification failed because local-server/socket tests
could not bind (`EPERM`). It is not passing evidence. The permitted full
`npm run verify` completed successfully: all six gates passed, with 1,444 tests
passed, 96 skipped and zero failures. The terminal record is
`data/verification/2026-10-15T05-53-23.452Z-932f7b3d-506b-4316-b162-03ac12d85fa9/summary.json`.
HEAD remained `8e9b4edc017c440cae02ed32284a709c21754fd8` with the pending repair;
the source fingerprint was unchanged before and after:
`d84a76aba40217ba2db686c3a8ba561af340a8660c94b771ab34a92ee8b3fa33`.
Only verification bookkeeping changed afterward. Raw local evidence is ignored
under `data/verification/browser-context-budget/`. Both independent reviewers
approved with no actionable findings; Astra also independently reran all nine
focused tests successfully. Exact-head hosted CI remains a separate merge gate.

## Delegation ledger

- Architecture: `gpt-6-astra`, max; bounded context design, no failed design
  retries; approved with adaptive reserve refinement.
- Independent review: `gpt-5.6-sol`, high; context/authority regression review;
  approved, no findings or re-review retries.
- Independent review: `gpt-6-astra`, high; context/authority regression review;
  approved, no findings or re-review retries.
