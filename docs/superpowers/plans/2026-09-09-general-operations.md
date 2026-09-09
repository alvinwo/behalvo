# General prepared operations implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the general prepared-operation lifecycle across isolated connections, with durable authorization, conflict handling, and readback.

**Architecture:** Extend the existing discriminated Command and Action types. Add trusted versioned operation handlers and a runtime service that writes existing action events plus connection/verification events. Keep message sends compatible and domain-specific behavior outside the kernel.

**Tech Stack:** TypeScript, Node built-in SQLite, node:test.

**Spec:** docs/superpowers/specs/2026-09-09-general-operations.md

## Global Constraints

- Node.js >=22.16.0. TypeScript modular monolith. No new runtime dependencies.
- Synthetic data only.
- All domain mutation goes through journal events and deterministic reduction.
- Replay is read/reduce only; never execute effects during recovery of projections.
- A timeout is unknown, not proof of failure. Never auto-retry unknown side effects.
- Owner ID is a local trust binding, not authentication suitable for a public API.
- Preserve legacy message.send behavior and old schema-v1 journal readability.
- Handler implementations are trusted code, not sandboxed by these interfaces.

---

### Task 1: General operation runtime and behavior tests

**Files:** Create src/operations/types.ts, validation.ts, registry.ts, service.ts and tests/operations.test.mjs (split cohesive modules/tests if needed). Modify src/kernel/types.ts, reducer.ts, policy.ts, src/runtime/operator.ts, src/storage/sqlite-store.ts and src/index.ts. Narrow legacy ports to message commands as needed while keeping exported Command a discriminated union.

**Interfaces:** Produce exported OperationService and OperationRegistry plus connection/observation/handler/operation-command types. OperationService takes SqliteStore, OperationRegistry and an optional clock. It exposes registerConnection, revokeConnection, prepare, approveBatch, execute, verify, reconcile and recoverInterrupted. Choose explicit typed input objects, document their exact signatures in the final guide. Existing Operator remains the owner of WorkItem lifecycle. The spec defines the mandatory data and invariants; implementer chooses cohesive naming within these files and records any adjustments.

- [ ] Write failing behavior tests using real SqliteStore and controllable trusted handlers. Tests import new public exports from dist/index.js. Minimal starting fixture:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { SqliteStore, Operator, OperationRegistry, OperationService } from '../dist/index.js';

test('general operations expose a separate trusted runtime while preserving work ownership', () => {
  const store = new SqliteStore(':memory:');
  try {
    store.createWorkspace('personal', 'owner');
    const operator = new Operator(store);
    const registry = new OperationRegistry();
    const service = new OperationService(store, registry);
    assert.equal(typeof service.prepare, 'function');
    assert.equal(operator.createWork('personal', 'owner', {
      id: 'work', title: 'Change a profile', goal: 'Observe the desired profile state', threadId: 'thread'
    }).phase, 'open');
  } finally { store.close(); }
});
```

- [ ] Run npm run build && node --test tests/operations.test.mjs. Observe the missing-export failure before implementation; then extend the tests for every acceptance case in the spec before the corresponding behavior.
- [ ] Implement the minimal data flow below with exact scope binding and runtime validation. Record more specific API choices in the implementation report so Task 2 consumes actual exports.

```text
prepare: owner + connection + handler -> identify -> observe -> validate preparation -> action.proposed
approveBatch: validate every exact action/digest/expiry -> one transactional list of action.approved events
execute: check local gates -> identify + observe -> recheck local gates -> action.started -> execute -> action.finished
verify: identify + fresh scoped observation -> handler verdict -> verification event (and unknown reconciliation when satisfied)
reconcile: explicit owner evidence -> action reconciliation + separately labeled owner attestation
```

- [ ] Preserve the legacy message digest branch verbatim; use deterministic recursive JSON canonicalization only for operation commands. Validate connection and operation envelopes; bind generation, scope, expected state and preconditions. Reducers enforce conflict barriers and attempt revisions.
- [ ] Run npm run check and git diff --check. Test restart from a file database and old cached projections with no connections field; verify replay produces identical state and no handler execution.
- [ ] Commit implementation and tests with a focused message. Write a report with public signatures, red/green evidence, assumptions, and limitations. Task review must approve spec compliance and code quality before Task 2.

### Task 2: Runnable demonstration and integration guide

**Files:** Create src/operations/demo-handlers.ts, src/operations-demo.ts, tests/operations-demo.test.mjs and docs/general-operations.md. Modify package.json, README.md, SECURITY.md, docs/architecture.md and .github/workflows/ci.yml. Update lockfile only if package metadata changes require it.

**Interfaces:** Consume the actual exports and signatures from Task 1's report. Produce npm run operations:demo with JSON output containing mode='synthetic-operations', realExternalEffects=0, verifiedOperations, unknownBlocked, and replayMatches. Demonstration handler code is explicitly synthetic, using distinct provider-state contracts for contact updates and subscription cancellation. Add operations demo to CI on both existing Node versions.

- [ ] Write the subprocess regression first:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

test('operations demo verifies different domains with one durable runtime', () => {
  const result = JSON.parse(execFileSync(process.execPath, ['dist/operations-demo.js'], { encoding: 'utf8' }));
  assert.equal(result.mode, 'synthetic-operations');
  assert.equal(result.realExternalEffects, 0);
  assert.ok(result.verifiedOperations >= 2);
  assert.equal(result.unknownBlocked, true);
  assert.equal(result.replayMatches, true);
});
```

- [ ] Run the test after a build and observe the absent-demo failure.
- [ ] Implement the demo through public runtime methods. Prepare and approve profile/cancellation operations on separate subjects, execute and verify them, demonstrate an uncertain submission blocking replacement, reconcile without resubmission, close/reopen SQLite, and assert replay equality. Use a temporary directory and guaranteed cleanup.
- [ ] Document connection setup, exact public method signatures and handler contracts with an executable example drawn from the demo. Explain scope serialization, batch semantics, no-readback handling, evidence classes, trusted handler boundary, provider race limitations, and which real integrations remain unavailable. Update status tables honestly.
- [ ] Run npm run check, npm run demo, npm run mvp:demo, npm run operations:demo and git diff --check. Commit the demo, docs, and CI change; report observed results.

### Final review and publication

- [ ] Review the complete branch for security, correctness and spec compliance using an independent reviewer; fix confirmed findings and rerun the relevant tests.
- [ ] Publish the verified tree to alvinwo/behalvo on feat/general-operations. Verify the GitHub tree hash matches the local commit.
- [ ] Create an open PR against master, with scope, actual test evidence, and documented limitations.
- [ ] Verify exact-head CI on Node 22.16.0 and 24.x and record results in the PR.
