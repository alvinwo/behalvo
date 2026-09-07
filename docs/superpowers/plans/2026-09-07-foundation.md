# M0 Journal-backed Kernel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Deliver an offline, tested kernel demonstrating cross-thread work, safe effects and restart durability.

**Architecture:** A single TypeScript package with kernel, SQLite storage, runtime and memory modules. Journal and projection updates share transactions. External effects use a fake driver and are never replayed.

**Tech Stack:** Node.js >=22.16.0; TypeScript 5.8.3; @types/node 22.19.7; built-in SQLite and node:test.

**Spec:** `docs/superpowers/specs/2026-09-07-architecture-v0.md`

## Global Constraints

- No runtime npm dependencies.
- Single-process trusted local API; no live credentials, messaging or provider calls.
- Model proposals must not bypass approval or write authoritative state.
- No claim of production readiness, completed GitHub publication or verified delivery.
- Reference data and tests are entirely synthetic.
- Keep license `UNLICENSED` and package `private` until the owner selects release terms.

## Task 1 — Journal, reducer and SQLite

Files: `src/kernel/types.ts`, `src/kernel/reducer.ts`, `src/storage/sqlite-store.ts`, `tests/foundation.test.mjs`.

Interfaces: `SqliteStore(path)`, `createWorkspace(id, owner)`, `state(id)`,
`append(id, expectedVersion, events, metadata)`, `journal(id)`, `rebuild(id)`, `close()`.

- [x] Write behavior tests first, including atomic rejection of an invalid batch.
- [x] Run `node --test tests/foundation.test.mjs`; missing implementation must fail assertions.
- [x] Implement the typed reducer and SQLite transaction boundary.
- [x] Run `npm test`; journal, isolation and rollback tests must pass.
- [x] Commit the storage foundation.

Example contract:
```js
const before = store.state('personal');
assert.throws(() => store.append('personal', before.version, [
  {type:'work.created', data:{id:'w', title:'Refund', goal:'Owner confirms receipt', threadId:'im'}},
  {type:'work.created', data:{id:'w', title:'Duplicate', goal:'Invalid', threadId:'im'}}
]));
assert.deepEqual(store.state('personal'), before);
```

## Task 2 — Policy-gated effects and scheduling

Files: `src/kernel/policy.ts`, `src/runtime/operator.ts`, `src/ports.ts`, `tests/effects.test.mjs`.

Interfaces: `Operator(store, clock)`, `createWork`, `propose`, `approve`,
`runEffect`, `recoverInterrupted`, `reconcile`, `schedule`, `fireDue`.

- [x] Write tests for unauthorized, expired and stale approval, duplicate operation,
  uncertain outcome, restart recovery, and provider-accepted versus work-completed.
- [x] Run the tests red before implementing these APIs.
- [x] Persist approval and started/result transitions, retain stable operation keys,
  and make timer firing/inbox insertion one transaction.
- [x] Run `npm test`; a driver must not be invoked twice by redispatch.
- [x] Commit runtime lifecycle.

Example contract:
```js
const a = operator.propose('personal', {workId:'w', key:'followup-1',
  command:{kind:'message.send', channel:'mock-email', to:'vendor@example.test', body:'Please confirm.'}});
await assert.rejects(operator.runEffect('personal', a.id, driver), /approval/i);
assert.equal(driverCalls, 0);
```

## Task 3 — Source-preserving memory and context

Files: `src/memory/context.ts`, `tests/memory.test.mjs`.

Interfaces: `buildContext(store, request)`, `SqliteStore.saveSummary`,
`readArtifact`, `threadMessages`; `resolveFact` in the kernel.

- [x] Write tests for raw retention, scope filtering, invalid source references,
  thread switching, pinned-block budget overflow, and fact validity/conflicts.
- [x] Run these tests red.
- [x] Implement bounded owner-only context and source-linked summary storage.
- [x] Run `npm test`; verify context omission never deletes archive records.
- [x] Commit memory foundation.

Example contract:
```js
const context = buildContext(store, {workspaceId:'personal', ownerId:'owner',
  threadId:'web', workId:'w', windowTokens:4000, outputReserve:1000});
assert.equal(context.work.id, 'w');
assert.ok(context.estimatedTokens <= 3000);
assert.equal(store.readArtifact('personal', originalRef), originalText);
```

## Task 4 — Offline example and repository handoff

Files: `src/demo.ts`, `README.md`, `docs/architecture.zh-CN.md`, `docs/ROADMAP.md`,
`docs/issues/*.md`, `.github/workflows/ci.yml`, `AGENTS.md`, `SECURITY.md`,
`CONTRIBUTING.md`, `LICENSE-DECISION.md`, `docs/VERIFICATION.md`.

- [x] Add an integration test that launches the offline demo in a child process.
- [x] Run it red; implement demo with synthetic data and restart simulation.
- [x] Run `npm ci --offline --cache /root/.npm --ignore-scripts`, `npm run check`,
  `npm run demo`, and `git diff --check` in this environment.
- [x] Record actual output and known limitations; do not claim unexecuted CI passed.
- [x] Commit and create a source archive and Git bundle, excluding dependencies,
  data, secrets and transient output. Verify both artifacts can be restored.

## Release boundary

GitHub connection, repository owner, public release license and production
provider credentials are not inferred. Remote repository and Projects board must
be reported as uncreated until actual write tools succeed. Local implementation
and documented issue backlog do not depend on remote access.
