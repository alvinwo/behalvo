# Harness sessions implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resume chats and tasks reliably, inspect memory, and recall only relevant source-bound history.

**Architecture:** Derive session and recall views from the existing journal and intake receipts. Keep WorkItem goals and lifecycle authoritative; share one scoped recall helper between CLI and bounded model loops.

**Tech Stack:** TypeScript, Node >=22.19.0, existing SQLite store and node:test.

**Spec:** ../specs/2026-10-11-harness-sessions-design.md

## Global Constraints

- Synthetic test data only; no new dependency, runtime agent or schema migration.
- Domain mutation through existing journal events/reduction; replay is read-only.
- Owner-only workspace-bound retrieval; unclassified history is not automatic task context.
- New user-facing text follows English message-catalog pattern.
- Shared eight-completion and 120-second run limits; no automatic effect retry.
- Full POSIX `npm run verify` and independent Sol high/Astra high final review.

## Review Focus

- Mixed-topic owner messages must expose only the exact teaching quote as memory.
- Sparse matching history must paginate without crossing another task or returning unbounded data.
- An agent reply with missing/foreign causation must not inherit task scope by proximity.
- Resuming work with pending approval must preserve its revision and focus.
- Two direct turns in one chat must not ingest/interleave while independent chats can run.

### Task 1: Scoped history and context

**Files:** Create `src/memory/session-history.ts`, `tests/harness-history.test.mjs`; modify `src/memory/context.ts` and affected context tests.

**Interfaces:** Produce `messageInScope(state, record, {threadId, workId?, scope})`, `recallHistory(store, binding, args)`, `listSessions(store, workspaceId, ownerId)`. Binding includes workspaceId, ownerId, threadId, optional workId and audience. Recall args/result exactly follow the spec; session entries contain threadId, updatedAt, preview, optional workId.

- [ ] Write tests for A/B attribution, causation, linked threads, mixed summary rejection, exact teaching quotes, Unicode matching, 16 KiB result limit, limit/cursor validation and workspace/audience denial. Observe RED with `npm run build && node --test tests/harness-history.test.mjs`.
- [ ] Implement read-only receipt/causation-derived views and context filtering. Query matching excerpts with record provenance, retaining explicit current owner pin.
- [ ] Run history and existing context/continuity tests; adjust old assertions only where the approved strict attribution intentionally changes behavior.
- [ ] Commit the tested scope boundary.

### Task 2: Session and memory CLI

**Files:** Create `src/cli/session-commands.ts`, `src/memory/messages.ts`, `tests/harness-repl.test.mjs`; modify `src/cli/repl.ts`.

**Interfaces:** Consume Task 1 session/recall views. Produce trusted command handler returning `{threadId, workId?}` only for successful new/resume. Existing `selectTaskThread` remains the mutation boundary.

- [ ] Write tests for sessions/new/resume, existing ID rejection, restart focus, pending approval revision, readable legacy history, `/journal`, `/memory`, and `/recall`. Observe RED.
- [ ] Implement commands with bounded displayed previews/history and explicit memory provenance. Keep vault separate; add English catalog help/errors.
- [ ] Run `node --test tests/harness-repl.test.mjs tests/task-continuity-repl.test.mjs tests/teaching-repl.test.mjs` after build.
- [ ] Commit session surfaces.

### Task 3: Agent recall and session turn isolation

**Files:** Create `src/runtime/recall-tool.ts`, `src/runtime/recall-loop.ts`, `tests/harness-agent.test.mjs`; modify `src/runtime/agent-service.ts`, `src/runtime/operation-loop.ts`, `src/runtime/browser-exploration.ts`.

**Interfaces:** Consume `recallHistory`. Produce shared `RECALL_PROTOCOL` and `invokeRecall(store, binding, args)` where binding is application-owned. A plain continuity loop supports recall plus the existing final shape. Operation/browser loops expose the same read-only recall branch under existing deadlines/budgets.

- [ ] Write tests for model recall then final in plain/operation/browser modes; injected workspace IDs rejected, shared completion budget enforced, no memory/phase mutation, notes without a connected browser do not disable operation tools; concurrent same-thread second call rejected before ingest while another thread can proceed. Observe RED.
- [ ] Wire scoped recall and process-local direct-turn guard; remove browser-note-driven tool routing. Preserve service admission fences and synthetic behavior.
- [ ] Run harness-agent, continuity-agent, operation-loop and browser-exploration tests after build.
- [ ] Commit the harness behavior.

### Task 4: Document and verify

**Files:** Update `README.md`, `docs/IMPLEMENTATION_STATUS.md` (or existing status table location), and add `docs/verification/2026-10-11-harness-browser.md` alongside the browser deliverable.

- [ ] Document sessions vs tasks vs memories vs browser lifetime and usable command examples; record only observed verification.
- [ ] Run full POSIX verification and combined browser acceptance after browser implementation; obtain independent final pair review, resolve findings, exact-head hosted checks, then authorized merge.
