# Local Agent MVP

This is the first dogfoodable version of Behalvo. It is intentionally small: a local terminal agent with durable memory/state, multiple model providers through an optional Pi adapter, and inspection commands for seeing what the agent believes and why.

The model is **not** the state store. Every durable message, WorkItem, and Fact is written through the trusted application runtime and survives process restarts independently of provider sessions.

## What you can run now

### Offline smoke mode

This mode needs no model package, API key, or network connection:

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

The core project supports Node.js 22.16+, but current `@earendil-works/pi-ai` releases require **Node.js 22.19+**. Use Node 22.19 or newer when enabling Pi.

Install Pi locally without making it a required dependency of the kernel:

```bash
npm install --no-save @earendil-works/pi-ai
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

You can also select a model at startup:

```bash
BEHALVO_MODEL=openai-codex/<model-id> npm run agent
```

A ChatGPT/Codex subscription is not a generic OpenAI Platform API key. This path intentionally uses Pi's provider-owned Codex OAuth flow rather than pretending the subscription is an API credential.

### Other providers

Because the gateway uses Pi's current built-in model collection, the same model boundary can expose other providers supported by Pi. Authentication method depends on the provider: OAuth, stored API key, or ambient environment credentials. Use `/model` to inspect the catalog and `/login <provider> <oauth|api_key>` for providers that expose an interactive login method.

The Behalvo kernel does not contain provider-specific memory or provider-specific domain state.

## Local files

By default:

```text
data/agent.db       append-only Journal + rebuildable projections + raw artifacts
data/pi-auth.json   Pi provider credentials only
```

Override them with:

```bash
BEHALVO_DB=/path/agent.db \
BEHALVO_PI_AUTH=/path/pi-auth.json \
npm run agent
```

Workspace and owner IDs are also configurable:

```bash
BEHALVO_WORKSPACE=personal BEHALVO_OWNER=owner npm run agent
```

The previous `OPERATOR_DB`, `OPERATOR_PI_AUTH`, `OPERATOR_WORKSPACE`, `OPERATOR_OWNER`, and `OPERATOR_MODEL` names remain supported. Selection order is: explicit CLI flag, matching `BEHALVO_*` variable, matching `OPERATOR_*` variable, then the existing default. Database paths, workspace/owner IDs, stored history and credential formats are unchanged; no data migration is needed. The existing exported `Operator` class also keeps its name for source compatibility.

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

Raw history is retained even when it cannot fit into the model context. However, **automatic long-thread compaction and semantic retrieval are not implemented yet**. The current ContextBuilder loads a bounded recent raw tail plus source-bound summaries that already exist. The MVP relies primarily on structured WorkItems/Facts for cross-thread durable memory; automated summary generation and historical retrieval are the next memory milestone.

## Safety boundary

Real model output is parsed as a strict `AgentTurn` envelope. In this milestone it may propose only:

- a reply;
- new WorkItems;
- new Facts.

It cannot emit or execute external commands. Fact provenance is rebound by the trusted runtime to the actual owner message record. Provider credentials never enter prompts, Journal records, WorkItems, Facts, or message artifacts.

Existing external-effect machinery still requires deterministic policy and owner approval, but real model-initiated effects are deliberately deferred until the next milestone.

## What is not implemented yet

- email / email relay;
- WhatsApp, WeChat, SMS, or phone channels;
- browser automation;
- automatic memory consolidation / summarization;
- semantic/vector retrieval;
- model-generated external commands;
- a background 24/7 daemon;
- encrypted message artifacts;
- hosted multi-user deployment.

Those are intentionally outside this MVP so the local state, memory, provider, and restart boundaries can be validated first.

## Verification boundary

The offline kernel, Pi adapter contract, credential-store behavior, OAuth prompt cancellation, CLI commands, cross-thread state, and restart behavior are covered by automated tests.

The original offline build could not install Pi. During the PR review on 2026-09-08, Node 24.19.0 successfully loaded the published `@earendil-works/pi-ai@0.85.1`, enumerated 1,354 models including Codex, and persisted synthetic API-key logins with network calls disabled. Concurrent first logins preserved both provider credentials.

Live provider OAuth and model inference have not been exercised. See the [PR review report](reviews/2026-09-08-pr-1.md) for current verification evidence.
