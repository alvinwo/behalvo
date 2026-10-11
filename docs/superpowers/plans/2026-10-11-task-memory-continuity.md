# Task and memory continuity implementation plan

Design: [approved spec](../specs/2026-10-11-task-memory-continuity-design.md).
Plan approved by delegated Astra/max architecture review on 2026-10-11.

Execution: primary implements sequentially; delegated architect reviews this plan;
independent Sol/high and Astra/high contexts review the final branch.

## Task 1: Durable continuity and compatible projection upgrade

Files: new `src/kernel/task-continuity.ts`, `src/runtime/task-continuity.ts`,
`src/runtime/task-messages.ts`; update kernel types/reducer, SQLite codec/store,
storage CLI; tests `tests/task-continuity.test.mjs` and
`tests/task-continuity-upgrade.test.mjs`.

Interfaces:
- `TaskContinuity`: `focus[threadId] = {workId: string|null, revision: number}`,
  optional `localThreadId`, `intakes[ownerRecordId]`, `progress[workId]`.
- `OwnerIntakeReceipt`: owner record, thread, work ID or null, work revision at
  intake, `ready|clarify`, optional question and exact created-goal source quote.
- `ProgressReport`: summary <=2048 UTF-8 bytes, nextStep <=1024, blocker null or
  <=1024, <=8 typed `{kind: owner_message|browser_observation|action, id}` references.
  `TaskProgress` adds revision, workRevision, ownerRecordId, application stopReason.
- Events `task.focused`, `task.intake_recorded`, `task.progress_recorded`; source
  validation uses scoped record/artifact reads. Exact fields and revisions reject
  malformed, duplicate, cross-work and oversized events. Progress has no work-phase
  or authorization mutation.
- `selectTaskThread(store, workspaceId, ownerId, threadId, workId, selectLocal)`
  persists focus (and any explicit thread link) via normal append. A read helper
  resolves startup selection, honoring explicit caller thread over saved selection.
- `SqliteStore.upgradeTaskContinuityProjection(workspaceId)` validates/replays
  the current v1-v3 projection, initializes missing earlier memory layers plus
  empty continuity, and saves v4 atomically. Idempotent on v4. No inferred focus.
  `storage upgrade-continuity` holds exclusive local maintenance lock.

First tests: restart retains only selected workspace/thread focus; wrong owner,
closed work and stale focus/progress revisions rejected; progress does not change
an approved action's work revision; duplicate receipt/source mismatch rejected;
plaintext/encrypted upgrade + backup + replay preserve journal and execute nothing;
v1-v3 ordinary writes preserve their version/shape; corruption blocks upgrade.
Observe RED, implement, run focused tests. Adapt old downgrade fixtures to remove
v4 state and use the actual source encryption version, preserving their assertions.

## Task 2: Owner-only intake and same-turn continuation

Files: new `src/runtime/task-intake.ts`; update teaching preparation/extractor
helpers and AgentService; tests `tests/task-intake.test.mjs` and
`tests/task-continuity-agent.test.mjs`.

Interface: `processTaskIntake(store, gateway, model, binding, execution, maxBytes)`
returns `{receipt, completionsUsed: 0|1}`. It first reuses a validated matching
receipt, rejecting explicit retry retargeting. New intake sees only the current
owner input and <=8 candidates limited to focus and exact current-owner naming.
Each candidate supplies its own validated owner goal quotes, active teachings and
open clarifications with exact sources. No model-authored title/goal, assistant
content, browser observation or unrelated task memory is included.

Model shape: `{task, teachings}`. `task` is `{kind:'keep'}`,
`{kind:'create', title, goal, sourceQuote}`, `{kind:'select', workId, sourceQuote}`,
or `{kind:'clarify', sourceQuote, question}`. Selection quote must uniquely identify
one eligible exact owner-named task by ID/title; creation generates its ID in the
runtime. `teachings` retains the strict current protocol and selected-work target
validation. Creation has no existing teaching IDs. Ambiguity creates a hold when
there is focused work, or a clarification-only receipt without work.

