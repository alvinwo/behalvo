# Roadmap and scope ledger

## Current owner priority — 2026-10-09

The owner prioritized a teachable browser agent: explain a goal in conversation,
remember instructions and corrections, explore the website, and learn how to
progress without a hard-coded visa workflow. The H-1B appointment case is the
first intended use. Email and phone integrations are not prerequisites.

1. Design and review [teachable browser work](superpowers/specs/2026-10-09-teachable-browser-design.md).
   Its first implementation target is durable teachings and model-driven synthetic
   exploration across different websites. This capability is not implemented yet.
2. Establish supervised live exploration with explicit site scope, private session
   custody and current observations. Existing synthetic browser acceptance does
   not prove real portal compatibility.
3. Complete one supervised, approved action with independent readback, then assess
   the additional supervision and polling requirements for unattended operation.
4. Return to broader personal-alpha priorities, including phone and mail where
   those workflows actually require them. Public alpha remains a later decision.

PR16's live-model synthetic evaluation passed 60/60 automatic cases on reviewed
head `7e06dbcc079bff6543075ad58fff5b2c23efec2f`; human usefulness review remains
pending. The local report is
`data/evaluations/synthetic-v1-2026-10-05T06-35-12-500Z-ed33bc37-51cb-4ad9-9b10-d8d5294dfed4.json`.
Neither this evaluation nor the deterministic scripted suite certifies live
browser readiness or completes M1.1 acceptance.

## Monitored-action status

| Delivered locally | Still gated |
| --- | --- |
| One foreground service/store/queue/scheduler/worker | OS-supervised 24/7 operation |
| Paired synthetic setup, exact grant review/arm, pause, takeover, resume, stop, revoke | Remote/mobile owner identity and phone takeover |
| Fixed-origin synthetic portal through the legacy extension boundary and the application-owned Playwright P1/P2 boundary | Independently reviewed live transport, private credential custody and installation/session binding |
| Empty/restart/challenge/resume/pre-reservation-race/later-booking acceptance | Owner-laptop read-only discovery and current terms/group verification |
| One verified synthetic effect, stopped recurrence, effect-free rebuild | Live credentials, live portal acceptance, exact owner activation, real booking |

The metadata-only synthetic browser discovery report now records the 13 read-only P2
contracts, cleanup and request counts. Calendar pagination and all live-site gaps
remain unobserved. See [the report guide](PLAYWRIGHT_BROWSER.md#synthetic-discovery-report).

The later live visa step is the separate supervised read-only discovery described in
[VISA_DISCOVERY.md](VISA_DISCOVERY.md). It cannot be replaced by CI or the
synthetic demo.

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
