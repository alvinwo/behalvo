# Behalvo

**An agent that acts on your behalf.**

A small, journal-backed agent runtime for work that survives conversations.

Personal dogfooding first. A shared architectural foundation for later solo-business
workflows. The project/runtime is **Behalvo**; an individual agent may have its own name, such as Jarvis or Friday. The repository now includes a **locally runnable agent MVP**; real communication channels and autonomous external effects remain out of scope.

[Local MVP guide](docs/local-mvp.md) · [中文 MVP 说明](docs/local-mvp.zh-CN.md) ·
[Architecture overview](docs/architecture.md) ·
[Architecture specification](docs/superpowers/specs/2026-09-07-architecture-v0.md) ·
[中文架构导读](docs/architecture.zh-CN.md) ·
[Brand](docs/BRAND.md) · [Roadmap](docs/ROADMAP.md) · [Verification](docs/VERIFICATION.md)

> Documentation is English-first. Chinese companion documents are supplementary;
> when wording differs, the English specification is authoritative.

## Run it locally

For the deterministic no-network smoke path:

```bash
npm ci
npm run agent -- --offline
```

For the restart/cross-thread persistence scenario:

```bash
npm run mvp:demo
```

For real models, the optional Pi adapter exposes Pi's multi-provider catalog while keeping provider state outside the agent kernel. Current Pi releases require Node.js **22.19+**:

```bash
npm install --no-save @earendil-works/pi-ai
npm run agent
```

To use an eligible ChatGPT/Codex subscription through Pi's provider-owned OAuth flow:

```text
/login openai-codex oauth
/model
/model openai-codex <model-id>
```

See [Local MVP guide](docs/local-mvp.md) for the complete setup, data paths, security boundaries, and current limitations.

## What exists in this revision

| Implemented | Not implemented |
| --- | --- |
| Append-only Journal, rebuildable state, historical reads | Automatic long-history consolidation / semantic retrieval |
| Durable owner + assistant messages across process restarts | Email, WhatsApp, WeChat, SMS or phone channels |
| WorkItems/Facts shared across explicitly linked threads | Browser automation or model-generated real-world effects |
| Provider-neutral model contract and model registry | Background supervised 24/7 daemon |
| Optional Pi multi-provider adapter and file credential store | Live Pi/Codex smoke test in the offline build container |
| Provider-owned OAuth login flow in the REPL | Hosted multi-user deployment |
| Strict model proposal validation and provenance rebinding | Encrypted raw message artifacts |
| Local inspection commands for state/history/context | Production security review |

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
  runtime/      validated work, action, timer and AgentService operations
  memory/       audience-scoped, budgeted context assembly
  model/        provider-neutral contracts, registry, optional Pi adapter
  cli/          local REPL, app wiring and cancellable terminal input
  ports.ts      channel/effect extension contracts
  index.ts      local library entry point
  mvp-demo.ts   restart/cross-thread MVP scenario
```

One package, not a forest of empty packages. The verified core has no required runtime npm dependencies; Pi is intentionally optional. No event
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

This renamed MVP is developed locally on `chore/behalvo-brand`, based on `feat/mvp-local-agent`. A GitHub repository,
Projects board, issue list, pull request and public release have **not** been
created by these files. The issue drafts under `docs/issues/` are a local backlog.

`private: true` and `license: UNLICENSED` are intentional bootstrap settings, not
an open-source license choice. The owner has chosen an open-source direction but
has not yet selected release terms. See [LICENSE-DECISION.md](LICENSE-DECISION.md).
