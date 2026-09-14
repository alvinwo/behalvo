# Local Agent MVP

This is the first dogfoodable version of Behalvo. It is intentionally small: a local terminal agent with durable memory/state, multiple model providers through the bundled Pi adapter, and inspection commands for seeing what the agent believes and why.

The model is **not** the state store. Every durable message, WorkItem, and Fact is written through the trusted application runtime and survives process restarts independently of provider sessions.

## What you can run now

### Offline smoke mode

This mode needs no API key or network connection:

```bash
npm ci
npm run agent -- --offline
```

Useful commands:

```text
/help
/model
/new [thread-id]
/work
/work <work-id>
/work clear
/actions
/approve <action-id> <full-digest>
/state
/history [limit]
/context
/quit
```

`--offline` automatically selects `offline/deterministic`. It exists to verify the local runtime and persistence path; it is not an intelligent assistant.

For a stronger restart test:

```bash
npm run mvp:demo
```

The demo creates a WorkItem and Fact, closes SQLite, reopens it in a fresh app instance, starts a different thread, and verifies that the second turn uses durable state without loading the previous thread's raw transcript. The original raw message remains retrievable from history.

## Use real models through Pi

Behalvo owns the agent runtime. Pi is only the replaceable model/provider transport layer.

The project requires Node.js **22.19+**. Pi 0.85.1 is a pinned normal dependency, so the ordinary install is sufficient:

```bash
npm ci
npm run agent
```

Inside the REPL, discover models:

```text
/model
```

### OpenAI Codex with a ChatGPT subscription

Current Pi releases expose `openai-codex` as an OAuth provider. Start the provider-owned login flow:

```text
/login openai-codex oauth
```

Follow the URL/device-code/manual-code instructions printed by the provider. After login, credentials are stored in:

```text
data/pi-auth.json
```

The file is outside the Journal, is git-ignored through `data/`, and is written with owner-only permissions on Unix-like systems. OAuth refresh updates use the same credential store.

Then list the models and select one of the model IDs Pi reports:

```text
/model
/model openai-codex <model-id>
```

A successful `/model` selection is saved for this database and workspace and restored on the next startup. The sidecar stores only the provider and model IDs; credentials remain in the separate Pi auth file. Use `--model provider/model`, `BEHALVO_MODEL`, or `OPERATOR_MODEL` to override the saved selection. The normal precedence is `--model`, `BEHALVO_MODEL`, `OPERATOR_MODEL`, then the saved selection. `--offline` ignores the saved selection and never replaces it.

You can also select a model at startup:

```bash
BEHALVO_MODEL=openai-codex/<model-id> npm run agent
```

A ChatGPT/Codex subscription is not a generic OpenAI Platform API key. This path intentionally uses Pi's provider-owned Codex OAuth flow rather than pretending the subscription is an API credential.

### Other providers

Because the gateway uses Pi's current built-in model collection, the same model boundary can expose other providers supported by Pi. Authentication method depends on the provider: OAuth, stored API key, or ambient environment credentials. Use `/model` to inspect the catalog and `/login <provider> <oauth|api_key>` for providers that expose an interactive login method.

The Behalvo kernel does not contain provider-specific memory or provider-specific domain state.

## Bounded synthetic operations

The terminal agent can discover registered operations, prepare a concrete command,
inspect it, execute an already approved action, and verify readback. Ordinary mode
has an empty operation catalog. Enable the shipped simulated account explicitly:

```bash
npm run agent -- --synthetic-operations
```

Select a model with `/model <provider> <model-id>` after login if needed. Then use
this sequence (the action ID and digest come from your own `/actions` output):

```text
Create a work item to update the synthetic account contact email.
/work
/work <work-id>
List the available operations, then prepare a contact update to new@example.test.
/actions
/approve <action-id> <full-digest>
Execute the approved action and verify its readback.
/actions
/quit
```

A single new work proposal becomes the current focus automatically; `/work` lets
you check or change it. If work has proposed/approved operations and the terminal's
current thread is not linked, `/work <id>` resumes an existing linked thread and
prints its ID. This preserves the prepared work revision across a fresh terminal
session; it does not weaken approval revision checks. Work without pending
operation approvals retains the normal thread-link behavior. New work must be
committed in a preceding owner turn.
Tools cannot choose a different workspace, owner, or focused work. The synthetic
catalog provides the `synthetic-account` connection, `contact-profile` and
`subscription` resources, exact argument fields, and synthetic examples. To try
cancellation, create/focus suitable work and ask to prepare `subscription.cancel`
with a synthetic reason; use the same separate review and approval sequence.

