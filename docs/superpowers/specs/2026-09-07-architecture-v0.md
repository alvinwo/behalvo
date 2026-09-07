# Personal Operator — Architecture v0

Status: architecture direction approved; M0 foundation implementation.
Date: 2026-09-07. Working name: `personal-operator`.

## 1. Product boundary

Build for personal dogfooding first; reuse the same kernel for solo-business
workflows. Owner conversations, external correspondence, and timed follow-ups
are separate entry points into durable work. A business customer must not gain
access to the owner's personal memory merely because both use the same agent.

M0 is an **offline, single-process reference kernel**, not a deployed assistant.
It contains no production model, email, phone, WeChat, WhatsApp, OAuth or payment
adapter. Its demo uses synthetic data and a fake provider. No real messages are
sent. This is deliberate: prove persistence and safety before exposing effects.

## 2. Decisions and non-goals

- TypeScript modular monolith, one npm package with internal module boundaries.
  Extract separately versioned packages only when a second consumer needs them.
- Node.js >=22.16.0, SQLite via `node:sqlite`, no runtime npm dependencies.
- One logical writer per workspace. Optimistic stream revisions reject stale
  writes. M0 is not a multi-process daemon or a hosted multitenant service.
- Append-only domain journal; transactionally maintained current-state projection.
- At-least-once input delivery, explicit deduplication, durable effect intent.
- No Kafka, Redis, Temporal, vector service, multi-agent society, arbitrary
  JavaScript plugins, shell tools, browser automation, or public HTTP endpoint.
- No framework fork. Future model adapters may use Pi or another provider.
- No automatic grants of permission from retrieved text or summaries.

## 3. Terminology

| Name | Owns | Does not own |
| --- | --- | --- |
| Workspace | Owner, purpose, policy and data partition | All of a person's data by default |
| Agent | Long-lived configured operator in a workspace | A provider-specific session |
| Thread | Communication grouping, participant bindings, original messages | Work status or permissions |
| Run | One disposable inference/execution episode | Durable memory |
| WorkItem | Goal, status, linked threads, revision, next steps | Every message in every linked thread |
| Journal record | Recorded observation, authorized transition, action lifecycle | Objective knowledge of the external world |
| Action | Immutable command, approval, attempts and result state | The user's overall goal being achieved |
| Context | Bounded, audience-scoped inference view | The complete archive or an authorization mechanism |

M0 uses one owner principal per workspace. A future household/team adds membership
and ACLs without replacing workspace ownership. Same owner can have separate
`personal` and `business` workspaces. Cross-workspace access is denied by default;
sharing is an explicit capability with consent, not automatic global memory.

## 4. Data flow and module boundaries

```text
verified adapter / owner control / durable timer
                      |
          ingest + dedupe transaction
                      |
      Journal + Inbox + Current projection
                      |
           bounded ContextBuilder
                      |
            Planner port (proposal only)
                      |
           validated domain commands
                      |
        deterministic policy + approval
                      |
           durable action/outbox state
                      |
         EffectDriver -> recorded outcome
```

`src/kernel/` defines data and deterministic reducers. It imports no transport,
model or storage driver. `src/storage/` owns SQLite transactions and rebuilds.
`src/runtime/` is the only supported writer of business commands and the gate to
external effects. `src/memory/` builds scoped views and manages summary access.
`src/ports.ts` defines extension contracts; adapters never receive a database
handle through these contracts. This is an API boundary, not an OS sandbox.

## 5. Journal and projection invariants

Each record carries schema version, record ID, workspace ID, per-workspace
sequence, recorded timestamp, actor ID, causation reference and a typed event.
The timestamp is for observation; sequence is the replay order. External event
timestamps must not reorder committed records.

`append(workspace, expectedVersion, events)` runs in `BEGIN IMMEDIATE`:
1. Load current projection and check expected stream revision.
2. Validate and reduce each event without I/O, current clock reads or model calls.
3. Insert journal records and update the projection in the same transaction.
4. Commit; only then expose success.

SQLite triggers reject UPDATE and DELETE against journal rows. The application
never edits historical events. An administrator controlling the file can still
drop triggers or replace the file: this is **not tamper-proof storage**. Hashes
bind command approval to content; they are not digital signatures.

Replay recomputes projections only. It NEVER calls an LLM, dispatches an effect,
resends a message or re-evaluates past policy. Schema/projection versions are
explicit; unknown versions fail closed. Future migrations require old-journal
fixtures and deterministic upcasters. M0 has one initial schema version.