Prepare all events on a preview; extend teaching preparation with an explicit
preview-state input without weakening its default persisted-state behavior.
Append task/focus/teachings/receipt atomically under expected stream version and
in-transaction deadline/fence checks. Leave inbox pending. Rebuild context from
committed state, then call the existing loop with seven remaining completions
(or eight on explicit retry that reuses intake) and the shared deadline. Clarify or
validation failure cannot start tools. Reject legacy facts/new-work proposals from
continuity-mode final responses. Keep legacy feature paths intact for library and
service compatibility.

First tests: goal+constraint→one turn acts using committed teaching; correction→
new revision is used immediately; A→B correction receives only relevant owner
sources and cannot modify A; fabricated source/title injection/cross-work IDs
rejected; no “remember” keyword required; ambiguous choice stops; throw after intake
then retry→same work and teaching revision; newer correction/focus survives old
retry without changing the persisted or REPL-selected focus; completed redelivery makes no model call; cancellation/lock-wait timeout
cannot commit intake; pre-processing and loop share request/call/time bounds.

## Task 3: Progress settlement and bounded continuation context

Files: new `src/memory/task-context.ts`; update model types/validation, operation
loop, browser exploration, AgentService, context builder; tests
`tests/task-continuity-agent.test.mjs`, `tests/task-continuity-context.test.mjs`.

Allow optional `progress: ProgressReport` in final ordinary and browser envelopes;
strictly validate it and reject unknown fields. Bind owner/work/revisions in the
application, not model output. Add a progress event to final reply settlement;
application stop checkpoints retain previous useful next-step data and record the
actual stop reason, retaining the original advice work revision so stale advice
never becomes fresh merely because a stop was recorded. Stale output, late completion and unconfirmed browser cleanup
cannot create progress. Progress references resolve only within the current work.

`renderTaskContext(state, work)` pins the latest advisory checkpoint, its stale
status and typed reference IDs, plus any historical browser stop reason/source IDs.
Never serialize browser live refs/session/document handles. Current action status
remains separate and authoritative. Source payloads stay retrievable through
existing scoped store APIs; no general search service is introduced.

First tests: final progress survives restart; absent final browser note still
leaves a visible stop checkpoint; stale progress is labeled and corrected teachings
remain authoritative; budget overflow never silently drops mandatory state; external
and cross-work references rejected; a model saying “done” cannot close work; unknown
actions remain unknown; final progress/reply are atomic; stale/cancelled results
cannot replace newer progress.

## Task 4: Normal CLI integration and acceptance

Files: CLI main/local-app/repl, message catalog, README, local-MVP guide,
SECURITY; tests CLI/main/continuity acceptance.

Normal model-backed CLI requests continuity for v4; v1-v3 shows the explicit
maintenance command. `--task-teachings` remains accepted. Library callers opt in
through `taskContinuity`; offline demonstration retains its deterministic mode.
REPL persists selected local thread and work; `/new`, `/work`, clear and explicit
initialThreadId remain overrides. Preserve the existing prepared-action thread
resume behavior. `/work` reports advisory next step/blocker and actual action state.
After a turn, use the returned intake binding (not model work proposals) for focus.

First tests: two independently opened app instances resume the same task/thread
without `/work`, use a correction and report remaining work; explicit new thread
and clear survive restart; workspace separation; legacy CLI upgrade guidance;
prepared approval survives resume; synthetic browser observe/correction/restart
uses fresh refs without duplicated intake or hidden external effects.

Run focused tests after each behavior change. At final source: `npm run verify`
with `PATH=/opt/homebrew/opt/node/bin:$PATH TMPDIR=/private/tmp`; record terminal
summary and raw logs. Run composed synthetic acceptance. Address independent
Sol/high + Astra/high findings with focused regression tests. Push/create PR under
standing owner authorization, attach it, require exact-head hosted checks, merge,
and safely sync local master. Stop after the specified acceptance gates pass.

## Review focus

- Ambiguous task names and unrelated task memory: ask, never guess or leak.
- Interrupted intake and newer owner corrections: idempotent retry, never undo.
- Projection migration with authenticated payloads: validate old state, replay only.
- Stale self-reported progress vs real effects: no authority or completion promotion.
- Restart after browser stop: retain the next step, re-observe before using controls.
