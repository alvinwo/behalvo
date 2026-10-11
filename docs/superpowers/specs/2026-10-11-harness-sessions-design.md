# Harness sessions and scoped recall

Status: approved by delegated Astra/max architecture review, 2026-10-11.

## Goal

An owner can move between chats and durable tasks, resume after restart, inspect
stored memory, and let the agent recall relevant earlier messages without mixing
unrelated tasks. This builds on the approved continuity architecture; it does not
create another task or goal hierarchy.

## Model and source lessons

Workspace remains the local owner/audience boundary. Thread is a chat session;
WorkItem is durable work, with `goal` as its objective and `phase` as authoritative
lifecycle. A run is a disposable bounded inference. Browser sessions are temporary
capabilities, separately scoped to the active work and chat.

[OpenClaw sessions](https://docs.openclaw.ai/concepts/session) and
[Hermes sessions](https://hermes-agent.nousresearch.com/docs/user-guide/sessions)
demonstrate useful session discovery, resumption and separation between saved
history and model context. Behalvo adopts these behaviors using its existing
journal, rather than introducing a second conversation database.

[OpenClaw memory](https://docs.openclaw.ai/concepts/memory-architecture) separates
instructions, curated memory, episodes and prospective work with provenance.
[Hermes memory](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory)
uses bounded durable memory plus explicit history search. Behalvo keeps exact owner
teachings, scoped facts, advisory progress and untrusted browser notes distinct.
Recall never promotes a message or summary into authority. No vector service,
background consolidation, new runtime agents or automatic effect retry is added.

## Sessions

Derive sessions from workspace journal messages and existing task focus records.
No new mutable Session entity or database migration. Owner-only `/sessions` lists
thread ID, last message time, bounded last owner preview and active focused work.
`/resume <thread-id>` requires an existing session and restores its active focus.
`/new [thread-id]` creates a new session; an existing ID is rejected with guidance
to resume, and never clears existing focus. Repeated resume does not change work
revision or clear progress/teachings. Startup continues restoring localThreadId.

`/history [limit]` displays the current thread's messages; `/journal [limit]`
retains the former diagnostic event listing. `/memory` displays owner/work facts,
active task teachings, open clarifications, progress and browser notes with their
provenance and advisory labels. It never displays vault contents. These commands
are owner surfaces, not tools allowing the model to select arbitrary identities.

## Context and recall scope

For continuity-enabled contexts, historical owner messages are attributed using
`taskContinuity.intakes[record.id].workId`. Agent replies inherit attribution only
through their journal `causationId` pointing to that owner input. Unclassified
legacy/external messages remain readable by the owner in history but are excluded
from automatic focused context and model recall. The explicitly supplied current
owner input is always pinned, including intake clarification. Unfocused contexts
admit only receipts with null work. Pre-continuity stores retain their legacy
behavior until upgraded. A trusted `historyMode: legacy_thread` compatibility
request is also used by AgentService when task continuity is disabled, retaining
the earlier external-source evaluation contract. Default context, recall, and the
normal continuity-enabled CLI are strict; no public/model option selects legacy.

Focused context admits only the selected task's attributed messages in this
thread. A summary is eligible only when all its sources pass this same test.
Teaching context carries exact `sourceQuote` and offsets, not the full unrelated
contents of the source message. Existing source validation remains mandatory.

`recall` arguments are exactly `{query, scope, limit, beforeSeq}`. Query is a
literal case-insensitive substring (1–256 UTF-8 bytes), scope is `thread` or
`work`, limit is 1–20, beforeSeq is null or a positive safe integer. Binding is
application-owned workspace/owner/thread/optional work and audience owner.
Thread recall searches eligible messages in the current thread; work recall
searches only messages attributed to the focused task across its linked threads.
The model cannot supply workspace, owner or arbitrary thread/work IDs. Results
are newest first, each carrying record ID, thread, sequence, role, timestamp and
a bounded matching excerpt. Total result budget is 16 KiB, nextBeforeSeq enables
pagination. No match, absent work, foreign audience, invalid arguments and stale
work are explicit bounded outcomes/errors, never global fallback searches.

The owner CLI `/recall <query>` uses focused work when present, otherwise thread.
The same read-only tool is available in continuity reasoning, operation reasoning
and browser reasoning, sharing the existing eight-completion/deadline budget.
Browser notes alone no longer force a browser tool loop; capability configuration
determines availability. All retrieved text remains untrusted source material.

One process-local guard rejects overlapping direct owner turns for the same
workspace/thread before ingestion. Existing service admission/fencing stays in
charge of hosted jobs. No global mutex blocking independent chats is introduced.

## Acceptance and compatibility

- Task A → B in one chat excludes A messages and mixed summaries; returning to A
  restores exact teachings/progress, including after restart.
- Work recall finds A in another linked thread, never B or another workspace;
  pagination, Unicode, bounded output and empty results are covered.
- Legacy unclassified history remains inspectable but is not silently promoted.
- New/resume semantics preserve pending operation revisions and existing focus.
- Same-thread overlap fails before a second input is ingested; independent threads
  remain usable. Replay/rebuild does not execute recall, browser work or effects.
- Recall cannot mutate facts, progress, work phase or approvals. Model final claims
  continue to require application validation and do not complete work.
- Node >=22.19.0; TypeScript and existing SQLite journal only; synthetic test data.
- New user-facing text uses the existing English message-catalog pattern.
- Run focused behavior tests, full POSIX `npm run verify`, and independent Sol high
  plus Astra high review before authorized integration.
