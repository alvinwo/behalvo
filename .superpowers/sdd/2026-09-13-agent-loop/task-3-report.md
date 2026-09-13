# Task 3 implementation report

## Scope and outcome

Implemented the approved bounded structured operation loop and opt-in persistent
synthetic terminal workflow on the existing `feat/agent-loop` worktree. Task 1
memory and Task 2 model setup behavior remain covered by the full suite. No real
account handler, effect credential integration, arbitrary shell/browser tool,
daemon, automatic retry, startup recovery, publication, or license change was
introduced.

## Changes

- `src/operations/execution-context.ts`: optional trusted second-argument context
  with absolute deadline and AbortSignal, actual elapsed-time checks, bounded
  awaits, listener/timer cleanup, and consumption of late promise rejection.
- `src/operations/service.ts`: guards before provider callbacks, after preflight
  awaits, before proposal/verification writes and immediately before dispatch.
  The final guard, durable start, and execute invocation have no intervening
  await. A timed-out in-flight attempt settles through `finishActionAttempt` as
  unknown before service return. Late results cannot overwrite it. Existing
  callers without the optional context retain their API behavior.
- `src/runtime/operation-loop.ts`: strict disjoint tool/final envelopes; catalog,
  prepare, inspect, execute and verify allowlist; trusted workspace/owner/work
  binding; application-owned preparation keys; eight completion attempts and a
  120-second deadline. Full accumulated request cap is 196,608 UTF-8 bytes or the
  caller's smaller input allowance, with 65,536 response, 16,384 tool-argument and
  32,768 tool-result byte caps. Trusted options may lower limits. Provider errors
  become fixed safe application replies rather than copied exception text.
- `src/runtime/agent-service.ts`: optional loop wiring with durable application
  stop replies and exactly-once inbox completion for normal stops. Final
  proposals retain `parseAgentTurn`, provenance grounding and pure reducer
  validation before commit. Domain-invalid final proposals become a safe durable
  stop in loop-enabled mode; legacy no-loop callers retain error behavior.
- `src/operations/local-synthetic.ts`: independent transactional SQLite provider
  truth/version persistence scoped by workspace/provider/subject/resource. Seeds
  only absent initial resources, rejects missing/corrupt prior truth, persists
  effects before acceptance, preserves matching generations and revoked status.
- `src/operations/demo-handlers.ts`, registry/types: a minimal provider interface
  shared by the memory demo and persistent simulator, and optional trusted
  operation catalog descriptions/resource IDs/strict argument schemas/examples.
- `src/storage/sqlite-store.ts`: additive local deployment-mode metadata prevents
  ordinary/synthetic database rebinding. Existing unbound databases continue in
  ordinary mode; synthetic mode requires a new database or matching mode binding.
  Mode metadata is operational configuration, separate from domain events.
- `src/cli/action-review.ts`, local app, main and REPL: explicit synthetic flag
  with isolated `data/synthetic-agent.db` default; explicit `--db` supported;
  ordinary DB environment variables do not select synthetic storage. `/actions`
  emits the actual focused journal commands as escaped JSON, and `/approve`
  requires exactly the displayed ID/full digest from this terminal session and
  grants ten minutes using the trusted clock. Approval returns control without
  resuming inference. `/context` help now identifies its base-context scope.
- README status table, SECURITY.md, local MVP and general operations guides:
  current workflow, exact commands, limits, mode/sidecar storage, no automatic
  recovery, no real operations, and transport/live-verification limits.

## Tests and observed red-to-green evidence

Added tests before each behavior family and observed expected failures for missing
service guards, loop interpretation, persistence/mode selection, terminal review
commands, safe exception handling, direct-loop owner authorization, final proposal
handling, caller budget propagation, and strict required final fields. The first
uncancellable-effect red runs were interrupted after the preflight assertions
failed and the old implementation remained pending; the implemented service
settles those cases without an external test timeout.

New behavior coverage includes:

- deferred identify and observe cannot dispatch after cancellation; expired actual
  deadlines block dispatch even without an abort timer firing;
- never-settling execute settles unknown; late success/rejection after timeout or
  store close is consumed without overwriting settlement or redispatch;
- deferred prepare/verify cannot write late after deadline or close;
- catalog supplies actual connection/resource IDs and required argument examples;
- prepare stops before another completion, requires separate approval, and a later
  run executes/verifies without completing the WorkItem;
- unknown tools, authority/extra fields, mixtures, arrays, missing fields and
  malformed arguments stop with a durable handled owner record;
- action inspect/execute/verify require focused-work scope; missing workspace
  actions and direct wrong-owner loop calls fail before privileged work;
- no-focused-work catalog remains available while action tools fail closed;
- eight completion limit, response-size bound, accumulated request-size bound,
  smaller caller budget, and late model completion suppression;
- unknown/failed execution and unsuccessful readback stop immediately; in-flight
  loop timeout settles action unknown before committing its durable owner reply;
- raw secret-sentinel provider/handler exceptions never reach stored stop replies;
- ungrounded facts and reducer-only reversed validity ranges produce durable safe
  stops with no partial final proposals;
- actual close/reopen preserves provider truth/version and approval generation,
  verified readback and one dispatch; equal subjects/resources in two workspaces
  remain isolated within one sidecar;
- ordinary/synthetic mode mismatch, missing/corrupt provider truth, revoked
  connection persistence and running barrier preservation;
- literal `/actions` gating, exact approval arity/digest, ten-minute expiry,
  escaped exact command display and session-reset review receipts;
- scripted terminal create work → prepare → display → approve → new owner turn →
  execute → verify → restart → inspect/readback with a single effect attempt.

## Verification performed

Runtime: Node.js v24.19.0.

