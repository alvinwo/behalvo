# Semantic Browser Exploration Implementation Plan

Status: approved by delegated Astra/max architecture review after focused amendments
on 2026-10-09. No T1b code is implemented by this document.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. The primary agent remains the sole writer; the owner delegates technical review to specialists.

**Goal:** Let Behalvo explore synthetic websites from owner teachings and remember
source-grounded observations, without a route script or new effect authority.

**Architecture:** Introduce a separate semantic browser port and exploration-only
loop capability. Journal observations and advisory learned notes separately from
T1a owner teachings; adapter-private Playwright objects never reach model context.

**Tech Stack:** Existing TypeScript, SQLite, Pi and pinned Playwright. No new
service, provider or runtime agent.

**Spec:** [Teachable browser work](../specs/2026-10-09-teachable-browser-design.md),
T1b. T1a contracts are `TeachingMemory`, `prepareTeachingEvents`,
`extractTeachings`, `assertTeachingClear`, and `AgentService`'s trusted
`teachingMode` configuration. Read the spec and current implementations first.

## Global constraints

- Eight model completions and one absolute 120-second deadline, including T1a extraction.
- Synthetic fixtures only; no real URL option, credentials or persistent profile.
- No selectors, scripts, arbitrary URLs, raw HTML, secrets or Playwright objects in model tools.
- Exact current observation references; no model-authored outbound field values.
- Owner teachings and browser-derived notes have separate provenance and authority.
- All durable domain changes use journal events and deterministic, effect-free replay.
- Unknown interaction classification stops before dispatch; unknown side effects never retry.
- English normative documentation and existing English message-catalog conventions.

## Review focus

1. A harmless-looking GET or control can mutate state: fixture request policy must deny it before dispatch.
2. Page instructions can try to exfiltrate history: fills require exact trusted owner-input bindings.
3. Navigation can replace a control during an await: stale document/observation references must fail.
4. A restart can make notes obsolete: notes cannot supply current control references or proof of completion.
5. Legacy operation tools or facts can bypass capability separation: every alias and final proposal path must reject.

## Task 1: Observation and input contracts

**Files:** create `src/browser/semantic-types.ts`,
`src/browser/semantic-validation.ts`, `tests/semantic-browser-contract.test.mjs`.

**Interfaces:** `BrowserObservation` carries workspace/work/session/document and
observation IDs, exact origin, sanitized location, bounded visible text and controls.
Controls carry opaque refs, role, accessible name, allowed interaction shapes and
opaque option refs. `SemanticBrowserPort.observe(context)` and
`interact(context, command)` return a fresh observation. `command` is navigate/click
with an observed ref, fill with an observed ref and `taskInputId`, or select with
observed control/option refs. Trusted context supplies workspace/work/revision,
session generation and `OperationExecutionContext`; the model cannot supply it.
`TaskInputBinding` contains exact owner record/quote offsets, task/current work
revision, destination origin, fixture-policy field purpose and active/revoked
status. A trusted owner-control admission entry point authorizes that exact
binding through sourced journal events. Neither model nor page may create,
retarget, widen or reactivate it. The adapter derives purpose from the reviewed
request policy, never a page label or model argument; stale/revoked bindings
reject before any transmission.

- [ ] Write RED tests for strict keys, forged scope, secret/hidden controls, stale refs, non-verbatim/repeated input quotes and value disclosure to the wrong purpose/origin, unauthorized creation/retargeting, and stale/revoked bindings with canary values.
- [ ] Run `npm run build && node --test tests/semantic-browser-contract.test.mjs` and record the expected missing-contract failure.
- [ ] Implement strict schemas and bounds: model-facing observation at most 32,768 bytes serialized (the existing tool-result cap), 100 controls, 256-byte IDs, 2048-byte names and 4096-byte sourced input values. Reject overflow without silent truncation of controls/evidence.
- [ ] Run focused tests, inspect diff, commit the independently testable contract.

## Task 2: Synthetic semantic adapter and request boundary

**Files:** create `src/browser/semantic-playwright.ts`,
`src/browser/semantic-fixture-policy.ts`, `tests/semantic-browser-adapter.test.mjs`,
`tests/fixtures/semantic-sites.mjs`; reuse lifecycle controls from
`src/browser/playwright-owner.ts` and `src/browser/playwright-process-owner.ts`.

**Interfaces:** Implement `SemanticBrowserPort` against a disposable owned browser.
An application-selected fixture policy maps allowed request shapes to exploration
permission independently of page labels; it contains no route planner, preferred
candidate or owner-goal condition. Resolve refs only in private adapter state.
Reuse cancellation/cleanup and reject generation changes after every await.

