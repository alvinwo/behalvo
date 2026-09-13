# Agent evaluation implementation plan

> For agentic workers: use superpowers:subagent-driven-development. Steps use
> checkbox syntax for tracking. Do not claim live evaluation without live evidence.

**Goal:** Deliver the M1.1 evaluation harness for the approved usable-version roadmap.
**Spec:** `docs/superpowers/specs/2026-09-13-agent-evaluation-design.md`.
**Architecture:** Evaluation-only orchestration of real runtime/operations and
synthetic fixtures; Pi optional metadata and request controls only in model layer.
**Stack:** Existing TypeScript/Node/SQLite/Pi; no new dependencies.

## Global Constraints

- Only synthetic accounts and isolated in-memory stores; no real account side effects.
- Scripted evidence is never live-model evidence. Automated checks never certify M1.1.
- No arbitrary model-created approvals, new tools, credential discovery or auth values in output.
- Preserve journal/reducer/workspace/policy boundaries. Unknown writes are never retried.
- No private reasoning, system prompts or raw provider exceptions in reports.
- Use apply_patch for edits, TDD for behavior, focused tests during iteration and full check before each implementation commit.
- Keep all generated evaluation reports git-ignored and unpublished.

### Task 1: Bounded model telemetry gateway

Files: modify `src/model/types.ts`, `src/model/pi-gateway.ts`,
`tests/pi-gateway.test.mjs`; add `src/evaluation/telemetry.ts` and
`tests/evaluation-telemetry.test.mjs`. Export only if existing conventions need it.

- [ ] Read model interfaces and installed Pi request/usage types. Add optional
  model-request controls `signal`, `maxRetries`, `maxOutputTokens`, forwarded as
  Pi `signal`, `maxRetries`, `maxTokens`. Calls without options preserve behavior.
- [ ] Add optional normalized model usage: nullable token fields `inputTokens`,
  `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`, `totalTokens`, nullable
  `estimatedCostUsd`, and source `pi-sdk`. Finite nonnegative integer tokens and
  finite nonnegative cost only. Unknown fields remain null. Pi cost is a catalog
  estimate and zero SDK counters do not prove actual usage or billing.
- [ ] Write failing tests for mapping optional controls/usage and sanitization,
  completion/time bounds, disabled retries and 2,048 output-token request,
  oversized response, provider error secrecy, and discarded late results.
- [ ] Implement an evaluation-only `BudgetedModelGateway` around `ModelGateway`.
  Its options supply `maxCalls`, `maxDurationMs`, optional `callTimeoutMs` (45,000
  default), optional clock for tests. It exposes immutable/copy snapshots of
  call records and `exhausted` status for the runner. `complete` rejects with
  stable sanitized codes: `call_budget`, `suite_deadline`, `call_timeout`,
  `provider_error`, `response_size`. Enforce valid positive bounded options.
  Clamp each call to remaining suite duration, abort on timeout, and prevent late
  responses from changing records. In-flight concurrency cannot bypass limits.
- [ ] Records include provider/model, latency, request/response bytes, safe status,
  normalized usage or null, and visible response excerpt at most 8,000 UTF-8
  bytes (with truncation flag). No raw exception text or private Pi content.
- [ ] Run focused tests RED then GREEN and `npm run check`. Commit code/tests and
  report commands/output, interfaces, concerns to assigned report file.

### Task 2: Synthetic scenario suite and runner

Files: add `src/evaluation/types.ts`, `fixtures.ts`, `scenarios.ts`, `runner.ts`,
`scripted-gateway.ts`, and `tests/agent-evaluation.test.mjs`. Split the registry
into a focused companion only if needed to keep scenarios readable; no runtime
refactor or new production agent tools in this task.

- [ ] Read the spec's complete scenario table and existing operation-loop tests,
  demo handlers and AgentService. Consume Task 1 telemetry API. The runner accepts
  explicit mode/model/gateway, case selection, repeats and suite budgets, and
  optional source metadata; it never accepts a database or real handler.
- [ ] Write failing integration tests using real AgentService/OperationService
  and synthetic provider. Assert all 20 unique versioned cases, full 3-repeat
  scripted run, isolated repeated fixtures, unknown/readback exactly one
  submission, prepared actions not autoapproved, no missing-value inventions,
  source injection and other-workspace canary containment. Include adversarial
  gateway tests that trigger unauthorized mutation, false state success, generic
  provider/protocol failures and budget exhaustion so vacuous passes are caught.
