# Local Agent MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Build a locally runnable, restart-persistent personal agent CLI with a provider-neutral model layer and an optional Pi model gateway.

**Architecture:** Preserve the existing journal-backed kernel. Add a thin `ModelGateway`, a trusted `AgentService` that converts validated model proposals into domain operations, and a terminal REPL. Pi is a replaceable transport adapter and never owns durable state.

**Tech Stack:** TypeScript, Node.js 22+, built-in `node:sqlite`, Node test runner; optional `@earendil-works/pi-ai` on user machines.

**Spec:** `docs/superpowers/specs/2026-09-07-local-agent-mvp.md`

## Global Constraints

- English is the canonical documentation language; Chinese is optional companion material.
- Journal/history remains append-only from application code.
- Raw messages are retained; summaries never become authority.
- Provider credentials never enter Journal, artifacts, prompts, state, or checked-in config.
- No real external side effect can be executed from model output in this MVP.
- The repository must compile and its offline test suite must pass without Pi installed.

---

### Task 1: Model contract and strict AgentTurn validation

**Files:**
- Create: `src/model/types.ts`
- Create: `src/model/validation.ts`
- Modify: `src/index.ts`
- Test: `tests/model.test.mjs`

**Interfaces:**
- Produces `ModelRef`, `ModelInfo`, `ModelRequest`, `ModelResponse`, `ModelGateway`, `AgentTurn`, `parseAgentTurn(text)`.

- [x] Write tests proving valid envelopes parse and malformed/unknown fields fail closed.
- [x] Run the model test and verify RED because the model module does not exist.
- [x] Implement the minimal provider-independent types and strict parser.
- [x] Run model tests and then the full existing suite.
- [x] Commit.

### Task 2: Trusted AgentService and durable assistant messages

**Files:**
- Create: `src/runtime/agent-service.ts`
- Modify: `src/kernel/types.ts`
- Modify: `src/kernel/reducer.ts`
- Modify: `src/storage/sqlite-store.ts` only if a small query helper is needed
- Modify: `src/index.ts`
- Test: `tests/agent-service.test.mjs`

**Interfaces:**
- Consumes `ModelGateway`, `buildContext`, `Operator`, `SqliteStore`.
- Produces `AgentService.runOwnerTurn(input): Promise<AgentTurnResult>`.

- [x] Write a restart-persistence test using a deterministic fake gateway: first turn creates a WorkItem/fact; restart; second turn receives current state and returns an answer.
- [x] Verify RED for missing AgentService.
- [x] Implement owner-message ingestion, bounded context building, model call, strict validation, trusted proposal application, and durable assistant-message ingestion.
- [x] Add a test proving model-supplied fact provenance is ignored and rebound to the owner message record.
- [x] Run focused tests and the full suite.
- [x] Commit.

### Task 3: Model selection registry and fake/offline gateway

**Files:**
- Create: `src/model/registry.ts`
- Create: `src/model/fake-gateway.ts`
- Modify: `src/index.ts`
- Test: `tests/model-registry.test.mjs`

**Interfaces:**
- Produces `ModelRegistry.list()`, `selected()`, `select(provider, model)`, `complete(request)`.

- [x] Write tests for listing, switching, persistence-neutral selection, and unknown model rejection.
- [x] Verify RED.
- [x] Implement registry and deterministic fake gateway.
- [x] Run focused and full tests.
- [x] Commit.

### Task 4: Optional Pi gateway

**Files:**
- Create: `src/model/pi-gateway.ts`
- Modify: `src/index.ts`
- Test: `tests/pi-gateway.test.mjs`

**Interfaces:**
- Produces `PiRuntime` adapter contract and `PiModelGateway`.
- `PiModelGateway.create()` dynamically loads `@earendil-works/pi-ai`; tests inject a fake runtime.

- [x] Write tests with a fake Pi runtime for provider/model discovery, model selection, request transformation, and assistant text extraction.
- [x] Verify RED.
- [x] Implement the smallest dynamic adapter; no static Pi import is allowed.
- [x] Add a test that a missing Pi package yields an actionable installation error while the base package still imports successfully.
- [x] Run focused and full tests.
- [x] Commit.

### Task 5: Local REPL and inspection commands

**Files:**
- Create: `src/cli/repl.ts`
- Create: `src/cli/main.ts`
- Modify: `package.json`
- Modify: `src/index.ts`
- Test: `tests/cli.test.mjs`

**Interfaces:**
- Produces `runRepl(options)` with injectable input/output for tests.
- Adds `npm run agent`.

- [x] Write scripted REPL tests for `/model`, owner turn, `/work`, `/state`, `/history`, `/context`, `/new`, and `/quit`.
- [x] Verify RED.
- [x] Implement command parsing and REPL around `AgentService`.
- [x] Run focused and full tests.
- [x] Commit.

### Task 6: Restart demo and operator documentation

**Files:**
- Create: `src/mvp-demo.ts`
- Create: `docs/local-mvp.md`
- Create: `docs/local-mvp.zh-CN.md`
- Modify: `README.md`
- Modify: `package.json`
- Test: `tests/mvp-demo.test.mjs`

**Interfaces:**
- Adds `npm run mvp:demo`, proving first run -> close -> reopen -> second thread can use durable state.

- [x] Write the end-to-end demo test first and verify RED.
- [x] Implement the deterministic offline demo.
- [x] Document local setup, Pi installation, `/login openai-codex oauth`, Codex subscription use, model selection, and the boundary that live OAuth is not exercised in CI/offline tests.
- [x] Run `npm run check`, `npm run mvp:demo`, and a clean-copy verification.
- [x] Commit.

### Task 7: Final verification and handoff

**Files:**
- Modify: `docs/VERIFICATION.md`

- [x] Record exact Node version, commands, test count, offline Pi boundary, and known limitations.
- [x] Run `npm run check` fresh.
- [x] Run `npm run mvp:demo` fresh.
- [x] Clone/export a clean artifact and re-run build/tests/demo there using installed local dev dependencies.
- [x] Inspect `git diff`, `git status`, and recent commits.
- [x] Produce updated ZIP and Git bundle.
