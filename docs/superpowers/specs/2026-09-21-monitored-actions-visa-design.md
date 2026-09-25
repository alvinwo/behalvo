# Monitored actions and the first visa-booking workflow

Status: approved design for specification and implementation planning. Inspected
base: `41190ab` on 2026-09-21. This design introduces reusable unattended
observation and narrowly authorized execution. Its first adapter targets a new
Beijing group appointment in an existing U.S. nonimmigrant-visa scheduling
account. No real credential, account access, payment, appointment, deployment,
or live portal experiment is authorized by this document.

## Outcome and first use case

The owner configures an existing visa-scheduling account and group, then grants
Behalvo authority to book exactly one new Beijing appointment. The qualifying
window is inclusive from 2026-12-15 through 2027-01-31 in `Asia/Shanghai`; every
appointment time offered by the provider in that window is eligible. Behalvo
selects the earliest currently observed eligible appointment, books the complete
existing group, verifies the provider's appointment record, records a redacted
receipt, stops the monitor, and informs the owner.

The laptop is the trusted execution host. Monitoring occurs only while its local
service is running, the laptop is awake, and network access is available. Human
verification initially occurs on that laptop. Phone status and takeover require
the separate remote-access design and are not prerequisites for this workflow.

Visa booking is an adapter over a general monitored-action process:

1. establish prerequisites and a private connection;
2. observe external state on a durable schedule;
3. produce a bounded, freshness-stamped observation;
4. evaluate typed constraints deterministically;
5. narrow a standing grant into one exact action;
6. reserve its effect allowance before the first possible mutation;
7. execute under a fenced session;
8. verify provider state and settle the attempt; and
9. stop, pause for a person, or continue observing according to recorded state.

## Research decision

Use a normal, dedicated Chrome profile with a narrowly permissioned Behalvo
extension and local native-messaging host. The host connects that extension to
the single Behalvo laptop service. Page interpretation and mutations are
deterministic adapter code; a model neither sees the live page nor chooses what
to click.

Do not use Playwright for the live portal. Cloudflare documents Playwright,
Selenium, Puppeteer, and Cypress as unsupported for solving production
challenges. A persistent Playwright context is useful for synthetic acceptance,
but a human solving a challenge inside it is not a dependable live architecture.
The extension keeps normal browser behavior and permits direct human interaction
in the same tab; it does not guarantee that Cloudflare or the portal will accept
automated interaction. It does not add stealth, fingerprint spoofing, proxy rotation,
CAPTCHA services, clearance-cookie copying, or challenge automation.

The portal's current terms, allowed access pattern, route sequence, session
lifetime, group semantics, and mutation boundary were not available from public
official documentation. A supervised discovery run must review current terms and
capture only sanitized page-state metadata before periodic live monitoring can be
armed. “Check regularly” guidance is not treated as permission for scripted
polling. If the observed terms prohibit the intended access pattern, live
monitoring remains disabled.

## Relationship to the existing system

Keep the modular monolith, journal, deterministic reducer, operation registry,
unknown-effect barriers, private storage, and one-service ownership. Do not add a
second workflow engine, general DSL, remote browser, or arbitrary extension API.

The approved unified-laptop-service design remains the runtime prerequisite. Its
durable queue, one active bounded job, timer ownership, lifecycle fencing, and
foreground local service must land before unattended monitoring is armed. This
design extends that service in three places:

- a journaled `MonitoredActionGrant` and deterministic narrowing policy;
- recurrence for short read-only observation jobs with bounded backoff; and
- a browser-session port implemented by a domain-allowlisted extension/native
  host pair.

The existing exact action approval remains unchanged. It has a maximum 24-hour
TTL and cannot represent this standing authority. A scheduled job, chat message,
model proposal, ordinary action approval, or browser connection cannot create or
expand a monitored-action grant.

## Components and contracts

| Contract | Responsibility |
| --- | --- |
| `MonitorSpec` | Immutable adapter, connection, eligibility, selection, schedule, expiry, stop conditions, and grant reference |
| `ObservationAdapter` | Establish identity, inspect a bounded search scope, normalize candidates, and report coverage and freshness without mutation |
| `AuthorityEvaluator` | Narrow a valid grant plus fresh observation into one exact command using deterministic code |
| `ActionDispatcher` | Atomically reserve grant capacity, persist intent, enforce barriers and fences, execute, verify, and settle |
| `BrowserSessionPort` | Dedicated profile identity, allowed origins, exclusive control epoch, page-state messages, and human ownership transfer |
| `SecretProvider` | Opaque purpose-bound references, controlled retrieval, deletion, and fail-closed access |
| `MonitorScheduler` | Persist next due time, admit one short job, coalesce missed checks, back off, pause, and stop |