Preparation stops immediately with an application-authored approval request.
`/actions` displays the current focused work's action IDs, statuses, synthetic
label, full digest, exact account/subject/resource/argument bindings, precondition,
expected result, verification and approval expiry. Labels and command data are
JSON-escaped. `/approve` accepts exactly an action ID and full digest that
`/actions` displayed in this terminal session. Approval lasts ten minutes and does
not resume inference. Request execution in a new owner turn. A model reply,
`/state` output, or an earlier terminal's display is not a review receipt.

Each run permits at most eight model completion attempts and 120 seconds. It
accepts one strict tool request or one final reply/proposal envelope per
completion. Unknown tools/fields, malformed output, failed/unknown/running
execution, and unsuccessful verification stop the run with a durable application
reply. Acceptance alone is not verification or WorkItem completion. There is no
automatic retry or replacement action after a stopped run.

The entire serialized request (system, context and accumulated tool transcript)
is capped at the smaller of 196,608 UTF-8 bytes and the caller's remaining input
budget (`windowTokens - outputReserve`, 56,000 by default). Individual model
responses are limited to 65,536 bytes before parsing, tool arguments to 16,384,
and tool results to 32,768. History selection counts the exact serialized initial
request, including system/protocol overhead and JSON escaping, and trims whole old
messages while pinning the current owner input. It reserves up to 8,192 bytes (at
most one quarter of the cap) for tool continuation. Growing transcripts can still
reach the cap before eight completions; eight is a maximum, not a guaranteed run
length. These byte estimates are not an exact provider
tokenizer or a dollar-cost guarantee. `/context` shows the base memory context;
it excludes the added operation protocol, focused-work binding and disposable
tool transcript. For loop-enabled AgentService calls, the returned context's
`estimatedTokens` counts the complete initial serialized request used for selection,
while `context.text` remains the base context. Tool result strings remain untrusted
data.

The deadline reaches the operation service. Late identity/readback results cannot
prepare, dispatch, or verify an action. A dispatched attempt with no available
outcome by the deadline becomes `unknown`; a late result cannot overwrite it.
Underlying provider/model calls may continue when their transport does not
support cancellation. Timeout is not proof of nonexecution. Inference is never
automatically resumed after restart. An interrupted `running` action remains
blocked; startup does not claim exclusive ownership or perform recovery. The
trusted maintenance API requires all workers to have stopped before explicit
recovery; this increment adds no recovery CLI or daemon.

Synthetic mode defaults to `data/synthetic-agent.db`, regardless of ordinary
`BEHALVO_DB` or `OPERATOR_DB` values. `--db /path/new-synthetic.db` selects an
explicit database. A database records its ordinary/synthetic mode and cannot
silently switch; existing unbound ordinary databases cannot be imported into
synthetic mode. Each local app's AgentService and OperationService are bound to its startup workspace;
callers cannot route another workspace through that app's synthetic provider.
Matching connection generations survive restart and revoked
connections stay revoked. Simulated provider state and versions are stored in
`<database>.synthetic.sqlite`, scoped by workspace/provider/subject/resource,
independently of the domain journal. Missing or corrupt prior provider truth
fails closed instead of reseeding. Retain both databases for restart/readback;
replaying the journal never re-applies simulated effects.

`--offline --synthetic-operations` starts this isolated environment without model
network access, but the deterministic smoke model does not plan operations. The
scripted terminal tests exercise the complete workflow without a real model or
real account. All shipped operation effects remain synthetic: no account
credentials, browser, shell, payment, message, or real provider write is exposed.

Persistent synthetic operations cannot be combined with encrypted agent storage,
because their independent provider sidecar is plaintext. Startup rejects that
combination before either database is created.

## Local files

By default:

```text
data/agent.db       append-only Journal + rebuildable projections + raw artifacts
data/agent.db.settings.json   nonsecret provider/model selection by workspace
data/pi-auth.json   Pi provider credentials only
```

Override them with:

```bash
BEHALVO_DB=/path/agent.db \
BEHALVO_PI_AUTH=/path/pi-auth.json \
npm run agent
```

For a new opt-in encrypted database, first create a separate key and provide its
path on every start:

```bash
npm run storage -- keygen --out /private/path/agent.behalvo-key
npm run agent -- --db /private/data/agent.db \
  --storage-key-file /private/path/agent.behalvo-key
```

