# Contributing

The project is a local foundation preview. Public contributions and their license
terms should be opened only after the maintainer chooses a release license.

Use Node.js >=22.16, run `npm ci`, then `npm run check` and `npm run demo`.
No live account or model key is needed. Test fixtures belong under `tests/` and
must be synthetic. Tests execute against temporary real SQLite databases.

Preserve module boundaries. Add a failing behavior test for every new policy,
record type, reducer transition, provider outcome and compaction behavior.
Examples of important failures: ambiguous timeouts, duplicate delivery, changed
approval inputs, stale work, wrong workspace, conflicting facts and missing sources.

Any schema migration must state how an existing journal is upgraded or read,
and include old-version fixtures. Never change old event meaning silently.
Adapter work must document authentication, transport consent, provider idempotency,
readback, rate limits and unknown-result behavior before enabling real effects.