Adapters expose typed operations rather than browser primitives:

```ts
interface ObservationAdapter<Candidate, Subject> {
  inspect(context: ObservationContext): Promise<Observation<Candidate, Subject>>;
  prepare(candidate: Candidate, context: ExecutionContext): Promise<PreparedEffect>;
  execute(prepared: PreparedEffect, context: FencedExecutionContext): Promise<EffectOutcome>;
  verify(subject: Subject, context: VerificationContext): Promise<Verification>;
}
```

`inspect` cannot receive mutation authority. `prepare` can navigate only through
steps classified as read-only during supervised discovery. Before any step that
may hold, reserve, submit, autosave, or otherwise change provider state,
`execute` must durably start the action and reserve the grant allowance.

`FencedExecutionContext` includes a lifecycle generation, browser-control epoch,
deadline, abort signal, exact action/grant identifiers, and an asynchronous
`assertCurrent()` capability check. The adapter calls `assertCurrent()` after
every await and immediately before every possibly mutating browser gesture.
Timeout of an outer promise alone is never considered cancellation.

## Monitored-action authority

The owner creates a grant through an authenticated, exact review. The grant is a
first-class journal object with immutable scope, digest, revision, creation and
expiry times, revocation state, and usage settlement. It is not an automatically
renewed approval.

The first grant binds:

- workspace and verified owner;
- adapter and adapter contract version;
- verified provider account and connection generation;
- dedicated browser-profile identity;
- live-read group identity and complete roster digest;
- new group booking only;
- Beijing location;
- inclusive dates 2026-12-15 through 2027-01-31 in `Asia/Shanghai`;
- all provider-offered weekdays and appointment times;
- selection of the earliest eligible appointment in the successfully inspected,
  freshness-stamped search scope;
- one effect allowance;
- polling ceiling, backoff policy, retry budget, and stop conditions; and
- absolute expiry at the end of 2027-01-31 in `Asia/Shanghai`.

It excludes payment, fee decisions, rescheduling, cancellation, group or
applicant modification, location changes, account recovery, new attestations,
form submission, document upload, and any appointment outside the window.

Reserve the single allowance atomically with `action.started`, before the first
possible external mutation. Running, accepted but unverified, and unknown
attempts retain the reservation. A restart, new candidate, new action ID,
negative or incomplete readback, or expired browser session does not restore it.
A replacement attempt requires authoritative no-effect evidence and an explicit
retry rule already covered by the grant; otherwise the owner must review a new
grant. The UI never promises exactly-once remote execution where the provider
offers no idempotency contract.

Material changes to location, dates, roster, action, connection generation,
profile identity, adapter version, execution limit, or expiry revoke the grant.
Routine observations, last-checked timestamps, queue status, human challenges,
and conversation links do not change its revision.

## Browser and human ownership

The extension manifest allows only the exact discovered scheduling origins,
native messaging to one registered Behalvo host, and the minimum tab/storage
capabilities required by the adapter. It exposes no arbitrary navigation,
JavaScript evaluation, network interception, cookie export, password readback,
or cross-origin page access. Every message is versioned, size-bounded, schema
validated, associated with one browser-control epoch, and rejected outside the
expected origin and page state.

Use a dedicated normal Chrome profile, never the owner's everyday profile. Only
one Chrome instance and one service instance may own it. The profile is an
authenticated secret artifact: keep it in an owner-only local directory, outside
Git, cloud sync, backup bundles, traces, and support exports. Require full-disk
encryption for live mode. Provide an explicit disconnect command that revokes the
connection, removes Keychain items, closes extension authority, and offers to
remove the dedicated profile.

When a challenge, MFA prompt, changed terms, login anomaly, unknown page, or
unsupported attestation appears:

1. record `needs_human` with a fixed redacted reason;
2. invalidate the automation epoch and release the active worker slot;
3. leave the dedicated Chrome window available to the owner;
4. perform no repeated challenge attempts or background clicks;
5. require explicit local resume; and
6. on resume, create a new epoch and re-read account identity, group roster,
   appointment absence, terms version where observable, and grant validity.

The owner may change the page or book manually during handoff. No continuation
captured before handoff may act afterward.

## Secrets and private data

