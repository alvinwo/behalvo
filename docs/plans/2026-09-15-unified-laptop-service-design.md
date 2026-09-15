# Unified laptop service — design draft

Status: proposal for owner review; no runtime implementation. Inspected base:
`7558e3c` on 2026-09-15. The owner has approved moving the laptop service ahead of
phone and email work, with a small development-process PR first. This draft does
not approve its own implementation or change the published roadmap.

## Decision and scope

Build one POSIX, foreground, loopback service that owns one database and workspace.
It combines local chat/preparation, exact action review, explicit execution and
readback, a durable queue, one-shot reminders, and operational status. The first
acceptance workflow uses only a scripted model and persistent synthetic accounts.
This is the local foundation for the eventual sequence: start the laptop service,
chat from a phone, prepare, approve, explicitly execute, and inspect verified
results. Phone access requires a separate authentication and exposure design.

| Approach | Assessment |
| --- | --- |
| One service, shared application services and store | Recommended. Reuses the journal, policy, operation handlers and local control boundary while establishing one owner of work and lifecycle. |
| HTTP wrapper spawning a terminal process per request | Does not solve the database lock conflict, durable admission, shared credentials, or coordinated shutdown. |
| Separate API and worker processes | Requires new ownership/fencing and IPC machinery without a demonstrated need. Keep the modular monolith. |

The first increment runs a supervised work loop in a foreground process until
stopped and supports clean restart and explicit crash recovery. OS login/autostart
installation, automatic process resurrection,
and a 24/7 availability claim follow separately. A sleeping or stopped laptop
does no work; overdue timers are considered after it resumes.

## Existing contracts and gaps

- `src/cli/local-app.ts` and `src/control/local-app.ts` each open SQLite and acquire
  the database process lock. Separate processes therefore cannot provide chat and
  review concurrently. The in-process lock's reference counting is not a reason
  to open two stores in the unified composition root.
- `AgentService.runOwnerTurn` combines durable ingestion and processing. Its inbox
  has deduplication and handled receipts, but no durable claim, execution intent,
  queue status, or external shutdown signal.
- `OperationLoop` already bounds inference to eight completions and 120 seconds.
  It exposes `execute` on subsequent turns whenever approval exists. The service
  must add a trusted capability restriction so ordinary chat cannot dispatch.
- `Operator.schedule`, `fireDue`, and `SqliteStore.enqueueTimer` already persist
  UTC timers and commit firing with an inbox record. `runOwnerTurn` cannot process
  a timer without wrongly treating it as a new owner message.
- The review server is loopback-only and has no chat, execute, credential, model
  login, or connection-binding route. Its sessions and review receipts are
  transient; approvals and cancellations are durable.

## Ownership and interfaces

The composition root owns the process lock, one `SqliteStore`, model registry,
optional Pi gateway/settings lifecycle, synthetic provider sidecar, `AgentService`,
`OperationService`, `Operator`, queue runner, scheduler, and HTTP listener. Inject
the existing store and services into owner control; the control adapter never
opens another database. Shutdown ownership stays at the composition root.

Keep transport/session checks in `src/control`, orchestration in `src/runtime`,
transactions and operational receipts in `src/storage`, and trusted effects in
`src/operations`. The kernel remains transport/model-independent. A queue record
cannot grant permission or substitute for an action journal record.

There is one active bounded job per service. Short authenticated review,
approval, cancellation, scheduling, and status requests remain responsive while
that job awaits I/O. Synchronous mutations commit through the same runtime/store;
do not hold a transaction or whole-run mutex across model/provider awaits.
Existing revision, approval, connection and execution guards must recheck state
after awaits and immediately before dispatch.

The local UI adds chat, thread/work focus, queue/result status, UTC reminder
creation, and explicit action execution/readback controls. Persist the thread and
focused-work binding with each admitted turn. Reopening existing work must use a
linked thread when necessary, preserving the terminal's protection against
accidentally invalidating pending approvals through a new thread link.

Keep the current loopback, exact Host/Origin, anti-proxy, one-time pairing,
in-memory bearer, no-store, request-size, and route-allowlist protections. Clients
cannot choose owner/workspace bindings. Expose no login, raw credentials, key,
connection-registration, shell, browser, or owner-attestation route. Retain the
existing synthetic handler allowlist. Binding to a LAN address or adding a tunnel
is outside this increment.

## Durable admission and worker behavior

Split owner input admission from processing an already admitted record. The HTTP
request returns a stable job ID only after the input artifact, journal/inbox
record, immutable processing parameters, and queue receipt commit atomically.
Return `202` for accepted work; it means queued, not executed or verified. Losing
the response or closing the browser does not cancel accepted work.

Use a bounded operational queue in the same SQLite database, not a JSON file or
second broker. A job references its workspace, originating record/request, kind,
thread/focus or exact action, accepted model/configuration, service instance,
timestamps, and result/evidence references. Keep only operational lifecycle in
queue metadata; all business changes still use journal events and deterministic
reduction. Domain projection replay must neither process nor redispatch jobs.

