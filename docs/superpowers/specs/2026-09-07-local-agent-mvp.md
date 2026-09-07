# Local Agent MVP Design

## Goal

Turn the verified journal-backed kernel into a locally dogfoodable personal agent without changing the kernel's ownership model. The user must be able to run one command, talk to a real model through a provider abstraction, quit, restart, and have the agent reconstruct useful context from durable state rather than a provider-owned session.

## Scope

The MVP provides:

- a local terminal REPL;
- one durable personal workspace and multiple persistent communication threads;
- provider-neutral model selection;
- a Pi-backed model gateway boundary, loaded optionally so the core does not depend on Pi runtime semantics;
- a deterministic in-process model for tests and offline demo;
- durable owner and assistant messages;
- structured model output that may propose WorkItems and Facts, but may not mutate the database or perform external effects directly;
- commands to inspect model, work, state, history, context, and start a new thread;
- restart persistence verified against a real SQLite file;
- no email, WhatsApp, phone, browser automation, or autonomous external side effects in this MVP.

## Architecture

The existing kernel remains authoritative:

```
Owner input
  -> durable message ingest
  -> ContextBuilder
  -> ModelGateway
  -> AgentTurn validation
  -> trusted AgentService applies allowed proposals
  -> durable assistant message
  -> Journal / projections
```

Provider libraries are transport only. They never own state, memory, permissions, WorkItems, or effect execution.

## Model boundary

`ModelGateway` exposes model discovery and one completion operation. `AgentTurn` is provider-independent and contains:

- `reply`: assistant text;
- zero or more `workProposals`;
- zero or more `factProposals`.

MVP model output cannot directly emit external commands. External effects remain behind the existing Command -> Policy -> Approval -> Effect path and are deferred to the next milestone.

## Pi integration

Use `@earendil-works/pi-ai`, not the deprecated `@mariozechner/pi-ai` package. The Pi integration is isolated behind `PiModelGateway` and loaded dynamically. The repository must still build and run offline tests when Pi is not installed.

The local setup guide documents that current Pi releases support OpenAI Codex OAuth backed by a ChatGPT subscription. Authentication is performed by Pi's own CLI/provider auth flow and stored outside the journal. Credentials must never be copied into agent state, prompts, Journal records, or artifacts.

Because this execution environment has no outbound npm/network access, the live Pi/OAuth path is an integration boundary: it is contract-tested with an injected fake Pi runtime here, while the release checklist includes a user-machine smoke test with a real Pi install and Codex login.

## Persistence and session semantics

- A CLI invocation is not a memory boundary.
- A CLI thread is a persistent `Thread` represented by message `threadId` values.
- Every user and assistant message is durably ingested before it can be relied on later.
- New threads can load the same WorkItem/state without loading old raw transcripts wholesale.
- Provider session IDs are optional cache hints only and are never authoritative memory.

## Context

For each owner turn:

1. ingest owner raw message;
2. resolve selected thread and optional active WorkItem;
3. build bounded context from pinned policy, current state, current WorkItem, summaries, and recent raw messages;
4. append a final explicit instruction asking the model to return the AgentTurn JSON envelope;
5. call ModelGateway;
6. validate the returned envelope strictly;
7. apply valid WorkItem/Fact proposals through trusted application services;
8. ingest the assistant reply as raw history.

If context cannot fit pinned state and current input, the turn fails closed and no model call is made.

## Structured proposal safety

Work proposals may only create a WorkItem linked to the current thread. Fact proposals must include a subject, predicate, value, and validity start. Their `sourceRecordId` is always overwritten by the trusted runtime with the current owner message record, so a model cannot forge provenance.

Existing records are not silently overwritten. ID collisions fail closed.

## CLI

Primary command:

```bash
npm run agent
```

MVP slash commands:

- `/help`
- `/model` and `/model <provider> <model>`
- `/new` and `/new <thread-id>`
- `/work`
- `/state`
- `/history [limit]`
- `/context`
- `/quit`

The database defaults to `./data/agent.db`. Workspace/owner IDs default to `personal` and `owner` and are configurable by environment variables.

## Acceptance boundaries

### Boundary A: provider-independent model contract

A fake gateway can list/select models and produce a validated AgentTurn. Invalid/malformed output is rejected before state changes.

### Boundary B: durable conversation

A user turn and assistant reply are raw records in SQLite. After process/store restart, a new turn can recover the current WorkItem and durable facts without relying on an old provider session.

### Boundary C: cross-thread memory

A WorkItem created in thread A can be explicitly linked/selected from thread B, and ContextBuilder loads current state without replaying thread A wholesale.

### Boundary D: model isolation

The model cannot forge fact provenance, directly mutate the store, or bypass effect approval. Model output has no external-effect field in this milestone.

### Boundary E: Pi adapter contract

With an injected Pi-like runtime, the gateway lists providers/models, selects one, transforms ContextPacket to a model request, and returns plain text/structured JSON without leaking provider-owned state into domain state.

### Boundary F: local UX

A scripted REPL test can run `/model`, send a message, inspect `/work` or `/state`, start `/new`, and quit. A separate offline demo proves quit/restart persistence using a real SQLite file.

## Non-goals

- automatic memory summarization;
- semantic/vector retrieval;
- multi-agent orchestration;
- real channel adapters;
- external side effects initiated by model output;
- hosted service deployment;
- credential storage inside the operator database.

