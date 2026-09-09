# Task 2 implementation report

## Delivered

- Added a subprocess regression for `dist/operations-demo.js`.
- Added two synthetic, versioned handlers with distinct provider-state contracts: `contact.update` for a customer contact profile and `subscription.cancel` for an account subscription.
- Added an offline demo that uses one durable runtime and one WorkItem across explicitly bound, distinct provider subjects. It prepares and batch-approves both operations, executes and verifies each, applies a third mutation whose response is lost, observes replacement rejection at preparation, settles the original unknown action by readback without resubmission, then prepares a fresh replacement only after settlement.
- Added real SQLite close/reopen and deterministic journal replay comparison with guaranteed temporary-directory cleanup.
- Added `npm run operations:demo` and configured it in the existing two-version CI matrix.
- Added the integration guide and updated the README, security status, and architecture overview.

## TDD evidence

RED:

```text
npm run build && node --test tests/operations-demo.test.mjs
Error: Cannot find module '.../dist/operations-demo.js'
tests 1, pass 0, fail 1
```

The failure was the intended absent-demo boundary, before either production demo file existed.

GREEN after the minimal demo implementation:

```text
npm run build && node --test tests/operations-demo.test.mjs
tests 1, pass 1, fail 0
```

The test executes the compiled demo in a subprocess, parses its stdout as JSON, and checks the two-domain verification count, zero real effects, unknown replacement barrier, and replay equality.

## Final verification

- `npm run check`: exit 0; typecheck passed and 113/113 tests passed.
- `npm run demo`: exit 0; `realMessagesSent` was 0 and `replayMatches` was true.
- `npm run mvp:demo`: exit 0; restart/cross-thread scenario remained open with 10 journal records.
- `npm run operations:demo`: exit 0; reported `mode: synthetic-operations`, `realExternalEffects: 0`, `verifiedOperations: 3`, `unknownBlocked: true`, and `replayMatches: true`.
- Extracted the contiguous `.mjs` example from `docs/general-operations.md` and ran it with Node.js: exit 0.
- `git diff --check`: exit 0 with no output.

These are local observations. CI was configured to run the operations demo for Node.js 22.16.0 and 24.x but was not run locally as hosted Actions.

## Boundaries retained

- All demo data and provider mutations are in memory and synthetic; no remote account, network effect, credential, or paid resource is used.
- Handler code explicitly enforces provider and resource contracts and remains trusted in-process code, not sandboxed plugin code.
- Connection owner IDs are local trust bindings, not remote authentication.
- Alias connection IDs for the same workspace/provider/subject share one conservative conflict scope.
- Satisfied readback establishes desired state, not causation, exhaustive account coverage, or WorkItem completion.
- No runtime dependency or core domain branch was added.