Deduplicate by stable workspace/source/client request ID across sessions and
restarts. Compare the submitted command envelope; identical redelivery returns
the original job and conflicting reuse fails. Preserve first-admission parameter
snapshots even if defaults later change. Validate authentication before lookup.
For execution, duplicate lookup precedes reconsuming its one-use confirmation.

Initial limits: one active job, 64 waiting jobs, FIFO by durable admission order.
Reject new work beyond the bound before committing it; duplicates remain
queryable. Keep existing model/operation byte and completion/deadline bounds.
Persist `queued -> running -> finished | stopped | interrupted`, with fixed
application-authored reason codes. Claim durably before any model/provider call.
An error ends that job; it never restarts inference or invents a replacement
action. The worker can continue other eligible jobs after a job-level failure.
Storage/integrity failure stops admission and dispatch instead.

Commit the final owner-turn reply/proposals, inbox completion and job terminal
receipt together. For action jobs, persist the attempt association when starting
the action; an operational completion must point to the recorded action/readback
outcome. Never infer a successful effect from a completed job or model prose.

## Approval, execution, and verification

| Request | Permitted behavior |
| --- | --- |
| Chat | Catalog, inspect and prepare, plus validated reply/work/fact proposals. No execution capability, even if chat text requests it. Preparation stops the turn for review. |
| Approve / Cancel | Retain exact review, digest, revision, binding, receipt and expiry checks. Record only the decision; never enqueue inference or execution. |
| Execute and verify | A separate authenticated owner gesture, bound to one action and full digest with a fresh, purpose-bound, one-use confirmation. Durably enqueue that exact request. The worker calls the trusted operation service directly. |
| Read back | A separate bounded read-only job for an accepted or unknown action. It may record trusted verification/reconciliation according to the existing operation contract; it cannot redispatch. |

Immediately before dispatch, recheck the current approval, absolute expiry, work
revision/phase, command digest, connection generation/identity, subject conflict
barrier, and provider precondition. A queued execution request does not extend
approval. An expired, cancelled, stale, or otherwise ineligible request stops
without calling the handler. Do not renew approval or replace an action for it.

After `accepted`, the same explicit execution job attempts bounded readback.
After `failed` or `unknown`, it stops and exposes the recorded outcome; any new
readback is explicitly requested. Display action outcome and verification as
separate fields. `accepted` is not verified; `not_satisfied` is not proof that no
effect occurred. A satisfied readback establishes observed resource state, not
causation or WorkItem completion. Existing unknown/accepted-unresolved subject
barriers remain in force.

## Scheduling

Support owner-created one-shot UTC reminders, initially through a small local
control form/API with an explicit work binding and stable request identity. Do
not add model scheduling, recurrence, natural-language time conversion, timezone
or DST interpretation in this increment.

Poll persisted due timers on startup, wake, and at a bounded interval (one second
while running). Process at most 100 due timers per tick so status/control can
make progress. Preserve the existing contract: changed work revision or closed
work cancels a due timer; otherwise firing, its inbox record, and its unique
queue admission commit together. If the queue is full, leave the timer scheduled
and visibly overdue until capacity is available. Repeated polls and restart
cannot fire it again.

The first timer consumer records inbox completion and exposes a durable local
reminder linked to the timer's work. Display it from journaled timer state; do
not manufacture an owner message or arbitrarily select a conversation thread.
Timers never approve, execute, or start model inference. Unattended planning and
external follow-up need a later policy/budget/consent design.

## Lifecycle and exact failure semantics

Start with an explicit foreground `service run` command. Validate configuration,
path separation, storage modes, and model-state preflight before opening stores
or loading Pi; acquire the existing exclusive database lock before database
ownership. Open/check the database and sidecar before advertising readiness.
Model selection/configuration status is not a credential-validity claim and must
not trigger a hidden provider probe. Missing model configuration blocks chat
admission while allowing local review and status; invalid configured protected
files fail startup closed. Live requests require explicitly configured and
authorized model use; the synthetic acceptance command never loads live auth.

Authenticated status shows lifecycle phase, database mode, model configuration,
queue counts/oldest age, active job/elapsed time, last scheduler poll/next due time,
and unresolved action/verification references. It contains no secret material or
raw provider exceptions. During normal operation, liveness and job/provider
availability are distinct. Polling is sufficient initially; no WebSocket/SSE
infrastructure is needed.

