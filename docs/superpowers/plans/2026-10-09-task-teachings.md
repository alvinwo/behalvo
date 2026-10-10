# Task Teachings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. The primary agent is the sole writer; technical review is delegated under the owner's existing instructions.

**Goal:** Let the owner teach, correct, recall and retract work-scoped instructions
through ordinary conversation, with durable exact sources and no new effect authority.

**Architecture:** Add journal-backed teachings with an owner-only extraction phase.
Keep advisory interpretation separate from source text and derive every identity
in trusted runtime code. Share the existing inference budget and preserve the
operation service as the effect boundary.

**Tech Stack:** TypeScript, Node.js 22.19+, existing SQLite and Pi integration. No
new dependencies or runtime agents.

**Spec:** [Teachable browser work](../specs/2026-10-09-teachable-browser-design.md),
T1a only. T1b browser tools, learned notes and combined browser acceptance require
their own plan; none are declared operational by this increment.

## Global constraints

- Eight total model completions and one absolute 120-second deadline per turn.
- Exact current-owner source binding; interpretations do not create authority.
- Focused work and explicitly linked threads; owner-only, workspace-scoped access.
- Journal events and deterministic reduction; maintenance replay has no effects.
- Every teaching change advances work revision and invalidates stale approvals.
- Opt-in capability selected by the application; legacy callers remain compatible.
- Synthetic test data only. No real website/account access or new dependencies.
- Normative documentation in English; read the app-i18n skill before UI copy work.

## Review focus

1. Repeated quotes and Unicode: refuse ambiguous matching; preserve exact source.
2. Corrections racing another turn: reject stale teaching/work revision atomically.
3. Teaching extraction succeeds but later inference fails: durable changes and
   acknowledgments must have a defined transaction boundary, never silent partial success.
4. Reopening old encrypted databases: explicit upgrade validates journal and key
   before writes; failed upgrade preserves the old projection.
5. Apparent memory requests inside quotations: preserve the complete owner source
   context and treat interpretation as advisory, never an executable permission.

## Task 1: Journaled teaching model and source validation

**Files:** create `src/kernel/teachings.ts`, `src/runtime/teachings.ts`,
`tests/task-teachings.test.mjs`; modify `src/kernel/types.ts`,
`src/kernel/reducer.ts`, `src/storage/sqlite-store.ts`.

**Interfaces:** `OwnerTeaching` has `id`, `workId`, `revision`, `sourceRecordId`,
`sourceQuote`, `sourceStart`, `sourceEnd`, `interpretation`, `status`
(`active | superseded | retracted`), and optional `supersedes`.
Offsets are JavaScript UTF-16 string indices computed by the runtime. Persist
the complete immutable owner message separately as today; the quote never loses
its reference to that containing context.

`TeachingChange` is `add {sourceQuote, interpretation}`,
`replace {teachingId, expectedRevision, sourceQuote, interpretation}`, or
`retract {teachingId, expectedRevision, sourceQuote}`. It contains no source,
workspace, work, owner, thread, timestamp or generated teaching IDs.

`prepareTeachingEvents(store, binding, changes): DomainEvent[]` validates without
writing; `binding` supplies workspace, owner, work, current owner record and
expected work revision. IDs are runtime-generated. Each change records its exact
current source. The reducer validates lifecycle, scope and revision, advances
work revision once per change, and keeps supersession/retraction provenance.
The store checks owner-message/artifact source integrity on append and verified
replay. Validation happens for the whole change batch before any commit.

- [ ] Write tests for add/replace/retract and conflicting active instructions;
  unchanged original artifacts; stale expected revision; wrong owner/work/thread;
  unknown, repeated, empty and non-verbatim quote; emoji source offsets; forged
  source; duplicate changes targeting one teaching; and no partial batch append.
- [ ] Run `npm run build && node --test tests/task-teachings.test.mjs`; observe
  the missing feature failing before implementing it.
- [ ] Implement strict parsers: at most 8 changes per extraction, source quote
  at most 4096 UTF-8 bytes, interpretation at most 2048 bytes. Reject unknown
  fields, duplicate target changes, unsupported lifecycle and invalid sources.
- [ ] Assert teaching changes invalidate an already approved operation through
  the existing work-revision check; no action approval or execution is added.
- [ ] Run the focused tests and existing reducer/operation tests, then commit.

## Task 2: Explicit projection v2 maintenance upgrade

**Files:** modify `src/storage/sqlite-codec.ts`, `src/storage/sqlite-store.ts`,
`src/storage/sqlite-validation.ts`, `src/cli/storage-main.ts`; create
`tests/teaching-projection-upgrade.test.mjs`.

**Interfaces:** separate journal schema version 1 from projection version 2.
New stores use v2. `upgradeTeachingProjection(workspaceId): void` is an explicit
maintenance API, reached under the existing exclusive process lock by a storage
CLI command. Ordinary v1 reads remain supported without mutation; teaching mode
refuses a v1 projection with an actionable upgrade instruction. V2 adds the
teaching map; v1 cannot contain teaching events. Unknown versions reject.

- [ ] Add old-journal fixtures and tests for normal legacy reads, explicit
  upgrade, deterministic rebuild, repeated upgrade, unsupported version, unknown
  events, corrupt source, wrong encryption key and transaction rollback.
