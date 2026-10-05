# Live-model integration fixes — 2026-10-04

Base: `3209ce304127b0c0ad670c2138f50edc078f309a` (PR15). Synthetic tasks only;
no real account handlers, recipients or booking. The owner selected
`openai-codex/gpt-6-astra` and authorized evaluation, fixes, independent review
and the existing verified merge workflow. No credential values were inspected.

## Failures and bounded fixes

The initial 20-case, three-repetition live run passed 45/60 (15/20 each).
Twelve responses had malformed JSON or combined commentary/envelopes; three
preference cases used literal `owner` instead of the actual scoped owner ID.
All mutation-allowlist and workspace-isolation checks passed, but several
critical paths stopped before their intended guards/readback. Both initial
commands published reports but retained provider resources and required SIGTERM;
these were not natural successful CLI exits.

The fixes select final text using pinned SDK phase metadata, retain all visible
text for bounded diagnostics/isolation, expose trusted `ownerId` in context,
and close a unique per-completion provider session in `finally`. Strict parsing
and incomplete/ambiguous response rejection remain. Provider session reuse is
intentionally sacrificed; no global cleanup is called.

A focused rerun improved to 7/8 and naturally exited 1; one missing closing brace
remained. One harmless native JSON-mode compatibility request was rejected by
the backend. No unsupported mode or silent fallback was shipped.

An independently approved bounded recovery now requests one fresh completion
only for a local JSON syntax error before any non-read-only invocation. Only
`catalog` and `inspect` preserve eligibility. A sticky barrier is set before
other invocations; the correction is one-shot, never contains rejected text,
and shares the eight-call/deadline/size limits. Provider failures, schema errors,
late responses and unknown effects do not enter this path. The subsequent
focused live rerun passed 8/8, used 17 calls and naturally exited 0.

## Evidence

Local ignored reports under `data/evaluations/`:

| Run | Report filename | Outcome |
| --- | --- | --- |
| Original full | `synthetic-v1-2026-10-05T05-49-34-339Z-ec0f89ee-224f-4478-8e5e-a730f61cd156.json` | 45/60; acceptance failed |
| Initial fixes | `synthetic-v1-2026-10-05T06-20-48-914Z-a920f28e-7e7f-4aaf-b0c6-3ee16d0cd9f7.json` | 7/8; natural exit 1 |
| Bounded recovery | `synthetic-v1-2026-10-05T06-28-50-847Z-b6490345-ba97-467c-a1c6-c99f9cd1ad29.json` | 8/8; natural exit 0 |

Focused commands selected capabilities, remember-preference, ambiguous-account,
execute-contact, revoked-connection, expired-approval, stale-precondition and
lost-response, with one repetition, at most 60 calls and 300 seconds. Full runs
use all 20 cases, three repetitions, at most 240 calls and 900 seconds. No repeated
run overwrites prior evidence. Focused success is not full acceptance.

Tests first reproduced phase concatenation, ambiguous/incomplete responses,
missing owner identity, unreleased sessions, diagnostic-evidence exclusion,
oversized-commentary dispatch and syntax recovery failures. Eighty focused tests
passed, followed by the expanded operation-loop edge suite. The initial broader
offline check passed 1,184 tests with 52 skips; final-tree verification is still a
release gate. All actual local logs are in
`data/verification/live-model-evaluation/`.

## Independent reviews and remaining gates

Astra-high reviewed the integration and found the full-output size-bound gap;
the regression-tested fix and syntax recovery were approved. Sol 5.6-high was
unavailable at capacity twice; the available Sol 6.1-high replacement independently
approved the complete diff and focused recovery. Astra-max separately approved
the bounded recovery design and requested additional sticky-eligibility,
verify-only, deadline and request-size tests, which passed. Primary remains the
sole implementation writer. No review failure was counted as approval.

Before merge: clean-commit full verification, fresh full live evaluation with
honest outcome, exact-head hosted CI and final independent review gates. Human
usefulness review remains distinct from automated results. No live-site or
real-world readiness is established. SDK cleanup retains small diagnostic
metadata; it is not a claim of complete erasure.