| Situation | Required result |
| --- | --- |
| Duplicate submission or response lost after commit | Return/query the original job. No new model run or effect. |
| Request rejected before admission | No input/job is committed and no effect starts. |
| Model failure/deadline or preflight rejection before `action.started` | Stop the job with a safe reason; do not mark the action failed. No automatic retry. |
| Timeout, cancellation, invalid outcome or lost completion after `action.started` | Settle that attempt as `unknown` when safe storage remains available. No retry; consume late results without journal mutation. |
| Accepted effect with failed/absent readback | Preserve `accepted` plus unresolved verification. Offer readback, not re-execution. |
| Process loss with durable running job, no started action | Mark the job interrupted during exclusive startup inspection; never resume its inference automatically. |
| Process loss with running action | Preserve its barrier. Explicit maintenance can record `unknown`; startup itself does not assert nonexecution or reconcile it. |
| Never-started queued job after restart | Resume only after startup checks. An execution job still requires its separately recorded request and current unexpired approval; approval alone is never sufficient. |
| Terminal result committed before job finalization | Repair operational status from its exact durable result/attempt references without model/provider calls; otherwise mark interrupted. |
| Missing/corrupt synthetic sidecar, wrong key, mode mismatch or unsupported schema | Fail closed before dispatch. Never seed replacement truth or fall back to plaintext. |
| SQLite failure after a provider call | Stop dispatch and admission. Preserve the running/unknown barrier for maintenance; do not claim a terminal result was saved. |
| Browser disconnect, logout or session expiry after admission | Accepted jobs and recorded approvals remain durable. Session loss does not revoke already admitted intent. |

On SIGINT/SIGTERM, stop new admission, scheduler polling and dequeueing; revoke
transient control authority; abort the active job through a trusted signal passed
through `AgentService`, `OperationLoop`, and operation execution contexts. Allow
bounded settlement of its already-started attempt and application stop receipt,
then close the listener, synthetic provider and store before releasing the owned
lock. Use a five-second drain budget. Before closing storage, fence every late
continuation against the service lifecycle; aborting a transport alone is not
sufficient. If safe settlement/fencing cannot be established, exit nonzero with
the lock and unresolved barriers preserved for maintenance.

Clean restart uses the same configuration and re-pairs the browser; sessions and
review receipts do not survive. Unclean-stop lock files are never stolen by age
or PID. Removal remains a manual operation only after confirming every process
using that database has stopped and the expected lock path/identity is correct.
Then an explicit, non-network `service recover --exclusive-maintenance` path
acquires ownership and calls the existing interrupted-action recovery contract,
recording unknown rather than failure. It neither retries nor owner-attests.
Restored copies likewise need explicit activation/reconciliation; acquiring a
local lock does not fence another restored copy or establish provider truth.

## Storage and credential boundaries

Keep SQLite payload and Pi auth/settings protection as independent opt-ins.
Never infer a key, change modes, migrate plaintext, or relax path checks. Extend
storage schema/version and backup verification for any new operational table;
protected payloads and private job parameters must use the existing authenticated
storage boundary, not a plaintext metadata column or a new log/queue sidecar.

Persistent synthetic provider truth remains the independent plaintext
`<database>.synthetic.sqlite` file. Continue rejecting persistent synthetic mode
combined with encrypted SQLite before either database is created. The first
service workflow is therefore explicitly synthetic/plaintext domain storage;
protected model state, if configured separately, does not encrypt that sidecar.
Retain both synthetic databases together for restart/readback and do not claim
the encrypted backup command includes or coordinates them.

Use the existing private immediate-directory, regular-file, owner/mode,
symlink/hard-link, and path-alias checks. Include all service, lock, bootstrap,
SQLite companion, sidecar, auth/settings and key paths in separation preflight.
Do not silently chmod existing directories. Trusted ancestors/current UID remain
inside the documented boundary. No secret, raw exception, token, OTP, or private
model reasoning belongs in a job record, UI status, or application log.

The service is the sole writer of its selected auth/settings state while running.
Perform interactive login and model configuration with the service stopped; add
no browser login or credential-edit route. Sharing one plaintext auth file with
another process remains unsupported; existing protected writer locks do not
replace the service's database/lifecycle ownership.

## Synthetic acceptance and later gates

The first acceptance scenario crosses real loopback HTTP with an injectable
scripted gateway: admit chat, create/focus work, prepare a contact update, inspect
the exact review, approve, show zero dispatches, explicitly execute, and display
accepted plus satisfied readback with work still open. Restart and verify the
same history, action, sidecar state and result. No real account or credential is
needed.

Required boundary cases: duplicate/lost acknowledgements; queue saturation and
ordering; second-process lock refusal; approval/chat/timer unable to dispatch;
stale/expired/replayed/wrong-workspace execution; cancellation during preflight;
crash before claim, during inference, after action start and after outcome commit;
late completion after shutdown; unknown readback without retry; due/stale/closed
timers across restart; missing sidecar and invalid protected-storage startup.
Use child-process crash tests and fake clocks where the boundary requires them.
Run repository-required checks plus the new focused synthetic acceptance and
record actual results. Scripted success remains non-live evidence.

Genuine live-model acceptance is still blocked: the selected-model environment
configuration and default auth file were absent in the earlier metadata-only
check. This design performs no secret discovery or live calls. Configured model
authorization and independent manual review remain a distinct acceptance gate.

Later increments: (1) authenticated phone pairing/access and revocation with an
explicit network exposure design; (2) OS supervision/autostart and operational
recovery appropriate to the chosen laptop platform; (3) one real mail/provider
integration with protected credentials and conditional-write/readback design;
(4) unattended planning, timezones/recurrence, budgets and consent; then the
personal alpha. They do not become authorized through the local service UI.
