# Owner-control verification — 2026-09-14

Status: local synthetic implementation evidence. This is not live-model,
real-provider, remote/mobile identity, privacy, manual-browser, or CI evidence.

Source started from `f2f7471d20a9236653188bec4641e82879f702cd` on branch
`feat/owner-control`. The first Task 3 implementation commit was
`b85ba58dd9175a4d2137707236718271663c25b2`. The production review fixes and
repository-wide gate below were committed as
`df19f31e9a67bcd2408b3ae254e220dd9752483c`. A later test-only correction was
committed as `3409649e5c9fe89811be95816c09de8c5ddc7b55`.

Commands actually run during implementation:

- `npm run build && node --test tests/owner-control-cli.test.mjs tests/owner-control-demo.test.mjs tests/owner-control-assets.test.mjs` initially failed at TypeScript compilation (`TS6133` unused CLI callback and `TS2551` invalid `Action.attempts` field), before tests executed.
- The same command then passed: 4 tests, 4 passed. It includes an actual
  loopback HTTP bootstrap/list/review/approve/replay/cancel/logout acceptance
  flow and later synthetic execute/verify after control shutdown.

A code-first scaffolding deviation occurred before the focused behavior tests were
created. It is recorded here rather than represented as an earlier RED result.
The demo itself first failed because cancelled execution returns a cancelled action
instead of throwing; its assertion now verifies that status as a rejected dispatch.

Supported browser navigation to a harmless loopback probe returned
`net::ERR_BLOCKED_BY_CLIENT`. Browser visual QA was therefore not observed and was
not retried. The mandatory real-HTTP acceptance demo remains the API evidence.

CI is configured to run the owner-control demo but has not been observed passing.
Remaining gates include genuine live-model/manual acceptance, real providers,
protected Pi credentials/settings, remote/mobile identity, privacy/retention and
deployment review.

## Review-fix evidence

The focused review-fix RED command was:

```bash
env -u npm_config_http_proxy -u NPM_CONFIG_HTTP_PROXY npm run build
node --test tests/owner-control-cli.test.mjs tests/owner-control-demo.test.mjs tests/owner-control-assets.test.mjs
```

It reported **10 passed and 2 failed**. Both failures reproduced missing demo
acceptance checks: a fabricated HTTP 500 logout was accepted, and a fabricated
204 logout that did not revoke the session was accepted. After requiring logout
204 and a subsequent 401 from the old bearer, the same focused command reported
**12 passed, 0 failed**.

The expanded focused tests also establish the full CLI parser matrix, exact
synthetic fixture contents, refusal of all main/synthetic SQLite file and dangling
sidecar paths, bounded startup-failure cleanup, real SIGINT and SIGTERM shutdown
from a working directory containing spaces, cross-process lock refusal, and
unchanged/non-disclosed ordinary and configured auth/settings/environment
canaries. Subprocess tests await `close`, own all startup timers/listeners, and
recognize only the exact standard Node 22 SQLite experimental warning.

Commit `3409649e5c9fe89811be95816c09de8c5ddc7b55` corrected only the injected
AbortSignal regression so it observed the live installed listener before abort,
then verified listener/bootstrap/lock cleanup and restart. Its actual gate was a
successful build plus **8 CLI tests passed, 0 failed, 0 skipped**, followed by
`git diff --check`. The 447-test repository gate and required demos below ran on
the production-identical `df19f31e9a67bcd2408b3ae254e220dd9752483c` head and
were not redundantly repeated after that test-only commit. This environment runs
Node **24.19.0**; Node 22 execution and remote CI remain unobserved.

## Final verification

After the UI/event-state, integration, and production review repairs, these
commands were run at `df19f31e9a67bcd2408b3ae254e220dd9752483c` with
`npm_config_http_proxy` and `NPM_CONFIG_HTTP_PROXY` unset:

- `npm run check`: **447 passed, 0 failed, 1 existing environment-dependent skip**.
- `npm run demo`: passed in `offline-fake-provider` mode with zero real messages.
- `npm run operations:demo`: passed in `synthetic-operations` mode with zero real
  external effects.
- `npm run owner-control:demo`: passed with two authenticated decisions, one
  rejected replay, one verified synthetic action, one cancelled action, zero real
  model calls/effects, and journal replay equality.
- `git diff --check HEAD`: passed before and after the evidence update.

CI remains configured but unobserved. The browser limitation remains
`net::ERR_BLOCKED_BY_CLIENT` for a harmless loopback probe; this report makes no
visual or mobile acceptance claim.

## Whole-branch correction evidence

The final workflow correction started from clean commit
`3409649e5c9fe89811be95816c09de8c5ddc7b55`. On the resulting working tree, the
focused build plus CLI/demo regression command first reported **15 tests: 12
passed and 3 failed**. The failures showed already-aborted startup still acquired
and published resources, real SIGINT during a deterministic pre-ready startup
pause did not settle, and the actual demo executable exited 0 after an injected
journal comparison mismatch. After the production changes, the same focused
command reported **15 passed, 0 failed, 0 skipped**. Its executable mismatch
fixture separately covered rebuild and reopen inequality.

Fresh working-tree verification on Node **24.19.0**, with both npm proxy
environment spellings unset for npm commands, then produced:

- `npm run check`: **451 tests, 450 passed, 0 failed, 1 inherited
  environment-dependent skip**;
- `npm run demo`: passed in `offline-fake-provider` mode with zero real messages;
- `npm run operations:demo`: passed in `synthetic-operations` mode with zero real
  external effects;
- `npm run owner-control:demo`: passed with two authenticated decisions, one
  rejected replay, one verified synthetic action, one cancelled action, zero real
  model calls/effects, and `journalReplaysMatch: true`;
- `git diff --check`: passed after the evidence update.

Actual Node 22 execution and remote CI remain unobserved. Browser rendering was
not retried, and genuine live-model/manual acceptance remains unobserved.