`BEHALVO_STORAGE_KEY_FILE` is the environment alternative; the command-line path
wins. Choose an unused database path for the first encrypted start. Existing
plaintext databases are not converted, and a missing configured
key fails before database creation. Backups require the dedicated verified
`npm run storage -- backup` and `restore` commands. Read the
[private storage guide](PRIVATE_STORAGE.md) before use; the key, Pi credentials,
model settings, and evaluation reports are separate recovery items.

Workspace and owner IDs are also configurable:

```bash
BEHALVO_WORKSPACE=personal BEHALVO_OWNER=owner npm run agent
```

The previous `OPERATOR_DB`, `OPERATOR_PI_AUTH`, `OPERATOR_WORKSPACE`, `OPERATOR_OWNER`, and `OPERATOR_MODEL` names remain supported. In ordinary mode, for database, auth, workspace, and owner values, selection order is: explicit CLI flag, matching `BEHALVO_*` variable, matching `OPERATOR_*` variable, then the existing default. Model selection adds the saved database/workspace selection after those explicit sources. Database paths, workspace/owner IDs, stored history and credential formats are unchanged; no data migration is needed. The existing exported `Operator` class also keeps its name for source compatibility.

Do not run two Behalvo processes against the same Pi auth file in this MVP. Credential refresh is serialized and atomically written within one process; cross-process file locking is not implemented yet.

## Memory behavior in this MVP

The current hierarchy is:

```text
raw Journal/history       immutable semantic history
projected State           current authoritative application view
WorkItems + Facts         structured durable memory
thread messages           persistent communication history
ContextBuilder            bounded temporary model view
provider session ID       cache hint only
```

A process restart is not a memory boundary. A new thread is not a memory boundary for explicitly linked WorkItems.

Facts record two different times. `observedAt` is the timestamp of the source record from which the application learned the fact. `validFrom` is the time the fact became true and remains `null` when that onset is unknown. New model-proposed validity timestamps are accepted only as `YYYY-MM-DDTHH:mm:ssZ` or `YYYY-MM-DDTHH:mm:ss.sssZ` and when the exact timestamp appears verbatim in the current owner input; natural-language dates are not silently converted or backdated. This stricter admission rule does not reinterpret older schema-v1 journal timestamps, including their previously accepted fractional forms. The trusted `Operator.recordFact` API continues to accept explicit validity timestamps, and schema-v1 facts replay with their original validity while deriving `observedAt` from their source record.

Raw history is retained even when it cannot fit into the model context. However, **automatic long-thread compaction and semantic retrieval are not implemented yet**. The current ContextBuilder loads a bounded recent raw tail plus source-bound summaries that already exist. The MVP relies primarily on structured WorkItems/Facts for cross-thread durable memory; automated summary generation and historical retrieval are the next memory milestone.

## Safety boundary

Model output is parsed as a strict final `AgentTurn` envelope or a disjoint,
allowlisted operation request. Final output may propose replies, new WorkItems,
and Facts; fact provenance is rebound to the actual owner message. Operation
tools use trusted workspace/owner/focused-work bindings and the existing
OperationService approval, attempt and uncertainty rules. The terminal provides
no model approval, connection-registration, reconciliation, shell or browser tool.

Credentials remain outside operation catalogs, prompts and domain state. Raw
provider/handler exceptions are not copied into application-authored stop replies.
The supported local runtime is a trusted API boundary, not a sandbox for untrusted
handler code. See [SECURITY.md](../SECURITY.md).

## What is not implemented yet

- email / email relay;
- WhatsApp, WeChat, SMS, or phone channels;
- browser automation;
- automatic memory consolidation / summarization;
- semantic/vector retrieval;
- real account operation handlers and protected operation credentials;
- a background 24/7 daemon;
- retention, erasure, and key rotation for encrypted payloads;
- hosted multi-user deployment.

Those are intentionally outside this MVP so the local state, memory, provider, and restart boundaries can be validated first.

## Verification boundary

The offline kernel, Pi adapter contract, credential-store behavior, OAuth prompt cancellation, CLI commands, cross-thread state, and restart behavior are covered by automated tests.

The original offline build could not install Pi. During the PR review on 2026-09-08, Node 24.19.0 successfully loaded the published `@earendil-works/pi-ai@0.85.1`, enumerated 1,354 models including Codex, and persisted synthetic API-key logins with network calls disabled. Concurrent first logins preserved both provider credentials.

The owner reported successful Codex login and chat after the earlier setup work. This increment verifies the bounded operation workflow with synthetic providers and scripted model responses; it does not claim a new live-model operation-loop test. See the [PR review report](reviews/2026-09-08-pr-1.md) for the earlier review evidence.
