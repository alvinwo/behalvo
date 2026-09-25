# Task 4 implementation brief: monitored action authority

Implement only Task 4 from `docs/superpowers/plans/2026-09-21-monitored-actions-visa.md` on branch `feat/monitored-actions` after the merged unified-service foundation.

Read first:

- `AGENTS.md`
- `.agents/skills/behalvo-development/SKILL.md`
- the approved design spec and plan under `docs/superpowers/`
- existing operation, storage, service-job, runtime, backup, and validation tests

Hard requirements:

- Strict TDD. Add failing behavioral tests before implementation.
- One generic journaled `MonitoredActionGrant`; no visa-specific concepts.
- Exact immutable scope digest/revision and fixed owner/workspace/adapter/version/connection generation/browser profile/subject/installation identity.
- V1 maximum effects is exactly one. Activation is explicit owner authority. Expiry/revocation/material drift fail closed.
- Deterministic policy only: complete, fresh, sufficiently covered observation may produce one exact command. No model discretion.
- Reserve the only allowance atomically with durable `action.started` before any possible external mutation. Unknown or accepted-unverified retains reservation. Negative/incomplete readback never restores it.
- Persist recurring monitor state: due time, bounded request budget and jitter, last complete observation/coverage, failures/backoff, pause reason. Coalesce overdue checks; never catch up in bursts. Challenge/human/403/429/session/contract changes pause and release worker.
- Restored-copy/installation-generation barrier blocks monitoring and execution until explicit owner reconciliation. A process lock cannot clear it.
- Reuse current service job/runtime fences and encrypted storage. Preserve legacy behavior and backup validation.
- No browser extension, Keychain, real portal, visa adapter, credentials, or external effects (Tasks 5-7).
- Unknown fields and inconsistent journal/snapshot provenance must be rejected.
- Run focused tests, full `npm test`, `npm run verify`, `git diff --check`; self-review; update report and progress ledger; one scoped commit `feat: add monitored action authority`.

Required tests include policy/reducer replay, prohibited/bounded scopes, exact digest/revision, owner activation, expiry/revocation, routine observation no revision change, one allowance under concurrency/crash/restart, observation freshness/completeness/coverage, new IDs, monitor single-flight/coalescing/jitter/budget/backoff/pause/restart, restored copies, encrypted backup/restore, and no model/provider/effect call in Task 4 tests.

Write evidence to `.superpowers/sdd/2026-09-21-monitored-actions-visa/task-4-report.md` and update `.superpowers/sdd/2026-09-21-monitored-actions-visa/progress.md`.