Use `SecretProvider` with a macOS Keychain adapter first. Credentials and security
answers are generic-password items keyed by stable service, connection, purpose,
and account identifiers. Retrieve them only inside the trusted login adapter,
keep them in memory for the shortest practical time, and never place them in
environment variables, command arguments, configuration files, journal payloads,
extension storage, model context, logs, exceptions, screenshots, or support
artifacts. There is no plaintext fallback.

Prefer owner login and the browser/password manager when it keeps Behalvo from
holding a portal password. Optional Keychain-backed autofill may be added only
after the native host's signed application identity and Keychain access behavior
are tested. Keychain does not protect browser cookies, caches, downloads, or
screenshots; browser-profile custody remains a separate boundary.

Workflow state may contain only opaque connection references, profile ID,
redacted group digest, location, typed constraints, normalized availability,
fixed page-state identifiers, timestamps, outcomes, and evidence references.
Availability observations have short retention. Production screenshots, DOM,
HTML, HAR, traces, raw URLs, headers, request or response bodies, cookies,
challenge data, passport identifiers, DS-160 identifiers, security questions,
and applicant details are disabled by default.

Diagnostic capture is a separately activated, time-bounded local mode. It shows
the owner exactly what will be captured, stores it through authenticated private
storage, never sends it to a model, and requires explicit deletion or a short
retention expiry. Logs use an allowlist and fixed error codes.

## Scheduling and observation

Each poll is a short, read-only durable job. Persist `nextDueAt`, last successful
observation, observed scope, freshness, result class, consecutive failure count,
backoff, and pause reason. On wake or restart, coalesce missed checks into at most
one job; never burst to catch up. One account/profile has at most one observation
or execution job in flight.

The initial live cadence is not chosen until current portal terms and supervised
behavior are reviewed. Configuration has a hard minimum and maximum request
budget outside model control. Add bounded jitter. A challenge, 403, 429, login
anomaly, unknown page, terms change, or evidence of throttling pauses automatic
checks and requires owner action. Network/provider failures back off without IP
rotation or alternate access paths.

Distinguish these results:

- complete observation with no eligible candidates;
- complete observation with eligible candidates;
- incomplete search scope;
- session expired;
- human verification required;
- rate limited;
- provider unavailable;
- page contract changed; and
- local storage, lifecycle, or integrity failure.

Only a complete, fresh observation may narrow the grant. “Earliest” means the
earliest candidate in that successfully inspected scope at that time, not the
earliest appointment the provider may release in the future.

## Execution, verification, and recovery

For a matching candidate, recompute the group roster and policy result before
starting. Durably record the exact command, candidate, observation evidence,
grant digest, allowance reservation, connection generation, browser epoch, and
provider precondition. Recheck them after every await and before mutation.

Outcomes are settled as follows:

| Situation | Required result |
| --- | --- |
| Candidate disappears before mutation | Record safe preflight rejection; keep monitoring if the grant remains valid |
| Provider explicitly rejects before mutation | Record fixed rejection; apply bounded backoff or pause according to class |
| Provider confirms the exact group appointment | Read the authoritative appointment record, store redacted receipt, consume grant, stop monitor |
| Submission starts but confirmation is absent, invalid, or interrupted | Record `unknown`, retain allowance reservation, stop all mutation, enter verification-only recovery |
| Readback shows an exact matching appointment | Settle accepted and verified; never submit again |
| Readback is empty or incomplete | Preserve unknown; absence alone is not proof of no effect |
| Human takes browser ownership | Fence automation; fresh resume and complete preflight are mandatory |
| Storage/integrity failure | Stop admission and dispatch; preserve unresolved barriers for exclusive maintenance |

A banner, selected calendar cell, downloaded page, model statement, or completed
browser job is not booking evidence. Verification must read provider appointment
state and match reference/status, Beijing, date/time, and the complete expected
group roster. The stored receipt contains only the minimum redacted fields needed
for owner review and later reconciliation.

Restored databases or copied profiles require explicit activation and provider
reconciliation. A local lock cannot fence a second restored installation.

## Owner experience

The local UI provides:

- connection setup and disconnect without displaying stored secret values;
- supervised login/discovery status;
- exact group roster review using locally displayed redacted labels;
- monitor constraint and standing-grant review;
- arm, pause, resume, revoke, and stop controls;
- last successful check, inspected coverage, next due time, backoff, and paused
  reason;
- visible laptop-awake/service-running limitation;
- human-action instructions that open the dedicated Chrome profile;
- candidate and action lifecycle separated from booking verification; and
- final redacted appointment receipt.

