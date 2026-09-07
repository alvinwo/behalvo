# ADR 0003 — Source-preserving context rather than transcript-owned memory

Status: accepted for M0.

Journal/artifacts preserve observations; structured state owns work and facts.
Thread summaries are source-linked derived artifacts, not authoritative memory.
Each inference receives a bounded view with current constraints and relevant work.

M0 intentionally uses exact IDs and bounded thread tails before embeddings or
hierarchical summaries. Overflow of mandatory state/current input is an explicit
error. Production token counting and model-driven summarization are future adapters.

History may need erasure; retention policy is separate from ordinary immutability.
Deletion must eventually invalidate derivative copies too.