M0's small state projection contains the durable action outbox and schedule.
A separate SQL index can replace the scan without becoming a second authority.
Inbox processing receipts are operational metadata, not inferred domain facts.

## 6. Input durability and trust

Input dedupe key is `(workspace, source, external_id)`. Ingest atomically stores
an immutable content artifact, a `message.received` record, and an inbox row.
An adapter ACKs only after this returns. Identical redelivery returns the original
record; a conflicting payload under the same key is rejected, not overwritten.
Source IDs must include the provider account binding, not merely `email`.

Transport authentication and principal binding are adapter responsibilities.
A `From:` header, quoted owner text, a familiar name, or forwarded email does not
authenticate the owner. Relayed provenance and original sender are distinct.
M0 exposes a trusted local API only; its owner ID parameter is NOT remote auth.

External messages can be archived without triggering privileged operations.
Production adapters must verify signatures, reject replayed approvals, enforce
body/attachment limits, and prevent relay/self-message loops before rollout.

## 7. Work and state

Work has `open`, `waiting_external`, `done`, `cancelled` states and a revision.
Thread links are many-to-many; attaching a thread does not mean every message in
that thread is relevant or safe to disclose to every participant.

A successful send does NOT complete a WorkItem. `accepted` means a provider
accepted an effect; it does not mean delivered, read, paid, refunded, or booked.
Completion requires a separately authorized transition with an evidence reference.
Goal-specific validators are added by the first real workflow, not guessed by a
model. M0 records owner-confirmed completion, not independently verified reality.

Facts carry subject/predicate, validity range, source record and an explicit
supersession link. Conflicting active claims stay conflicts. Future-dated facts
must not become current early. Desired owner address and a vendor's recorded
address are different predicates. M0 does not infer facts automatically.

## 8. Effects, approval and failure

```text
proposed -> approved -> running -> accepted | failed | unknown
    |           |
    +-----------+-> cancelled
unknown -> accepted | failed  (explicit reconciliation only)
```

Command content is immutable. Approval binds workspace, action, command digest,
work revision, owner identity and expiration. The runner rechecks these at
execution, not only when the owner pressed Approve. Revocation/cancellation and
changed work invalidate stale permission. New command content needs a new action.

Every action has a logical idempotency key chosen by orchestration, never by a
fresh model-generated UUID on each retry. Same key + different command is an
error. The key is passed to the provider; **this does not make a provider that
lacks idempotency exactly-once**.

Commit `action.started` before network I/O. Record result afterward. A timeout or
worker crash in between produces `unknown`, not `failed`, because the remote
change might already exist. Unknown actions are NEVER automatically retried.
Reconcile using provider identifiers/readback or an authorized owner decision.
Only an explicitly confirmed no-effect outcome may justify a newly approved
replacement action. Reconciliation is not a database replay.

M0 startup recovery is an explicit exclusive-maintenance call. Do not run it
while another worker might still be executing. Distributed leases, fencing,
concurrent worker cancellation and provider-specific reconciliation belong to
later milestones. The fake provider cannot validate real-world delivery behavior.

## 9. Scheduling and active behavior

Timers are journaled, projected and persisted as UTC instants. A timer firing and
its inbox entry are committed together. Repeated polling cannot fire it twice.
If the associated work revision changed or work was closed, the due timer is
cancelled rather than blindly following up against an old plan.

Personal/business adapters later add timezone/DST interpretation, quiet hours,
consent, opt-out, contact rate limits, escalation, budgets and cancellation.
Proactive reach-out must still pass the same policy as a reactive action.
24/7 availability requires a running supervised daemon; M0 is not such a service.

## 10. Memory, sessions and compaction

Raw message artifacts and their journal references remain unchanged when context
is compacted. Source-preserving summaries are derived navigational artifacts.
A summary must reference existing messages in its own workspace and thread;
multiple versions can coexist. No summary can create an approval, change a fact,
or mark work complete.

Context is built fresh for each run:
1. Resolve authenticated audience and workspace before retrieval.
2. Load immutable application constraints and current relevant work/facts.
3. Preserve the newest inbound message and recent raw messages as whole blocks.
4. Add relevant summaries and historical evidence within the remaining budget.
5. Return a manifest of included records, artifacts, omissions and state revision.

M0 provides owner-only contexts and rejects external-audience requests. This is
safer than pretending it already implements field-level disclosure to clients.
Owner contexts are shared across threads through WorkItems, not transcript merging.