- [ ] Observe RED with `npm run build && node --test tests/teaching-projection-upgrade.test.mjs`.
- [ ] Implement rebuild from validated journal in one transaction, retaining
  the original journal/artifacts and correctly resealing projection v2 associated
  data. Never normalize an old persisted shape and silently write it as v2.
- [ ] Extend encrypted backup/restore verification to accept and compare both
  supported projection versions using their versioned deterministic shape.
  Verify upgrade does not execute a model, browser, effect driver or timer.
- [ ] Run focused storage, encrypted-backup and teaching tests, then commit.

## Task 3: Owner-only extraction and shared execution budget

**Files:** create `src/runtime/teaching-extractor.ts`,
`tests/teaching-extractor.test.mjs`; modify `src/runtime/agent-service.ts`,
`src/runtime/operation-loop.ts`, and add budget tests to
`tests/operation-loop.test.mjs`.

**Interfaces:** `extractTeachings(gateway, model, input, execution):
Promise<TeachingChange[]>` accepts current raw owner text and active teaching
source records/IDs/revisions only. Its model output is exactly `{changes: [...]}`.
`execution` owns the original absolute deadline, cancellation and shared remaining
completion count. No syntax-recovery allowance can expand the eight-call total.
The extractor uses one completion and rejects malformed output; it does not retry.

Expose teaching mode only as trusted `AgentService` configuration. For focused
owner turns in that mode, extract before assembling ordinary context. No focused
work means no extraction and no implicit assignment to another work item.

- [ ] Test the serialized extraction input contains no legacy facts, assistant
  messages, history, goal paraphrases, browser observations or learned notes.
  Malicious model output with forged bindings or invalid quotes must reject.
- [ ] Test one extraction plus at most seven later completions, one absolute
  deadline, cancellation before/after extraction, and oversized inputs/outputs.
  Observe RED before implementation.
- [ ] Validate the complete teaching batch before commit. A nonempty batch ends
  the turn with an application-authored memory acknowledgment and no operation
  tools; commit changes, acknowledgment and inbox completion atomically. Empty
  batches continue through the normal loop with the remaining budget. This keeps
  instruction changes separate from action dispatch and prevents stale approval
  use in the same turn.
- [ ] Ensure duplicate owner delivery cannot extract or append the same changes
  again. A failed extraction leaves teachings unchanged and records only the
  existing bounded application failure reply; raw provider errors are excluded.
- [ ] Test active-source-only correction, quoted misleading text, stale-turn
  fencing and admission through the service queue, then commit the passing slice.

## Task 4: Scoped recall and ordinary chat entry point

**Files:** modify `src/memory/context.ts`, `src/cli/local-app.ts`,
`src/cli/main.ts`, `src/cli/repl.ts`; create `tests/teaching-context.test.mjs`
and `tests/teaching-repl.test.mjs`.

**Interfaces:** trusted `teachingMode: boolean` configuration flows from explicit
`--task-teachings` CLI opt-in to `AgentService`. Do not accept the flag from model
output. Existing `/work` focus/linking remains the scope selection mechanism.
`buildContext` includes exact active teaching quotes, complete containing source
messages, IDs/revisions and separately labeled advisory interpretations for the
focused work. Superseded/retracted entries are history, not active instructions.

- [ ] Test ordinary teaching/correction/recall/retraction input, restart, linked
  thread recall, unlinked thread rejection, other workspace exclusion and legacy
  CLI behavior with the flag absent. Observe RED.
- [ ] Pin active exact sources in bounded context; deduplicate source messages.
  Never silently truncate or omit a mandatory teaching. Overflow fails with a
  fixed message. Surface unresolved competing teachings without picking a winner.
- [ ] Keep remembered instructions separate from `APPLICATION CONSTRAINTS`;
  they cannot grant execution authority. Ensure model replies cannot claim a
  successful memory change that runtime validation rejected.
- [ ] Add end-to-end scripted REPL tests with ordinary language and no required
  `/remember` command. Provide clear fixed acknowledgment of changes and recall
  guidance. Run related context/CLI/agent tests and commit.

## Task 5: Acceptance, documentation and independent review

**Files:** update `README.md`, `docs/local-mvp.md`, `docs/ROADMAP.md`,
`RESUME.md`; create `docs/verification/2026-10-09-task-teachings.md` and
`tests/task-teachings-acceptance.test.mjs`.

- [ ] Prove teach → restart → recall → correct → stale approval rejected →
  retract → restart → no active obsolete instruction, with deterministic
  journal/rebuild equality and exact source checks. Include oversized mandatory
  memory and conflicting constraints.
- [ ] Run bounded live-model synthetic acceptance using the already configured
  model (no credential inspection). Use synthetic task instructions and keep
  actual source head, model-call count, failures and process exit evidence.
  Automatic protocol success is not owner usefulness approval.
- [ ] Update the status table only for the implemented T1a memory capability.
  Explicitly retain T1b exploration, learned website notes, live access and
  booking as unimplemented. Include upgrade, limits and opt-in instructions.
- [ ] Run `npm run verify` on the final tree; inspect its actual summary.
  Obtain independent Sol/high and Astra/high code review, address findings,
  and publish/merge only after exact-head CI under existing owner authorization.
- [ ] Prepare a separate T1b plan against the implemented T1a contracts; its
  shared acceptance must prove model-driven exploration without route scripts.
