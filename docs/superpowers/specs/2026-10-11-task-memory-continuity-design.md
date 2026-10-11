# Task and memory continuity refactor

Status: approved by delegated architecture review (Astra/max), 2026-10-11.
Date: 2026-10-11.

## Intent and finish line

The owner wants Behalvo to learn from OpenClaw and Hermes before resuming the
browser task. Explain a goal once, retain relevant instructions without a
“remember” incantation, report honest progress, and resume after a process restart.
The owner delegates design/review/merge decisions to specialists. This refactor
finishes when those behaviors pass synthetic acceptance and required release
checks; matching either project's entire feature set is outside scope.

## Research and choice

Official sources inspected on 2026-10-11:

- [OpenClaw goals](https://github.com/openclaw/openclaw/blob/main/docs/tools/goal.md)
  persist a session objective and reintroduce active-goal context. Goal status is
  distinct from detached work and schedules. Learn: make the objective and its
  continuation explicit in each relevant turn.
- [OpenClaw memory architecture](https://github.com/openclaw/openclaw/blob/main/docs/concepts/memory-architecture.md)
  separates instructions, curated memory, historical records and future intents,
  with different provenance and injection rules. Learn: retrieval and memory
  promotion need explicit trust boundaries.
- [Hermes memory](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/memory.md)
  uses small curated memory/profile stores, agent-managed updates and searchable
  session history. Learn: the agent should retain useful preferences and
  corrections proactively, and a claimed save must correspond to a durable write.
- [Hermes task list](https://github.com/NousResearch/hermes-agent/blob/main/tools/todo_tool.py)
  tracks revisioned steps and restores active work after context compression.
  Learn: remaining work belongs in a bounded structured checkpoint.
- [Hermes skills](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/skills.md)
  load procedural knowledge on demand. Behalvo's scoped, source-linked browser
  notes already serve a limited version of this purpose; expansion is deferred.

Options considered: a replacement framework would discard tested boundaries;
adding only prompts would leave restart and transactional gaps. Select a small
continuity layer over the existing journal, reducers, owner teaching extraction,
context builder and operation/browser loops. No new dependency or infrastructure.

## State and authority

Projection v4 adds `taskContinuity` with per-thread focused work, the last selected
local thread, intake receipts keyed by owner record, and latest progress per work.
All writes are journal events with deterministic reduction. Existing v1-v3 stores
retain their old shape and semantics until explicit validated maintenance. New
workspaces use v4. Upgrade verifies the old projection against replay, authenticates
encrypted payloads, adds empty continuity state, and infers no historical focus.

Focus is workspace-scoped and does not grant action permission. Explicit local
startup selection and `/new`, `/work`, `/work clear` persist through runtime APIs.
Startup resumes the last selected thread, unless a caller supplied a thread.
Model selection of existing work requires a unique exact owner quote naming that
work's ID or title; ambiguous references ask for clarification. Linking a new
thread advances work revision as it does today, so prior approvals cannot silently
survive a changed binding. Closed work cannot be selected as active.

Progress is advisory working memory, never owner instruction, verified external
fact, approval, or completion evidence. A checkpoint has an independent revision,
the work revision it describes, owner-record provenance, a short summary, next
step, optional blocker, an application stop reason, and optional typed evidence
references (`owner_message`, `browser_observation`, `action`). Runtime validation
requires each reference to resolve inside the same workspace and focused work;
owner messages must be owner-authored in linked threads, observations must belong
to that work, and actions must be current projected actions of that work. The
request record identifies the request only; it is not evidence of completion.
Generated summary/next-step text is explicitly model-authored and advisory. It cannot change work
phase or authorization revision. Stale checkpoints are visibly labeled and must
be reconsidered under current teachings. Current action state remains authoritative.
No model progress status can mark work done or retry an unknown effect.

## Owner intake before reasoning

Normal model-backed local CLI use enables continuity for v4 stores without a
feature flag. Existing library/service callers retain their explicit feature
configuration; v1-v3 normal CLI startup gives the maintenance command instead of
silently upgrading. `--task-teachings` remains a compatible alias.

One bounded owner-only intake completion decides keep/create/select/clarify and
proposes teaching changes. It sees the current raw owner input and up to eight
candidate tasks, limited to current focus and exact owner-named candidates;
unrelated task teachings are never included. Catalog
entries contain IDs, validated original owner goal quotes when available, and
that candidate's own active teachings/clarifications with exact owner sources.
Model-derived task titles/goals are never supplied as teaching evidence. Exact
title matching may locate candidates in application code, but adds no title text
to the extraction input. Creation has no prior teaching targets. For selection
of B while focused on A, B's owner sources and revisioned teaching IDs are supplied
under B; runtime validates every change/resolution exclusively against B. Missing
candidates or ambiguous exact names require clarification, never silent fallback
to A. The request remains bounded; mandatory source overflow stops safely. Intake
never receives browser observations, learned notes, assistant replies or tool transcripts. Creation/selection is tied
to an exact unique quote in the owner input. Ordinary questions need no new task.
No special “remember” wording is required for useful task constraints/preferences.

Runtime code supplies workspace, owner, thread, source ID, generated work IDs and
revision bindings. It validates proposals and atomically commits task/focus
changes, teachings and an intake receipt before rebuilding context and reasoning.
The receipt records the resolved work/thread and outcome even for a no-change
turn. Open teaching clarifications continue to block actions. Invalid extraction
stops the turn with a fixed application message; it cannot permit action with
possibly missed restrictions. Successful teaching updates continue the original
request in the same turn using the committed new revision.

The inbox stays pending until final reply settlement. A retry of that same owner
record reuses the receipt; it never repeats creation/correction or retargets after
focus changed. It uses current authoritative teachings, including newer corrections.
A completed delivery is rejected before inference as today. Failure after intake
may leave durable memory with no reply; report this boundary accurately. Cancellation
and service fences are checked after inference and inside the intake transaction.

Intake and reasoning share the existing eight-completion/120-second ceiling.
Retries are explicit, never autonomous retries of unknown external effects.

## Progress and context

A final response may include a bounded progress report for its focused work.
Application code binds provenance and work/progress revisions and commits the
checkpoint together with the assistant reply. Browser final reports remain
separate from owner teachings. Application-authored stops retain a compact stop
checkpoint when current bindings still allow settlement. No progress is committed
from late/stale model results or unconfirmed browser cleanup.

Focused context includes the task, exact active owner teachings, pending
clarifications, latest advisory checkpoint and any browser stop checkpoint. Browser
checkpoint recall uses historical observation IDs/reason, never executable refs,
session/document handles or current-availability claims. Resume always re-observes.
Mandatory state/current input remains budgeted and fails explicitly if it cannot fit.
`/work` reports the latest checkpoint and actual action states. No percentage is
invented from the model's self-report.

## Module boundaries

- `kernel/task-continuity.ts`: types, deterministic validation/reduction and source validation.
- `runtime/task-intake.ts`: bounded owner-only protocol and atomic intake orchestration.
- `runtime/task-continuity.ts`: trusted focus and progress preparation helpers.
- `memory/task-context.ts`: compact continuity and historical checkpoint rendering.
- `AgentService`: sequence intake, rebuild context, run existing loop, settle reply/progress.
- `SqliteStore`: projection upgrade and ordinary transaction/source validation only.
- CLI: restore/persist focus and display status through runtime helpers.

No provider-specific behavior enters the kernel. No hardcoded visa workflow,
vector service, autonomous scheduler, extra runtime agent, generic plugin engine,
credential ingestion or live portal behavior is added.

## Acceptance

1. A synthetic owner goal plus constraint creates/focuses work, saves the exact
   instruction and proceeds within the same turn without a second “go”.
2. Restart restores the task; “continue” uses corrected teachings and checkpoint.
3. Failure after intake followed by explicit retry creates no duplicate task,
   teaching or revision change. Changed focus cannot retarget the retry.
4. Ambiguous selection/correction stops visibly; external observations cannot
   become owner teachings or override current constraints.
5. Browser stop without final notes survives restart and prompts fresh observation.
6. Progress preserves existing approval revisions and cannot complete work or
   change unknown-effect retry rules; stale/cancelled commits are refused.
7. Workspace/owner/source scopes, request budgets, lock-wait deadlines, plaintext
   and encrypted upgrade/backup/rebuild, and read-only replay remain enforced.
8. Full `npm run verify`, real synthetic composed acceptance, independent Sol/high
   and Astra/high source approval, and exact-head hosted CI pass before merge.
