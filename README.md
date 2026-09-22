# Behalvo

**An agent that acts on your behalf.**

A small, journal-backed agent runtime for work that survives conversations.

Personal dogfooding first. A shared architectural foundation for later solo-business
workflows. The project/runtime is **Behalvo**; an individual agent may have its own name, such as Jarvis or Friday. The repository now includes a **locally runnable agent MVP**; real communication channels and autonomous external effects remain out of scope.

[Local MVP guide](docs/local-mvp.md) · [General operations guide](docs/general-operations.md) · [Agent evaluation guide](docs/AGENT_EVALUATION.md) · [中文 MVP 说明](docs/local-mvp.zh-CN.md) ·
[Architecture overview](docs/architecture.md) ·
[Architecture specification](docs/superpowers/specs/2026-09-07-architecture-v0.md) · [Private storage guide](docs/PRIVATE_STORAGE.md) ·
[中文架构导读](docs/architecture.zh-CN.md) ·
[Brand](docs/BRAND.md) · [Roadmap](docs/ROADMAP.md) · [Verification](docs/VERIFICATION.md) · [Local owner control](docs/OWNER_CONTROL.md)

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

For the offline prepared-operations scenario:

```bash
npm run operations:demo
```

For the local synthetic owner-control acceptance path:

```bash
npm run owner-control:demo
```

The owner-control `init-demo`, `serve`, and acceptance-demo commands currently
require a POSIX platform and deliberately refuse Windows. This restriction is
limited to the owner-control feature and its process-lock/bootstrap controls.

For the deterministic synthetic agent-evaluation harness:

```bash
npm run eval:agent -- --scripted
```

This scripted result is non-live evidence. Genuine live-model acceptance has not
yet been run and remains pending configured model authorization and human review.

For real models, the bundled, pinned Pi 0.85.1 adapter exposes Pi's multi-provider catalog while keeping provider state outside the agent kernel. Node.js **22.19+** is required:

```bash
npm ci
npm run agent
```

To use an eligible ChatGPT/Codex subscription through Pi's provider-owned OAuth flow:

```text
/login openai-codex oauth
/model
/model openai-codex <model-id>
```

The selected provider/model is saved per database and workspace. Startup `--model`, `BEHALVO_MODEL`, or legacy `OPERATOR_MODEL` values override it. Credentials remain separate and are never written to model settings.

On POSIX, new Pi credential and saved-model files can opt into authenticated
encryption with an independently configured key file:

```bash
install -d -m 700 "$HOME/.local/share/behalvo-private/keys" \
  "$HOME/.local/share/behalvo-private/state"
npm run storage -- keygen \
  --out "$HOME/.local/share/behalvo-private/keys/model-state.behalvo-key"
npm run agent -- \
  --db "$HOME/.local/share/behalvo-private/state/agent.db" \
  --auth "$HOME/.local/share/behalvo-private/state/pi-auth.json" \
  --model-state-key-file "$HOME/.local/share/behalvo-private/keys/model-state.behalvo-key"
```

Use fresh auth and database/settings destinations. This option does not migrate
or erase plaintext files. The database remains plaintext unless its separate
`--storage-key-file` option is also supplied. See the local and private-storage
guides for custody, recovery, and path-separation requirements.

Use `npm run agent -- --synthetic-operations` for an isolated simulated account. Prepare in chat, review the exact command with `/actions`, approve its full digest with `/approve`, then request execution and readback in a new turn. Runs stop after eight model completions or 120 seconds; no real account handlers are shipped.

See [Local MVP guide](docs/local-mvp.md) for the complete setup, data paths, security boundaries, and current limitations.

## What exists in this revision