- [ ] Write RED tests with three sites: two structurally different synthetic appointment directories and a non-visa class directory, with differing navigation/control structure.
- [ ] Add request-count assertions for mutating GET, redirects, popups, downloads, off-origin targets, unknown forms and unsupported channels; all must be blocked before dispatch. Test control replacement, stale observations, disabled controls and cancellation mid-navigation.
- [ ] Run the new adapter tests, observe RED, then implement bounded observation/interaction and trusted input resolution. Disable unreviewed channels rather than implying arbitrary JavaScript-site support.
- [ ] Verify permitted nonmutating filter/search requests preserve exact input bindings and return fresh refs; run focused lifecycle tests and commit.

## Task 3: Journaled observations and learned notes

**Files:** create `src/kernel/browser-learning.ts`,
`src/runtime/browser-learning.ts`, `tests/browser-learning.test.mjs`; modify
`src/kernel/types.ts`, `src/kernel/reducer.ts`, `src/storage/sqlite-store.ts`,
`src/storage/sqlite-validation.ts`, `src/storage/sqlite-codec.ts`,
`src/cli/storage-main.ts`, `src/memory/context.ts`.

**Interfaces:** `browser.observed` references bounded immutable observation artifacts
with trusted work/origin/session identity. `browser.note_recorded` carries a runtime
ID, exact observation source IDs, advisory text, task and origin. Notes may be
retired with a sourced event; they never update `TeachingMemory`, create approval,
or supply current browser refs. `prepareBrowserLearningEvents(store,binding,proposal)`
validates all cited observations and prepares a batch without writing.
Add projection v3 with an explicit validated v2-to-v3 maintenance command. Preserve
v1/v2 read/write/rebuild and backup compatibility; no silent shape upgrade.

- [ ] Write RED tests for fabricated/cross-task/cross-origin citations, old observations presented as current evidence, note retirement, source overflow and atomic batch failure.
- [ ] Add encrypted v2 upgrade/backup/restore, wrong-key/corrupt-source rollback and effect-free replay tests; run and record RED.
- [ ] Implement journal/reducer/storage validation and context sections that distinguish owner teachings, observations and advisory notes. Select optional note-and-source groups only from the remaining context budget; pin evidence for selected notes, not every accumulated note. Fail rather than dropping mandatory owner sources.
- [ ] Prove browser-derived instructions and legacy facts cannot become teachings; run focused storage/context tests and commit.

## Task 4: Exploration-only runtime

**Files:** create `src/runtime/browser-exploration.ts`,
`tests/browser-exploration-loop.test.mjs`; modify `src/runtime/agent-service.ts`,
`src/runtime/operation-loop.ts`, `src/cli/local-app.ts`, `src/cli/main.ts`.

**Interfaces:** Trusted application configuration selects exploration capability and
supplies the semantic port and reviewed fixture policy. After T1a `none` with no
hold, offer only observe/navigate/click/fill/select and a strict final result with
reply plus observation-grounded note proposals. Loading a persisted note also
activates the trusted mixed-context capability, even on a turn without a browser;
ordinary legacy mode must not load notes then accept legacy facts. Reject
work/fact/effect proposals
and all legacy operation aliases. Use the seven remaining completions and original
deadline; no extra model call for checkpointing. Recheck each complete next request,
including teachings and transcripts, against the existing serialized request
budget. Learning and reply settle atomically.

- [ ] Write RED tests for every forbidden alias/proposal, teaching clarification holds, unlinked work, stale revisions, eight-call cap, deadline/cancellation during interaction and settlement, duplicate delivery, learned-note-only legacy-fact laundering, accumulated optional-note budget selection and ungrounded final notes.
- [ ] Run and observe RED; implement capability selection and strict tool/result dispatch without goal-specific routes or answer selection.
- [ ] At budget stop, store an application-authored checkpoint of existing source IDs only; next turn needs fresh browser observations. Restart performs no interaction.
- [ ] Run focused integration tests and legacy operation-loop tests, then commit.

## Task 5: Combined teaching and exploration acceptance

**Files:** create `tests/teachable-browser-acceptance.test.mjs` and
`docs/verification/2026-10-09-semantic-browser-exploration.md`; update README status,
local MVP guide, roadmap and RESUME.

- [ ] Prove teach → explore → compare → learn → restart → recall → correct → re-explore on both structurally different appointment fixtures and the non-visa fixture, with the same runtime and no source changes, varying layouts/values between runs and recording actual tool calls.
- [ ] Prove a page's malicious instructions never change owner memory, disclose unrelated context, execute effects or provide approval; stale notes cannot prove completion.
- [ ] Run bounded live-model acceptance with configured provider, synthetic data and a clean source head; retain model calls, artifacts, failures and natural process exit. Keep protocol success separate from owner usefulness.
- [ ] Run `npm run verify`, obtain Sol/high and Astra/high independent review, fix findings and require exact-head CI before authorized merge.
- [ ] Document T1 combined acceptance only if both memory and real model-driven fixture exploration pass. Keep real website access, authenticated session custody and booking explicitly gated for T2/T3.
