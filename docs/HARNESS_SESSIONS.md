# Sessions, tasks and memory

Behalvo separates a chat, a task and a model run. A chat is a durable Thread;
a task is a WorkItem with its own goal, revision and phase; a Run is a bounded
attempt to make progress. A new run does not reset the task. A browser session
is temporary process-owned state bound to one workspace, owner, chat and task.

| Command | Meaning |
| --- | --- |
| `/sessions` | List saved chats, current task and recent owner preview. |
| `/new [name]` | Start a new chat without a focused task; existing names reject. |
| `/resume <chat-id>` | Return to a saved chat and its durable focus. |
| `/work` | Inspect durable goals, phase and advisory progress. |
| `/work <id>` | Explicitly focus/link an existing task. |
| `/history [limit]` | Read this chat's messages. |
| `/journal [limit]` | Inspect workspace event metadata. |
| `/memory` | Inspect scoped facts, teachings, clarifications, progress and browser notes. |
| `/recall <literal text>` | Search source messages for the focused task, or current chat without a task. |

Ordinary owner instructions drive intake: the model proposes a task, updates
source-quoted teachings, or asks a clarification. The application validates and
journals the proposal. Owners need not prefix every preference with “remember”.
Corrections supersede prior teachings; ambiguity creates a hold. Completion and
action approval remain explicit owner-controlled state.

Task history is selected through owner-intake receipts and assistant-message
causation. A chat discussing several tasks does not supply all its history to
every task. Unattributed legacy messages are excluded from automatic task context;
`/history` remains available for explicit inspection. Current owner input is
always supplied. Teachings include their validated exact quote, not unrelated
text from the same original message.

The model can use read-only `recall` in reasoning, operation and browser loops.
It searches the bound task's linked chats, or the current chat for a thread-scoped
query. Results include source IDs, roles, sequence numbers, timestamps and
excerpts around literal matches. Pagination, result count and serialized size
are bounded. Recall shares the deadline and eight-call model budget; it does not
extend a run or grant effect capability.

Facts and exact owner teachings differ from advisory progress and browser notes.
Summaries cannot grant permission, establish current website availability or prove
completion. Historical browser references cannot execute. Vault contents never
enter retrieval. Normal CLI turns reject overlap within one chat; separate chats
may progress independently. This guard belongs to the AgentService instance; the
local CLI has one instance and owns its database process lock.

## Lessons used from other harnesses

OpenClaw's [session model](https://docs.openclaw.ai/concepts/session) and
[memory architecture](https://docs.openclaw.ai/concepts/memory-architecture)
support separating conversation identity, selected context, durable memory and
pending work. We retain Behalvo's journal entities instead of adding a competing
goal/session database.

Hermes documents [saved sessions and resumption](https://hermes-agent.nousresearch.com/docs/user-guide/sessions)
and [bounded memory plus history search](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory).
Behalvo adopts explicit resumption, memory inspection and on-demand recall, while
retaining source attribution and task scoping. Model summaries are not owner policy.

[OpenClaw browser](https://docs.openclaw.ai/tools/browser) and
[Hermes browser](https://hermes-agent.nousresearch.com/docs/user-guide/features/browser)
inform our retained isolated window, fresh page references and manual handoff.
Behalvo's [managed browser](PLAYWRIGHT_BROWSER.md#managed-live-browser) uses visible
managed Chromium, exact-origin network grants and per-gesture review. It does not
expose arbitrary CDP attachment, page scripts, selectors, personal profiles or
cloud browser credentials. Sources reviewed 2026-10-11; these are design lessons,
not copied implementation or equivalent trust-model claims.