| Implemented | Not implemented |
| --- | --- |
| Append-only Journal, rebuildable state, historical reads | Automatic long-history consolidation / semantic retrieval |
| Durable owner + assistant messages across process restarts | Email, WhatsApp, WeChat, SMS or phone channels |
| WorkItems/Facts shared across explicitly linked threads | Browser automation or model-generated real-world effects |
| Provider-neutral model contract and model registry | Background supervised 24/7 daemon |
| Pinned Pi multi-provider adapter and separate file credential store | Independent live-model operation-loop verification |
| Provider-owned OAuth login flow in the REPL | Hosted multi-user deployment |
| Strict model proposal validation and provenance rebinding | Legacy plaintext migration, key rotation or secure erasure |
| Opt-in authenticated payload encryption for new SQLite databases | Whole-file encryption or rollback detection |
| Verified encrypted SQLite backup and restore CLI | Encrypted evaluation reports or coordinated model-state/SQLite backups |
| Opt-in protected Pi credentials and saved model settings on POSIX | Plaintext migration, model-state key rotation or secure erasure |
| Local inspection commands for state/history/context | Production security review |
| Versioned prepared operations with exact connection/resource bindings | Real account handlers, remote authentication or universal account discovery |
| Opt-in persistent synthetic contact/subscription operations with readback | Production credential protection or provider write verification |
| Bounded structured operation loop and trusted `/actions` / `/approve` commands | Autonomous retries or startup recovery of running effects |
| Versioned 20-case synthetic evaluation harness with private JSON reports | Genuine live-model evaluation and manual acceptance review |
| Foreground loopback service with pairing, durable chat/reminders, review, approval, explicit synthetic execution/readback and status | Remote/mobile identity, OS-supervised 24/7 operation, real-provider control or deployment |
| Fenced local-only browser sessions, one-host MV3 boundary, and synthetic scheduling portal | Live browser/visa adapter, production credentials, or real portal automation |
| Callback-scoped synthetic secrets, fail-closed native Keychain-helper transport, interprocess private-profile custody, and durable retryable disconnect controls | Installed signed Keychain helper, arbitrary sync/backup-root detection, live credential collection, or live private connection validation |
| Disabled-by-default China visa policy, owner-bound authenticated discovery fixtures, durable current-authority checks, exact compiled-page evidence, encrypted synthetic intent transport, and bounded strict booking/readback | Live visa registration, owner-laptop discovery, portal credentials, browser installation, polling, or real booking |

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
  operations/   versioned handler registry, prepared-operation service and synthetic demo handlers
  memory/       audience-scoped, budgeted context assembly
  model/        provider-neutral contracts, registry, bundled Pi adapter
  evaluation/   synthetic-v1 scenarios, bounded runner, safe report CLI
  cli/          local REPL, app wiring and cancellable terminal input
  ports.ts      channel/effect extension contracts
  index.ts      local library entry point
  mvp-demo.ts   restart/cross-thread MVP scenario
  operations-demo.ts  synthetic multi-operation and unknown-readback scenario
```

One package, not a forest of empty packages. Pi is the sole pinned runtime integration dependency and remains outside the kernel. No event
broker, distributed workflow engine, graph database or multi-agent orchestration.

## Safety boundary

This is a **trusted local API**. Passing `ownerId` is not remote authentication.
Never expose it directly to an untrusted client or plugin. SQLite remains
plaintext by default. New databases can opt into authenticated payload encryption
with a separate key file; metadata and several lookup patterns remain visible.
Pi credentials and saved model settings remain plaintext by default and have a
separate POSIX-only opt-in key boundary. Evaluation reports remain plaintext.
Use synthetic data until the remaining M1 privacy/authentication work is complete.
It has no production credentials and all external effects require explicit
approval. See [SECURITY.md](SECURITY.md) and the [private storage guide](docs/PRIVATE_STORAGE.md).

Unknown effects are not retried. Recovery requires exclusive maintenance with all
other workers stopped. The SQLite append-only triggers prevent normal mutations,
not an administrator rewriting the file. See the spec for the full threat model.

## Repository / licensing status

The public source repository is `alvinwo/behalvo`. The issue drafts under
`docs/issues/` remain a local backlog until they are explicitly published as GitHub
issues. No public release has been cut yet.

`private: true` and `license: UNLICENSED` are intentional bootstrap settings, not
an open-source license choice. Source visibility does **not** grant reuse rights.
The owner has chosen an open-source direction but has not yet selected release
terms. See [LICENSE-DECISION.md](LICENSE-DECISION.md).
