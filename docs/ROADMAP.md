# Roadmap and scope ledger

## Approved delivery sequence from the current revision

1. Run the genuine live-model evaluation and complete its manual review. The
   harness exists, but live acceptance has not yet been run.
2. Add secure mobile owner control.
3. Add one mail integration.
4. Add a durable supervised worker.
5. Run a two-week personal alpha.
6. Later, add multi-account support and constrained browser capability.
7. Only then consider a small public alpha.

The deterministic `synthetic-v1` scripted suite validates the harness; it cannot
substitute for step 1 or certify M1.1 acceptance.

The private-storage foundation now provides opt-in authenticated SQLite payload
encryption for new databases, separate key-file configuration, and verified
encrypted backup/restore. The follow-on prerequisite adds separate, opt-in
authenticated protection for Pi credentials and saved model settings on POSIX.
Evaluation reports remain plaintext, and neither increment adds authentication,
rotation, retention, or erasure. Issue 04 is therefore still open. M1.1
live/manual acceptance and remote/mobile owner control remain incomplete. See the
[private storage guide](PRIVATE_STORAGE.md).

## M0 — Offline foundation

Implemented: journal/reducer, SQLite transactions, projection rebuild/stateAt,
input dedupe/inbox, cross-thread work, owner-gated actions, unknown outcomes,
durable timers, source-linked summaries, bounded owner-only context, facts,
offline example and tests. The main remaining limitations are explicit in README.

## M1 — One real personal follow-up workflow

Owner forwards a message -> work is identified -> agent drafts a follow-up ->
owner approves through an authenticated control channel -> email provider accepts
it -> agent watches for a reply -> owner confirms the goal is resolved.

| Local draft | Deliverable | Dependency |
| --- | --- | --- |
| [01](issues/01-owner-control.md) | Authenticated owner control and approval UI | M0 |
| [02](issues/02-model-adapter.md) | Proposal-only model adapter and bounded dispatcher | 01 |
| [03](issues/03-email-relay.md) | One verified email/relay binding | 01, 04 |
| [04](issues/04-private-artifacts.md) | Protected credentials/settings and retention/erasure; payload encryption foundation delivered | M0 |
| [05](issues/05-real-followup.md) | End-to-end personal follow-up dogfood | 01–04 |

## M2 — Reliability and measured memory

[06: compaction and retrieval evaluation](issues/06-memory-evaluation.md).
[07: production durability and operations](issues/07-operations.md).
Before broader adoption: exact token accounting, repeated-compaction tests,
restore tests, provider reconciliation, budget/rate limits, cancellation, telemetry,
UTC/local-time scheduling, consent and quiet hours.

## M3 — One business vertical, not every small business

[08: business workspace pilot](issues/08-business-pilot.md).
Recruit actual operators, enforce audience-scoped retrieval and team permissions,
measure qualified leads / completed bookings / human intervention / delivery cost.
Shared kernel is an engineering hypothesis; product-market fit must be tested.

## GitHub Projects setup after connection

This is a **proposed board configuration**, not a created remote board.

Board: `Behalvo`. Status: Backlog / Ready / In progress / Review / Done.
Fields: Milestone (M0–M3), Area (Kernel / Memory / Integration / Security / Product),
Risk (Low / Medium / High). Import the eight local issue drafts as individual
issues and attach their dependencies. Keep M1 focused on one personal workflow.

Publish privately first while the project name and release license are finalized.
An OSS launch is a separate deliberate action, not a side effect of scaffolding.


## Owner-control increment

A loopback-local synthetic owner-control console now supports one-time pairing, exact review and durable approval/cancellation. Remote/mobile identity, real-message preview, live-model/manual acceptance and real-provider gates remain open.
