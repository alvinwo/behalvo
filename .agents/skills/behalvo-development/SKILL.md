---
name: behalvo-development
description: Develop, review, release, or resume interrupted work in the Behalvo repository while preserving its local trust and evidence boundaries.
---

# Behalvo development

Before editing, read `AGENTS.md`, `README.md`, and `SECURITY.md`, plus the
architecture document relevant to the change. Keep the kernel independent of
transports and models, preserve workspace and audience scopes, and use synthetic
data. Treat external writes, publication, deployment, and contact with recipients
as separate actions that need authorization from the current session.

Use `max` effort for plans, architecture, and design; `medium` for routine code,
tests, and documentation; and `high` for complex implementation, debugging, and
security or code review. When delegating is authorized, set the effort explicitly
where the tool supports it.

Work on a feature branch. For behavior or policy changes, add a behavior test
before implementation and observe the expected failure. For documentation-only
changes, use the relevant focused link, format, or diff check. Keep changes scoped
to the approved task.

On POSIX, run `npm run verify` once the final tree is ready; it sequentially runs
the offline check, demo, prepared-operations demo, POSIX owner-control demo, and
Git diff check. Use its terminal `summary.json` and logs under
`data/verification/` as local evidence. On Windows, run `npm run check`,
`npm run demo`, `npm run operations:demo`, and `git diff --check`; require a
POSIX checkout or CI run of `npm run owner-control:demo` before release. Do not
silently omit that gate. A configured workflow or local result is not evidence
that hosted CI passed.

- For review, merge, or release work, read [review and release](references/review-release.md).
- After an interruption or failed environment, read [recovery](references/recovery.md).
