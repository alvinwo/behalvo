# Behalvo live-model integration fixes — 2026-10-04

PR15 merged at `3209ce304127b0c0ad670c2138f50edc078f309a`. Local master was
clean and synchronized; historical browser branches/profiles remain preserved.

The owner configured OAuth, selected openai-codex/gpt-6-astra and authorized
live synthetic evaluation, then explicitly requested fixes. Technical review
and verified push/merge are delegated; do not ask the owner to review code.
No live account/site access or real external action is authorized.

Current branch: `codex/live-model-integration-fixes`. Initial live 60-case run
passed 45/60. Phase-aware output handling, trusted owner identity, scoped provider
session cleanup and one-shot pre-dispatch syntax recovery are implemented with
RED/GREEN regressions. Independent Astra-high and available Sol 6.1-high reviews
approved code; Astra-max approved the bounded recovery design. Sol 5.6-high was
at capacity and supplied no approval. Latest focused live run passed 8/8 and
exited naturally; no malformed text repair or effect retry was added.

Next release steps: commit final docs/tests; run clean-head npm run verify and
full live 60-case evaluation; review actual results; publish PR and inspect
exact-head CI before authorized merge. Human usefulness acceptance remains
separate from technical code review. Preserve failed reports as evidence.
See [verification](docs/verification/2026-10-04-live-model-integration.md) and
ignored `data/verification/live-model-evaluation/progress.md` for exact logs.