- `npm run check`: 180 tests passed, zero failed/cancelled/skipped (typecheck and
  build included). The existing setup, memory, kernel, model/Pi and CLI tests pass.
- `npm run demo`: passed; zero real messages, replay matches, one fake dispatch.
- `npm run mvp:demo`: passed; cross-thread/restart work and fact state retained.
- `npm run operations:demo`: passed; three verified synthetic operations, unknown
  blocked, replay matches, zero real external effects.
- `git diff --check`: passed.

The environment emits npm's pre-existing unknown `http-proxy` configuration
warning; no test failure results from it. No dependency or lockfile changes were
needed for this task.

## Limitations and review notes

The deadline prevents later loop decisions and journal/effect continuation; it
cannot terminate an underlying model/provider transport that ignores cancellation
and is not an exact token or dollar-spend guarantee. Synchronous trusted callbacks
are not a process sandbox. Provider sidecar transactions model external truth;
they do not create provider-side idempotency or real conditional writes.

Interrupted running actions remain blocked at startup. There is no automatic
exclusive-maintenance claim, recovery CLI or daemon. Genuine storage failures or
concurrent writer conflicts can still surface as application errors rather than
being misrepresented as a successful durable reply; the runtime remains a trusted
local, one-logical-writer application.

The library-level AgentService constructor keeps loop behavior optional for
backwards compatibility; `openLocalAgent` enables the bounded loop in both modes,
with an empty operation registry in ordinary mode. The existing memory-only
operations demo is preserved; terminal synthetic truth uses its own sidecar.

No new live model inference, OAuth flow, or real effect was performed. Documentation
separately records the owner's earlier reported successful Codex login/chat. The
parent owns independent review and publication; this implementation report is not
a claim of passing that review.

## Independent review fix round 1

The parent supplied four confirmed integration findings from the two independent
reviews of `7a0e3c5`. Each was reproduced with a new failing behavior test before
its fix:

1. **Long-history request overflow.** Context selection previously budgeted only
   base text and could fill the allowance before adding the loop protocol and
   serialized envelope. The loop now shares one exact request serializer between
   context selection and dispatch. The supplied context counter includes protocol,
   bindings and JSON escaping; whole older messages are trimmed while current
   owner input remains pinned. Initial selection reserves up to 8,192 bytes, at
   most one quarter of the cap, for continuation. Full requests still obey the
   original hard/caller cap, and growing transcripts may stop before eight calls.
   Plain and quote/backslash/newline-heavy 40-message histories both now reach
   catalog and final completion below 56,000 bytes. `ContextPacket.estimatedTokens`
   documents the supplied full-request counter while `context.text` remains base
   context.
2. **Cross-workspace local provider routing.** Local apps now bind both
   AgentService and OperationService to the startup workspace. Every exposed
   OperationService mutation path, including register/revoke/approve/reconcile/
   recover, checks the binding before state/provider access; AgentService checks
   before ingestion/inference. The loop also checks its configured binding.
   Generic constructors remain unbound by default. A two-app first/alice and
   second/bob regression confirms that Alice's service rejects Bob's calls,
   Bob's provider truth remains separate, and rejected agent turns neither ingest
   nor call the model.
3. **Restart approval invalidation through thread linking.** With a proposed or
   approved operation, `/work` now resumes an existing linked work thread when the
   terminal's fresh thread is unlinked, and explicitly prints the resumed thread.
   It does not mutate the work revision. Work without pending operation approvals
   retains previous link behavior. Fresh terminal tests for both proposed and
   approved actions now complete approval/execution/verification with one attempt
   and the original revision. Reducer/replay and service revision checks remain
   unchanged.
4. **Final commit after artifact delay crossed deadline.** AgentService now
   rechecks the deadline after assistant artifact persistence and the final state
   read, immediately before atomic inbox completion. An elapsed deadline discards
   final proposals and switches the committed message to an application-authored
   stop. A controlled-clock regression advances time inside artifact persistence
   and confirms one safe reply, no model reply/proposal journal commit, and a
   handled owner inbox record. This does not claim that a synchronous SQLite
   transaction can freeze wall-clock time.

The parent independently committed model-settings work as `5ace1b6` while this
round was in progress; this round does not edit those files. Current full-tree
verification includes that commit and this fix round: `npm run check` passes 187
tests with zero failures/cancellations/skips. All three demos and `git diff --check`
also pass. Parent owns the subsequent independent rereview and publication.

## Final deadline follow-up

Independent verification caught an early timer firing that was misclassified as a generic provider error. An application-owned OperationStoppedError now classifies timer/cancellation stops without inspecting provider error text.

Re-review reproduced SQLite writer-lock waits crossing the deadline after the outer guard. SqliteStore append and completeInbox now accept an optional trusted guard executed inside the acquired transaction. Preparation, action start, verification, and model-derived inbox completion use that guard. Expired model commits roll back and produce a safe application-authored stop; post-dispatch uncertainty settlement remains allowed. Legacy callers retain their existing behavior.

Regression coverage includes a frozen-clock timer and actual child-process SQLite lock contention for preparation, start, verification, and final inbox completion. After the hosted workspace reconnected, the parent independently ran npm run check (192 passed, zero failures), all three demos, and git diff --check successfully. No live-model or real-account execution was performed. Final independent re-review and GitHub CI remain subsequent gates.

## Approval expiry at the same transaction boundary

Final scoped review confirmed that an approval could expire during a SQLite writer-lock wait even when the run deadline remained active. The start transaction now revalidates executable authorization with current state/time after acquiring its lock. A second TTL check immediately before provider dispatch also covers expiry during the durable start itself; an already started attempt remains unknown and does not dispatch. Both regressions failed before the correction and pass afterward, including real child-process lock contention.

Parent final verification: npm run check passed 194 tests; kernel, MVP, and operations demos and git diff --check passed.
