# Bounded operation agent implementation plan

> **For agentic workers:** Use superpowers:subagent-driven-development task by task.

**Goal:** Make local Behalvo setup reliable and expose bounded controlled operation execution to its chat agent.
**Architecture:** Preserve the journal kernel and existing OperationService. Add a structured tool loop and trusted terminal approval commands; inference remains disposable.
**Tech Stack:** TypeScript, Node SQLite, Pi 0.85.1.
**Spec:** docs/superpowers/specs/2026-09-13-agent-loop-design.md

## Global Constraints

Synthetic data only. No arbitrary shell/browser tools, real account integration or new license. Every effect uses OperationService approval and uncertainty semantics. No autonomous retries. English normative documentation. All changes stay on feat/agent-loop until verified publication.

### Task 1: Ground fact dates
Files: src/model/types.ts, validation.ts, src/runtime/agent-service.ts, src/kernel/types.ts, reducer.ts, src/memory/context.ts and affected fact tests.
- [ ] Write failing behavior tests for an ordinary preference with no onset date, unsupported model date, explicit owner-supplied UTC timestamp, legacy replay and cross-thread retrieval.
- [ ] Run targeted tests, observe expected failures.
- [ ] Implement nullable unknown validity and runtime observedAt. Ground any model date conservatively in the current owner message; document exact supported representation. Keep trusted Operator explicit-date API and legacy replay compatible.
- [ ] Run targeted tests and npm run check, self-review, commit.

### Task 2: Normal install and persisted model selection
Files: package.json, package-lock.json, .github/workflows/ci.yml, src/cli/main.ts and new settings module/tests, docs/local-mvp.md, README.md.
- [ ] Add failing behavioral tests for persisted selection, explicit startup overrides and malformed settings; never serialize credentials.
- [ ] Pin Pi 0.85.1 as dependency, align Node >=22.19 floor and CI; use npm install to generate lock.
- [ ] Add atomic nonsecret settings persistence and startup guidance. Preserve offline mode and existing flags/env precedence.
- [ ] Verify fresh npm ci and offline startup plus loader/catalog import without credentials, run check and commit.

### Task 3: Bounded operation loop and synthetic terminal workflow
Files: new src/runtime/operation-loop.ts and src/operations/local-synthetic.ts, src/runtime/agent-service.ts, src/cli/local-app.ts, main.ts, repl.ts, tests/operation-loop.test.mjs and terminal tests.
- [ ] Add failing tests for list/prepare/approval/execute/verify, rejected unknown tools and fields, workspace/work scoping, eight-completion limit, 120-second deadline and late completion, unknown halt, restart readback and no duplicate effect.
- [ ] Implement one structured request per completion through OperationService. Host the protocol in its own module and pass trusted bindings from AgentService; continue to parse final output with parseAgentTurn.
- [ ] Expose /actions and /approve id digest in trusted REPL. Enable explicitly synthetic accounts with --synthetic-operations and isolated persistent provider storage.
- [ ] Document exact commands and limits; run all checks/demos, task review and commit.

### Task 4: Review and integrate
- [ ] Review full diff independently with GPT-6 Astra and GPT-5.6 Sol, fix real findings and rerun relevant tests.
- [ ] Run check, demo, mvp:demo, operations:demo and diff checks.
- [ ] Publish exact verified tree to feature branch, create PR, verify CI for its head, merge, verify remote merge.
