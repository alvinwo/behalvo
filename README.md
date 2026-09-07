# Personal Operator

**A small, journal-backed operator kernel for work that survives conversations.**

Personal dogfooding first. A shared architectural foundation for later solo-business
workflows. Working project name; **offline foundation preview, not a live assistant**.

[中文架构导读](docs/architecture.zh-CN.md) ·
[Architecture specification](docs/superpowers/specs/2026-09-07-architecture-v0.md) ·
[Roadmap](docs/ROADMAP.md) · [Verification](docs/VERIFICATION.md)

## Run the offline example

Node.js **22.16 or newer** is required. The verified environment is documented in
`docs/VERIFICATION.md`; Node 22's built-in SQLite API emits an experimental warning.

```bash
npm ci
npm run check
npm run demo
```

No API keys, email account, phone number, model subscription, containers or external
service are needed. The example uses a temporary database and a fake provider,
prints its result, then removes only its own temporary directory. It sends no real
messages and does not expose a web server.

The example demonstrates a synthetic refund case across IM/email/web threads,
owner approval, a provider-accepted action that does not close the case, suppression
of normal redispatch, recovery of an interrupted action as `unknown`, a persisted
follow-up timer, and a bounded context that retains its original history.

## What exists in this revision

| Implemented | Not implemented |
| --- | --- |
| Typed domain events, pure reducer, append-only SQL journal | Production LLM agent loop or model adapter |
| Atomic journal/projection transactions and historical state reads | Automatic natural-language fact extraction |
| Durable input queue and account-scoped deduplication | Webhook authentication and live inbox polling |
| WorkItems linked across persistent threads | WeChat, WhatsApp, phone, SMS or email transport |
| Content-bound, expiring owner approvals | Public approval UI, identity provider or team RBAC |
| Explicit action outcomes and unknown-outcome quarantine | Provider-specific reconciliation or exactly-once delivery |
| Persisted timers and stale-work checks | Supervised 24/7 daemon and real-time voice |
| Source-linked summaries and bounded owner-only context | LLM summarization, vector search or hierarchical compaction |
| Validity-aware facts and explicit conflicts | Encrypted artifacts, erasure and backup automation |
| Offline test suite and example | Production security review or hosted multitenancy |

The `Planner`, `ChannelAdapter` and `EffectDriver` interfaces are extension seams,
not claims that their production integrations already exist.

## Mental model

```text
Verified input / timer
         |
Journal + durable inbox + current state
         |
Scoped context -> planner proposals
         |
Policy / owner approval
         |
Durable action -> effect driver -> recorded outcome
```

**Journal** records what the system observed and did, not omniscient reality.
**State** is a rebuildable projection. **WorkItem** owns ongoing work.
**Thread** groups communication. **Run** is disposable. **Context** is a bounded
view; original history is not replaced by summaries.

A provider accepting an email is not proof the refund arrived. An API timeout is
not proof the email was never sent. M0 represents these distinctions explicitly.

## Source layout

```text
src/
  kernel/       domain types, reducer, deterministic policy
  storage/      SQLite transactions, journal, artifacts, inbox, summaries
  runtime/      validated work, action and timer operations
  memory/       audience-scoped, budgeted context assembly
  ports.ts      model/channel/effect extension contracts
  index.ts      local library entry point
  demo.ts       executable offline scenario
```

One package, not a forest of empty packages. No runtime npm dependencies. No event
broker, distributed workflow engine, graph database or multi-agent orchestration.

## Safety boundary

This is a **trusted local API**. Passing `ownerId` is not remote authentication.
Never expose it directly to an untrusted client or plugin. Artifact bodies are
plaintext in SQLite; use synthetic data until the M1 privacy/authentication work is
complete. It has no production credentials and all external effects require
explicit approval. See [SECURITY.md](SECURITY.md).

Unknown effects are not retried. Recovery requires exclusive maintenance with all
other workers stopped. The SQLite append-only triggers prevent normal mutations,
not an administrator rewriting the file. See the spec for the full threat model.

## Repository / licensing status

This checkout was initialized locally on `feat/bootstrap`. A GitHub repository,
Projects board, issue list, pull request and public release have **not** been
created by these files. The issue drafts under `docs/issues/` are a local backlog.

`private: true` and `license: UNLICENSED` are intentional bootstrap settings, not
an open-source license choice. The owner has chosen an open-source direction but
has not yet selected release terms. See [LICENSE-DECISION.md](LICENSE-DECISION.md).
