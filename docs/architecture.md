# Behalvo — Architecture v0 Overview

> **Canonical language:** English. The [Chinese companion](architecture.zh-CN.md) is provided for convenience; when wording differs, the English specification is authoritative.

This document is a concise guide to the M0 kernel that already exists in code and tests. It is not a production assistant connected to personal accounts. The project name is **Behalvo** (`behalvo`). The detailed, normative design is in [`superpowers/specs/2026-09-07-architecture-v0.md`](superpowers/specs/2026-09-07-architecture-v0.md).

## 1. What M0 establishes

M0 intentionally uses **one process, one append-oriented journal, rebuildable state projections, and a small set of ports**.

There is no distributed event bus, workflow cluster, vector service, or society of agents. `kernel` owns deterministic domain rules; `storage` owns SQLite transactions; `runtime` validates and executes durable operations; `memory` assembles bounded inference context.

Personal and business use cases share the same implementation without automatically sharing visibility. A person may have separate `personal` and `business` workspaces. The workspace is the primary state and policy boundary; a chat session is not.

## 2. Journal, state, and actions

Each `JournalRecord` has a stable ID, workspace-local sequence number, schema version, recorded timestamp, actor, optional causation reference, and a typed domain event. Ordering is defined by the journal sequence, not by unreliable network timestamps.

A write transaction validates the expected state revision, validates the record, appends it, and updates the projection atomically. Normal SQL `UPDATE` and `DELETE` against the journal are rejected. Corrections append new records rather than rewriting history.

The journal is **not omniscient reality**. It records what the system observed, decided, attempted, and learned. External state can still be ambiguous and may require reconciliation.

Current state is rebuildable from the journal. Replay is pure state reduction: it never calls a model, sends a message, creates a booking, or repeats an external side effect.

## 3. Conversation does not own work

The architecture separates three concepts:

- **Thread** — a persistent communication stream such as an email thread, IM conversation, or web chat.
- **Run** — one disposable model/execution episode.
- **WorkItem** — a durable real-world objective that may span many threads, channels, and runs.

For example, “track this refund until it is resolved” is one `WorkItem`. The owner may discuss it in IM today, inspect it in a web UI tomorrow, and receive a provider email next week. The work survives all of those interactions because no session owns its state.

## 4. Effects are explicit and uncertain by default

The implemented action lifecycle is conceptually:

```text
proposed -> approved -> running -> accepted / failed / unknown
      \-> cancelled              unknown -> reconciled accepted / failed
```

Approval is bound to the exact command content, workspace, owner, work revision, and expiry. The runtime checks those constraints again immediately before dispatch.

`accepted` means the external provider accepted the operation; it does **not** mean the user's overall goal is complete. If a timeout occurs after dispatch, the result becomes `unknown` rather than being assumed failed and automatically retried.

This favors safety over aggressive liveness. Idempotency keys suppress ordinary duplicate dispatch, but they do not create exactly-once semantics when the external provider cannot guarantee them.

The runtime also supports versioned general operations through explicit connections
and trusted handlers. Preparation captures a fresh provider observation and an
immutable command; an exact owner approval batch authorizes only the listed
action/digest pairs. Execution rechecks the connection generation, verified remote
subject, work and subject revisions, approval, observation freshness and handler
precondition before recording `action.started` and calling the handler.

Mutation attempts are serialized by workspace, provider and verified remote
subject. Alias connection IDs for the same provider subject share the barrier.
Running, unknown and accepted-but-unverified attempts block fresh preparation in
that scope. A satisfied handler readback can settle an unknown attempt without
resubmission; owner attestation remains separately labeled evidence. See the
[general operations guide](general-operations.md) for the public API and runnable
synthetic demonstration.

## 5. Reactive and proactive work share the same durable path

Inbound messages are persisted before processing. Duplicate deliveries are deduplicated by their scoped external identity, and a collision with different content is rejected rather than silently overwritten.

Proactive follow-up uses persisted timers, not in-memory `setTimeout`. A due timer emits durable work that survives process restarts. Stale timers are cancelled when the relevant `WorkItem` has already closed or changed revision.

M0 demonstrates persistence and recovery, not a finished 24/7 daemon. Production operation still requires supervision, rate limits, budgets, quiet hours, and real channel adapters.

## 6. Long history and bounded model context

**Raw history is retained; only access to it is compressed.** Original message bodies are stored as artifacts and journal entries reference them. Summaries are derived, source-linked navigation aids and are never authoritative policy, approval, fact, or completion evidence.

A context build loads, in priority order:

1. mandatory policy and current authoritative state;
2. the active `WorkItem`, relevant identities/relationships, and the incoming event;
3. a recent raw-message tail;
4. source-linked historical summaries when budget remains.

If mandatory state cannot fit, context assembly fails explicitly instead of silently dropping constraints. The output tracks which raw messages and summaries were loaded and which state revision was used.

M0 does not yet implement automatic LLM summarization, embeddings, or hierarchical compaction. It establishes the safer substrate: raw-source preservation, provenance, bounded retrieval, and validity-aware facts.

## 7. Memory model

The system does not expose one opaque `MemoryStore`. Different forms of memory map to explicit durable structures:

| Memory role | Durable representation |
| --- | --- |
| What happened | Journal + source artifacts |
| What is currently believed true | Facts + relationships + projections |
| What is still in progress | WorkItems + commitments + approvals + timers |
| What was said in a communication stream | Threads + messages |
| What the model sees now | Ephemeral, budgeted context |

Facts carry provenance, validity ranges, and supersession. A future address does not become the current address before its effective date. Conflicting active claims remain an explicit conflict rather than being silently resolved by semantic similarity.

## 8. Extension boundaries

`ChannelAdapter` normalizes verified communication ingress and delivery. `Planner` receives a bounded context and proposes domain commands. `EffectDriver` executes one already-authorized command and returns evidence about the outcome.

These are narrow TypeScript ports, not a security sandbox. Untrusted code must not be loaded in-process merely because it implements an interface.

`OperationHandler` is another trusted in-process boundary. Each registered
provider/operation/version owns its connection identity checks, resource semantics,
argument validation, conditional write behavior and result comparison. The core
does not contain contact, subscription or banking branches. Provider acceptance,
satisfied readback, causation, exhaustive account coverage and WorkItem completion
remain separate claims.

Real Gmail, WhatsApp, WeChat, SMS, voice, and production model adapters are not part of M0.

## 9. Architectural principles

- **Journal over hidden state.**
- **State is projected, not remembered by the model.**
- **Runs are disposable; work survives conversations.**
- **Threads organize communication; WorkItems organize reality.**
- **Never compress truth; compress access to truth.**
- **Policies, approvals, active commitments, and authoritative facts never depend on lossy summaries.**
- **Persist before processing.**
- **Effects are explicit, idempotency-aware, and uncertainty-preserving.**
- **External content is untrusted.**
- **Prefer one agent runtime and a modular monolith until real load requires more.**

## 10. Next usable slice

M1 deliberately targets one personal dogfood workflow:

> The owner forwards a message that needs follow-up. The agent creates or attaches durable work, drafts a follow-up, asks the owner for approval through an authenticated control channel, sends it through one verified email binding, records the provider outcome, and continues monitoring until the work is resolved or escalated.

Authentication, protected secrets, encrypted/private artifacts, and provider reconciliation come before real-account dogfooding.

## 11. Run M0 locally

```bash
npm ci
npm run check
npm run demo
npm run operations:demo
```

The demos use synthetic data, temporary SQLite databases, and fake providers. They
send no real messages, change no real accounts and create no paid resources.
