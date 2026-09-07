# Instructions for contributors and coding agents

Read README, SECURITY.md and the approved architecture spec before editing.

- Keep the kernel transport/model-independent and the application a modular monolith.
- Write normative project documentation and code-facing documentation in English. Chinese `*.zh-CN.md` files are supplementary translations, not the source of truth.
- Work in a feature branch; do not publish, push, contact real recipients, create
  paid resources, or choose a public license without owner authorization.
- Use synthetic data only. Never ingest the maintainer's actual accounts into tests.
- Write behavior tests first. Run `npm run check`, `npm run demo`, and `git diff --check`.
- All domain mutation goes through journal events and deterministic reduction.
- Replay is read/reduce only; never execute effects during recovery of projections.
- A timeout is unknown, not proof of failure. Never auto-retry unknown side effects.
- Owner ID is a local trust binding, not authentication suitable for a public API.
- Scope every storage/retrieval path by workspace and future audience permissions.
- Summaries are navigation, not policies, approvals, facts or completion evidence.
- Do not introduce distributed infrastructure, vector services or more agents
  without a failing test and a real workflow that requires them.
- Update the implementation status table when an interface becomes operational.
- Record verification actually performed; do not describe configured CI as passing CI.
