# Source-preserving compaction and retrieval evaluation

Local issue draft; not yet created on GitHub.

Milestone: M2
Area: Memory
Risk: High

## Goal

Add automated summaries only when their retrieval quality and failure behavior can be measured.

## Acceptance criteria

- [ ] Keep raw message/artifact history unchanged and record source IDs, summarizer version and coverage.
- [ ] Group tool calls/results atomically before compaction; preserve unresolved actions and exact constraints.
- [ ] Test repeated compaction, old corrections, conflicting facts, future-dated facts and reopened threads.
- [ ] Rehydrate primary evidence before consequential decisions; never authorize from summaries.
- [ ] Compare exact-match/FTS baselines before adding embeddings.
- [ ] Add external-audience filtering before any customer can query memory.
