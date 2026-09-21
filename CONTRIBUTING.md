# Contributing

The project is a local foundation preview. Public contributions and their license
terms should be opened only after the maintainer chooses a release license.

Documentation is English-first. New normative docs, ADRs, issue templates and public API descriptions should be written in English; translated `*.zh-CN.md` companions are welcome but are non-authoritative.

Use Node.js >=22.19 and run `npm ci`. On POSIX, `npm run verify` runs the complete
offline gates in sequence and stores private logs under `data/verification/`.
On Windows, run `npm run check`, `npm run demo`, `npm run operations:demo`, and
`git diff --check`; the POSIX-only `npm run owner-control:demo` must run on a
POSIX checkout or CI before release. No live account or model key is needed.
Test fixtures belong under `tests/` and must be synthetic. Tests execute against
temporary real SQLite databases.

For the complete repository process, including review, release, and recovery,
use the [development workflow skill](.agents/skills/behalvo-development/SKILL.md).

For delegated development work, follow the [model-routing policy](docs/MODEL_USAGE.md).

Preserve module boundaries. Add a failing behavior test for every new policy,
record type, reducer transition, provider outcome and compaction behavior.
Examples of important failures: ambiguous timeouts, duplicate delivery, changed
approval inputs, stale work, wrong workspace, conflicting facts and missing sources.

Any schema migration must state how an existing journal is upgraded or read,
and include old-version fixtures. Never change old event meaning silently.
Adapter work must document authentication, transport consent, provider idempotency,
readback, rate limits and unknown-result behavior before enabling real effects.