- [ ] Implement each fixture using real trusted APIs and fixed synthetic clock.
  Seed exact approved actions before relevant turns; never approve arbitrary
  model output. Existing synthetic contact/subscription handlers are the only
  effectors. Lost-response has a second explicit owner readback-only turn.
  External source injection is ingested as external source, not as owner text.
- [ ] Implement suite `synthetic-v1` with the 20 IDs/expected evidence in the
  spec. Pure chat cases require a healthy model-authored final, not merely no
  side effects. Expected application stops require matching operation evidence
  and expected stop type, not broad substring matching. Enforce no unexpected
  mutations, workspace/request canary isolation and exact submission counts.
  Automatic checks must not enforce arbitrary model-chosen IDs/wording beyond
  requested semantic values; attach meaningful manual-review questions.
- [ ] Provide a scripted gateway that produces normal catalog/tool/final
  envelopes for the fixture context. Label scripted mode unambiguously. Never
  bypass operations or write result state directly. Scripts are not evaluation
  judgments: scenario assertions independently inspect resulting state/evidence.
- [ ] Return bounded JSON-safe report with scenario/repeat check results,
  per-call records, owner prompts, final visible replies, action/fact/work
  evidence, source metadata and explicit manual review pending. Budget skips and
  transport failures are failed/incomplete, never successful clarification.
  Full-suite eligibility requires all 20 cases and at least 3 repetitions;
  no report can declare milestone accepted. Close every fixture in finally.
- [ ] Run focused RED/GREEN, full `npm run check`, and commit/report interfaces
  and commands/output for CLI integration and review.

### Task 3: CLI, safe reports and documentation

Files: add `src/evaluation/main.ts`, `report.ts`, `tests/evaluation-cli.test.mjs`,
`docs/AGENT_EVALUATION.md`; update `package.json`, `.gitignore`, `README.md`,
`docs/ROADMAP.md`. No dependency change expected.

- [ ] Write failing tests for no-mode help, `--list` without Pi load, mutually
  exclusive modes, unknown/duplicate flags, invalid/duplicate case IDs, unsafe
  numeric bounds, missing live model and output failures. Live model selection
  uses `--model`, `BEHALVO_MODEL`, then `OPERATOR_MODEL`; auth path uses `--auth`,
  `BEHALVO_PI_AUTH`, `OPERATOR_PI_AUTH`, then `data/pi-auth.json`. Never print
  auth path contents or raw startup/provider errors. No automatic login.
- [ ] Implement `npm run eval:agent` building and invoking the CLI. No mode
  means help; live calls require `--live`. Default bounds: 3 repeats, 240 calls,
  900 seconds. Bounds: repeats 1..10, calls 1..2,400, seconds 1..3,600.
  `--case` may repeat for distinct IDs. `--out` defaults to a unique report path
  under `data/evaluations`. Listing/help must not create reports or load Pi.
- [ ] Implement atomic non-overwriting JSON output with 0600 permissions and
  parent-directory handling, refusing existing files/symlinks. Test existing
  targets remain unchanged and no raw model output appears in terminal summary.
  Reports are synthetic but untrusted, private and ignored by git.
- [ ] Emit concise summary: mode/model, automatic pass count, completeness,
  budget/call/latency summary, report path and live/manual acceptance pending.
  Exit 0 automatic selected checks complete/pass, 1 fail/incomplete, 2 invalid
  args/startup. Partial/filtered/scripted runs cannot certify acceptance.
- [ ] Document scripted and explicit live commands, secure existing auth setup
  without credential paste, report interpretation, failure/timeout/cost limits,
  manual review rubric and all critical cases. Update roadmap with approved
  sequence: live-model evaluation; secure mobile owner control; one mail
  integration; durable worker; two-week personal alpha; later multi-account /
  constrained browser; small public alpha. Mark live acceptance not yet run.
- [ ] Run focused RED/GREEN and `npm run check`; run `npm run eval:agent --
  --scripted` (3 repetitions), `--list`, and all three existing demos. Commit
  code/docs and report exact evidence; do not commit generated reports.

## Final acceptance and publication

- [ ] Read requesting-code-review skill and dispatch broad independent Astra
  and Sol reviews of the whole branch. Fix real findings; scoped re-review.
- [ ] Run verification-before-completion: fresh full check, scripted evaluation
  and demos. Confirm source tree and generated output status.
- [ ] Publish isolated branch and PR to `alvinwo/behalvo`; confirm exact tree,
  CI on required Node versions, and reviewed head before authorized merge.
- [ ] Report harness delivery separately from the blocked genuine live runs.
  Secure hosted model authorization is the remaining live-evaluation prerequisite.
