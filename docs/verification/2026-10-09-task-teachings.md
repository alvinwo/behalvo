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
and fixes. Both focused re-reviews cleared the source changes. Merge remains gated
by final verification, clean-head live evidence and exact-head hosted CI.
Primary agent was the sole writer. Existing review contexts were reused; no model
fallback, new runtime agent or credential inspection was introduced.

## Execution evidence

- Final implementation-tree POSIX `npm run verify`: passed all six steps, natural
  exit 0; 1218 tests passed, 52 skipped, zero failures. Summary:
  `data/verification/2026-10-10T05-30-24.992Z-6a5a2395-21d8-4159-99cc-f6213535b2b9/summary.json`.
  Source fingerprint stayed unchanged during the run. This was before commit;
  committed-tree verification is the remaining release gate.
- Live synthetic model `openai-codex/gpt-6-astra`: first diagnostic run passed
  seven stages (teach, restart/recall, correction, ambiguity, hold/recall,
  resolution, retraction), process exit 0. Its working tree was dirty; it is not
  clean-head release evidence. Local runner and logs are in
  `data/verification/task-teachings/`.
- Clean-head live rerun and exact-head CI: pending at this checkpoint.

Live protocol results do not constitute owner usefulness approval. No real portal,
recipient, credential payload, or account data was used in the acceptance cases.
