# Roadmap and scope ledger

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
| [04](issues/04-private-artifacts.md) | Secrets, artifact encryption, retention/erasure | M0 |
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
