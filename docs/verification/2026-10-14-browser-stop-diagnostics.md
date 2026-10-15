# Browser loop stop diagnosis and verification

## Observed issue and limits

The owner-authorized read-only follow-up trace confirmed that the owner had
reconciled the earlier unknown action. The next run automatically visited the
public information page, recorded a native link as failed with
`validation/control_covered` and `not_dispatched`, then recorded a fresh recovery
observation. It stopped later with generic `invalid_model_result` guidance and
no additional browser action. The later response/exception was not retained,
so the exact historical cause cannot be established. No owner database, account
or running process was modified by this investigation.

The confirmed code defect was the exploration loop's catch-all: unrelated
model/protocol/local validation failures discarded their causes and retired a
healthy browser as faulted. Final task settlement could also overwrite the
browser-specific message. An isolated live Astra diagnostic with a wholly
synthetic task and observations returned a valid handoff after blocked-link
feedback; this did not reproduce or identify the historical exception. It made
one actual model completion and no website actions or authenticated portal calls.
Private operational identifiers and source page contents are not included here.

## Approved bounded repair

The delegated architecture reviewer approved fixed phase/code diagnostics,
retention after known local stops, and latest-observation reference validation.
Automatic format correction was explicitly deferred. The primary remained the
sole product/test writer. The existing eight-completion/deadline budgets and
navigation/review policy are unchanged.

Diagnostics are assigned at trusted code boundaries, never parsed from arbitrary
exception strings. The fixed English catalog is `src/browser/live-messages.ts`;
no other locale is supported. Guidance persists through the existing scoped
assistant-message journal path, without a response archive or schema change.
Healthy local stops require current task/execution authority, no unresolved
browser effect, and confirmed lease retirement. References are invalidated.
Control IDs/actions/options are checked against the latest successful observation
before invoking the port; this does not prove DOM freshness or replace adapter
checks. Port errors remain terminal. Unknown actions retain their original
outcome and authoritative reconciliation guidance. Failed handoff never becomes
success merely because an intermediate session state says human.

## Tests actually performed

Behavior tests first reproduced generic/closed model stops, a revoked asynchronous
execution fence being mislabeled as provider failure, final-settlement guidance
being overwritten, and cleanup failure mislabeled as completion exhaustion.
Subsequent tests cover phase distinctions, retained/closed session outcomes,
latest-reference rejection without port invocation, raw-data canary exclusion,
unchanged budgets, journaled replies and final settlement.

Five real Chromium synthetic product cases passed: lost mutation response,
unknown visit, reviewed handoff, covered-link alternative exploration, and
covered link → malformed model response → retained stop → new owner turn in the
same session with fresh references and one alternative navigation. No rejected
gesture was repeated and no permission policy was broadened.

Raw local evidence is ignored under `data/verification/browser-protocol-stop/`.
Both independent reviewers found the same late-settlement gap: a deadline during
artifact persistence or final SQLite commit could overwrite the diagnostic and
leave a retained browser open. Five added tests reproduced the failure before
the shared asynchronous rejection path fixed it. They cover final artifact
deadlines, real SQLite writer-lock contention, and revoked admitted service
fences, including unconfirmed closure. A revoked service fence is never bypassed
to save another reply; cleanup completes before the failure is rethrown.

Production commit `e3699ea067bf764a69a63d1ed3e6025aca22799d` and final test tree
`d50627dff5f152fea2224778c7fa5d311f0cbc55` passed:

- Focused regression suite: 75 passed, zero failures or skips.
- Full POSIX `npm run verify`: all six gates passed (`check`, `demo`,
  `operations:demo`, `owner-control:demo`, `service:demo`, diff check).
  The check suite had 1,530 tests: 1,435 passed, 95 skipped, zero failures.
- Terminal local summary:
  `data/verification/2026-10-15T05-25-05.712Z-5e3e2130-7e62-4c9b-ba1b-0476408f2d4f/summary.json`.
  HEAD and source fingerprint were unchanged; the tree was clean before/after.
- Both reviewers approved the focused repair after independently rerunning
  regressions. Hosted CI remains a separate pre-merge gate, not a claim made
  by this local record.

No authenticated H-1B flow acceptance is claimed.

Initial hosted CI exposed a timing-dependent test expectation: the action could
still be running when guidance was published and settle unknown before the
test's awaiting caller resumed. A `setImmediate` did not synchronize two
independent timeout paths. The revised regression explicitly awaits the broker's
unknown settlement before advancing a controlled clock past the turn deadline.
It retains the original unknown-guidance assertions; production behavior was
unchanged. Both reviewers approved this test-only correction. Hosted checks
on the final documentation head must pass before merging.

## Delegation ledger

- Architecture: `gpt-6-astra`, max; bounded design approval; no failed design
  retries. Deferred automatic format correction.
- Independent review: `gpt-5.6-sol`, high; lifecycle/unknown-effect risk review;
  one finding-driven re-review and one CI test correction review; approved
  `e3699ea` and `d50627d` after independent regression runs.
- Independent review: `gpt-6-astra`, high; lifecycle/unknown-effect risk review;
  one finding-driven re-review, bounded CI diagnosis and test correction review;
  approved `e3699ea` and `d50627d` after independent regression runs.
