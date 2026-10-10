# Task teachings verification — 2026-10-09

Scope: T1a owner-sourced durable task teachings. General browser exploration,
learned website notes, live accounts and booking are not implemented here.

## Behavior and compatibility

New tests cover exact Unicode source offsets, scope and revision rejection,
add/replace/retract lifecycle, durable clarification holds, stale approval rejection,
restart/linked-thread recall, bounded context, strict extraction and shared inference
budget. Teaching changes and the application reply settle with inbox completion.
Cancellation and SQLite writer-lock deadline regressions prove no partial memory
commit. Legacy callers remain opt-out; projection v1 needs explicit maintenance.
Encrypted v1 backup, validated v2 upgrade and v2 backup/rebuild are exercised;
corrupt owner-source ciphertext rejects upgrade and preserves the old projection.

The baseline passed 1193 tests with 52 skips. Initial restricted execution could
not bind local fixture servers; the authorized loopback-enabled rerun passed.
Behavior-first RED evidence and focused GREEN logs are retained locally under
`data/verification/teachable-browser-design/`. Tasks 1–4 were committed together
because source validation, projection shape and atomic inbox completion share the
same interfaces; focused RED/GREEN checks preceded their implementations.

## Review

Delegated design/plan review: Astra/max; independent design review: Sol/high.
Final code-review contexts: Sol/high (`live_fix_sol_review`) and Astra/high
(`live_eval_protocol_review`). Both found deadline defects; Astra also reproduced
an encrypted source-integrity upgrade defect. All findings received regressions
and fixes. Both focused re-reviews cleared the source changes. Clean-head verification and live evidence passed as recorded below; merge remains
gated by exact-head hosted CI.
Primary agent was the sole writer. Existing review contexts were reused; no model
fallback, new runtime agent or credential inspection was introduced.

## Execution evidence

- Final implementation-tree POSIX `npm run verify`: passed all six steps, natural
  exit 0; 1218 tests passed, 52 skipped, zero failures. Summary:
  `data/verification/2026-10-10T05-30-24.992Z-6a5a2395-21d8-4159-99cc-f6213535b2b9/summary.json`.
  Source fingerprint stayed unchanged during the run. This was before commit;
  committed-tree verification is recorded next.
- Live synthetic model `openai-codex/gpt-6-astra`: first diagnostic run passed
  seven stages (teach, restart/recall, correction, ambiguity, hold/recall,
  resolution, retraction), process exit 0. Its working tree was dirty; it is not
  clean-head release evidence. Local runner and logs are in
  `data/verification/task-teachings/`.
- Committed-tree POSIX verification passed all six gates on clean
  `abd22833a7a18097987f789787e847a9da7eda36`, 1218 passed/52 skipped/zero failed,
  natural exit 0 and unchanged source fingerprint. Summary:
  `data/verification/2026-10-10T05-32-43.722Z-33ae0225-365f-4e89-bbe8-de65c57989c3/summary.json`.
- Clean-head live rerun on the same commit: seven stages passed, eight model calls,
  natural exit 0. Report: `data/verification/task-teachings/live-1791610386540.json`;
  log: `data/verification/task-teachings/live-clean.log`.
- Subsequent edits are documentation-only evidence and T1b plan clarifications;
  executable source/tests match that verified commit. Exact PR-head hosted CI
  remains required; its final result belongs to the PR checks, not this checkpoint.

Live protocol results do not constitute owner usefulness approval. No real portal,
recipient, credential payload, or account data was used in the acceptance cases.