Budget: `input <= window - output reserve - tools reserve - envelope reserve`.
If pinned constraints/current input do not fit, fail closed instead of silently
truncating permission or the user's new request. M0's default counter is a
conservative UTF-8-byte estimate, NOT a provider-tokenizer guarantee. A production
model adapter supplies its exact counter and wire-envelope budget and rechecks
before each inference. Tool-call/result pairs and multimodal payloads will need
atomic grouping in that adapter; M0 messages are plain text.

M0 does not implement embeddings, LLM summarization or hierarchical compaction.
The source-linked summary API and bounded builder are implemented; automated
compaction remains a separately tested feature. Raw history is available by ID
regardless of whether it was loaded into this run's context.

## 11. Privacy and erasure

Append-only is a normal-operation rule, not a promise to retain personal data
forever. Sensitive bodies belong in an artifact store referenced by the journal.
Production must provide payload erasure plus invalidation of summaries, indexes,
caches and backups under a documented retention policy. Destroying a key is not
sufficient if plaintext copies remain elsewhere.

M0's artifacts are local plaintext SQLite rows, no encrypted backups or secure
erasure. DO NOT ingest sensitive real mail, credentials or customer data yet.
Do not store passwords, access tokens, OTPs or full private model reasoning in
journal payloads. Use evidence references and concise decision summaries.

SQLite WAL may create `-wal` and `-shm` files. Copying only an active `.db` is not
an acceptable backup plan. Use a tested backup API or clean shutdown/checkpoint.
No untrusted native plugins: in-process JavaScript can escape API-level controls.

## 12. Extension contracts

- `ChannelAdapter`: verified inbound envelopes and delivery capability metadata;
  own mailbox/phone and relayed mailbox/messages use the same event envelope,
  but retain different bindings, provenance, send-as rights and principal trust.
- `Planner`: bounded context -> typed proposals, no direct storage/effect access.
- `EffectDriver`: execute one approved command with stable operation ID and return
  accepted/failed/unknown plus evidence; no state mutation.
- `TokenCounter`: count provider-specific serialized context inputs.
- Future storage adapter: same transaction/revision semantics; not a lowest-common-
  denominator CRUD interface that loses atomicity.

Voice is a separate real-time edge in a future milestone. Audio frames do not
enter the ordinary work inbox as individual planning requests. Owner and caller
may interrupt a voice turn; durable commitments and side effects still use the
kernel. WeChat and WhatsApp support requires provider/account-specific feasibility
and policy review; an interface is not a working integration.

## 13. Acceptance tests for M0

Prove append-only writes, atomic rollback, per-workspace isolation, optimistic
revision conflicts, ingestion dedupe with collision rejection, replay equivalence,
restart persistence, cross-thread work context, retained raw text, summary source
validation, context budgets, fact validity/conflicts, approval binding/expiry,
unknown effect recovery, no duplicate effect on normal redispatch, no auto-complete
from accepted send, and timer cancellation/firing after restart.

## 14. Subsequent milestones

M1: personal follow-up dogfood. Add one model adapter, a locally authenticated owner
control UI/IM, one verified email/relay adapter, a read-only mode, explicit approval
UI, sensitive artifact protection, budget caps, and a supervised single daemon.
M2: source-linked automated compaction, retrieval evaluation, resumable inference,
provider reconciliation, consent/quiet hours, backup/restore, import/export.
M3: one solo-business vertical, audience-scoped context, business memberships,
calendar holds/race handling, usage accounting and hosted isolation.

Do not claim SMB product-market fit from personal dogfooding; recruit actual
operators before expanding the domain. Do not build a plugin marketplace first.

## 15. References checked for this design

These are architectural influences, not code dependencies or copied implementations.
No quantitative performance/security claim is inferred from them.

- Pi agent-core: context transformation, application-message/LLM-message boundary.
  https://github.com/earendil-works/pi/blob/main/packages/agent/README.md
- OpenClaw gateway: transport/control separation and persistent gateway model.
  https://docs.openclaw.ai/architecture
- LangGraph persistence: thread checkpointers versus cross-thread stores.
  https://docs.langchain.com/oss/javascript/langgraph/persistence
- Node SQLite API: built-in driver; experimental in Node 22.
  https://nodejs.org/download/release/latest-jod/docs/api/sqlite.html
- SQLite WAL: checkpointing, companion files and durability caveats.
  https://www.sqlite.org/wal.html