The UI never says monitoring is active merely because a timer exists. It derives
status from service lifecycle, connection state, grant validity, scheduler state,
and current barriers.

## Testing and acceptance

Build a local synthetic scheduling site and synthetic extension origin first. It
models login, security question, group roster, availability calendar, slot races,
challenge handoff, session expiry, rate limit, changed terms, unknown pages,
booking confirmation, ambiguous submission, and authoritative readback. Use only
synthetic credentials and applicants in automated tests.

Required behavior tests include:

- grant creation, digest, revision, revocation, expiry, narrowing, and prohibited
  scope changes;
- atomic allowance reservation and no second execution across restart, new
  candidate IDs, duplicate timers, or unknown outcomes;
- browser epoch invalidation, late callback fencing, origin/message validation,
  and manual-handoff resume;
- mutation-boundary intent before every possibly mutating page step;
- coalesced missed polls, single-flight execution, jitter bounds, request budget,
  backoff, pause, and no catch-up burst;
- complete versus incomplete observation and freshness enforcement;
- Keychain adapter contracts with a synthetic secret provider in CI, no-secret
  errors, and production-artifact leakage scans;
- crash before reservation, after reservation, during browser mutation, after
  provider acceptance, and after verification but before queue settlement;
- verified exact group result, wrong roster/location/date rejection, ambiguous
  readback, restored-copy barrier, and explicit maintenance recovery; and
- real local HTTP/native-messaging boundaries where test infrastructure permits,
  without a bypass login or fixed production secret.

After synthetic acceptance, perform a supervised discovery run on the owner's
laptop. The owner logs in and handles every challenge. The run reviews current
terms, identities, group semantics, origins, page states, search coverage,
mutation boundary, confirmation/readback, and safe polling behavior. It performs
no booking and stores no actual credential or applicant data in the repository or
test artifacts.

Live monitoring can be armed only after:

1. the unified local service and monitored-action security contracts pass their
   release gates;
2. current portal terms do not prohibit the configured access pattern;
3. the exact existing group and single-appointment semantics are verified;
4. the owner reviews the final grant generated from live sanitized metadata;
5. security and architecture receive independent Sol-high and Astra-high review;
6. the published commit and CI match the verified local tree; and
7. the owner installs and starts the signed local service and extension.

## Delivery sequence

1. Finish and merge the unified laptop service foundation with synthetic data.
2. Add generic monitored-action grant, scheduler, dispatch fencing, and synthetic
   adapter contracts.
3. Add the normal-Chrome extension/native-host boundary and synthetic scheduling
   site.
4. Add Keychain-backed private connection handling and leakage gates.
5. Add the China visa adapter as disabled-by-default supervised-discovery code.
6. Perform owner-laptop discovery, finalize the adapter contract and polling
   policy, and independently review the resulting changes.
7. Arm the exact Beijing grant only after all live gates pass.

If the normal-browser extension proves incompatible, the first pivot is a
manual-check monitor that opens the correct authenticated page and lets the owner
inspect/book. A remote cloud browser is not the fallback because it expands
credential custody and makes Cloudflare and human takeover harder. A model-driven
browser is not booking authority.

## Primary sources reviewed

- U.S. Department of State, DS-160 and interview scheduling:
  <https://travel.state.gov/content/travel/en/us-visas/visa-information-resources/forms/ds-160-online-nonimmigrant-visa-application.html>
- U.S. Department of State, appointment wait times and regularly added slots:
  <https://travel.state.gov/content/travel/en/us-visas/visa-information-resources/wait-times.html>
- U.S. Department of State, current global visa wait times:
  <https://travel.state.gov/content/travel/en/us-visas/visa-information-resources/global-visa-wait-times.html>
- Cloudflare supported browsers and automation limitation:
  <https://developers.cloudflare.com/cloudflare-challenges/reference/supported-browsers/>
- Cloudflare clearance and challenge passage:
  <https://developers.cloudflare.com/cloudflare-challenges/concepts/clearance/>
  <https://developers.cloudflare.com/cloudflare-challenges/challenge-types/challenge-pages/challenge-passage/>
- Chrome native messaging:
  <https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging>
- Playwright persistent contexts and authentication-state sensitivity, used for
  synthetic testing only:
  <https://playwright.dev/docs/api/class-browsertype#browser-type-launch-persistent-context>
  <https://playwright.dev/docs/auth>
- Apple Keychain Services:
  <https://developer.apple.com/documentation/security/keychain-services>
