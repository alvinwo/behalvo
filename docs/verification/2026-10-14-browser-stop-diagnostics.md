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
Full repository verification and independent review outcomes will be recorded
before integration. No authenticated H-1B flow acceptance is claimed.

## Delegation ledger

- Architecture: `gpt-6-astra`, max; bounded design approval; no failed design
  retries. Deferred automatic format correction.
- Independent Sol/high and Astra/high review: pending.
