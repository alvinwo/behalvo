# Instructions for contributors and coding agents

Read README, SECURITY.md and the approved architecture spec before editing.
Use the repository's [development workflow skill](.agents/skills/behalvo-development/SKILL.md)
for implementation, review, release, and interrupted-work recovery.

- Keep the kernel transport/model-independent and the application a modular monolith.
- Write normative project documentation and code-facing documentation in English. Chinese `*.zh-CN.md` files are supplementary translations, not the source of truth.
- Work in a feature branch; do not publish, push, contact real recipients, create
  paid resources, or choose a public license without owner authorization.
- Use synthetic data only. Never ingest the maintainer's actual accounts into tests.
- Write behavior tests first for executable behavior or policy changes. Use a
  focused link, format, or diff check for documentation-only changes. On POSIX,
  run `npm run verify`; on Windows, run `npm run check`, `npm run demo`,
  `npm run operations:demo`, and `git diff --check`. A POSIX checkout or CI must
  supply the required `npm run owner-control:demo` release gate.
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

## Agent effort policy

Before choosing a model for delegated work, read [the development model-routing
policy](docs/MODEL_USAGE.md) and its [declarative configuration](.agents/model-usage.json).
It requires explicit `model`, `reasoning_effort`, and `fork_turns: "none"` fields
where the spawn tool supports them. The policy does not change the primary chat's
effort setting, add runtime behavior, or expand access, publication, or deployment
permissions.
