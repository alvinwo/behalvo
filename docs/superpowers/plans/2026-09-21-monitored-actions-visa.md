# Monitored Actions and Visa Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the local service and reusable monitored-action machinery needed to observe an authenticated site and execute one narrowly authorized, verified appointment booking, with the China visa adapter disabled until supervised discovery completes.

**Architecture:** One foreground modular-monolith service owns SQLite, its queue, scheduler, operation registry, browser native host, and lifecycle fence. Journaled monitored-action grants deterministically narrow fresh observations into exact commands. A dedicated normal Chrome profile and allowlisted extension carry typed page-state messages; Keychain supplies optional login secrets; live visa behavior remains disabled until current terms and page semantics are discovered locally.

**Tech Stack:** TypeScript/NodeNext; Node.js 22.19+; `node:sqlite`, `node:http`, `node:test`; Chrome Manifest V3/native messaging; macOS Security/Keychain adapter; existing authenticated storage and static owner-control UI. Add no hosted service, workflow engine, CAPTCHA solver, stealth plugin, proxy, or model-driven browser.

**Spec:** `docs/superpowers/specs/2026-09-21-monitored-actions-visa-design.md`

## Global Constraints

- Work from synthetic data and the synthetic scheduling site until the explicit supervised-discovery gate.
- One service owns one database/workspace; one bounded job runs at a time; at most 64 jobs wait FIFO.
- A timeout or missing completion is unknown, never proof of nonexecution; unknown effects are never automatically retried.
- The existing exact approval contract remains unchanged; standing authority is a separate first-class journal object.
- Reserve a grant allowance atomically with `action.started` before the first possibly mutating browser gesture.
- Every browser continuation rechecks service generation, browser epoch, deadline, abort state, action, grant, and connection generation after each await and immediately before mutation.
- Human handoff invalidates automation ownership and releases the worker slot; explicit resume creates a fresh epoch and revalidates identity, group, appointment absence, terms, and grant.
- No credential, security answer, cookie, token, OTP, DS-160/passport/applicant identifier, raw DOM/HTML, challenge data, request body, response body, or private model reasoning enters journal state, logs, traces, screenshots, Git, CI artifacts, or model context.
- Live mode requires a dedicated Chrome profile, owner-only local paths, full-disk encryption, current-terms review, exact group verification, independent Sol-high plus Astra-high review, and a final exact owner grant.
- The initial grant is one new Beijing group appointment, inclusive 2026-12-15 through 2027-01-31 in `Asia/Shanghai`, all offered days/times, earliest fresh eligible candidate. It excludes payment, rescheduling, cancellation, roster changes, uploads, attestations, and other locations/dates.
- A sleeping/stopped laptop does no work. Missed polls coalesce into one; no catch-up burst.
- Preserve current CLI and synthetic owner-control behavior when service/browser integrations are not configured.

## Review Focus

- A late browser callback after timeout, shutdown, or human takeover must fail its epoch/fence check before any click.
- An unknown or accepted-unverified booking must retain the grant's only allowance across restart, restored copies, and new candidate/action IDs.
- A complete empty observation, incomplete calendar search, expired session, challenge, 403/429, and changed page contract must remain distinct states.
- Roster/account/profile/adapter-version drift must revoke or block narrowing before mutation while routine poll timestamps leave the grant revision intact.
- Secrets and authenticated browser state must remain absent from exceptions, diagnostics, backups, verification artifacts, and model requests.

---

### Task 1: Recover and complete atomic service storage

**Files:**
- Create: `src/storage/service-jobs.ts`
- Modify: `src/storage/sqlite-store.ts`, `src/storage/sqlite-schema.ts`, `src/storage/sqlite-codec.ts`, `src/storage/sqlite-validation.ts`, `src/index.ts`
- Test: `tests/service-storage.test.mjs`, `tests/encrypted-storage.test.mjs`, `tests/storage-backup.test.mjs`

**Interfaces:**
- Consumes: existing journal/inbox/timer/action transactions and `PayloadCipher`.
- Produces: `ServiceJob`, `ServiceJobClaim`, `ServiceJobResult`, `ServiceReceipt`; atomic admission, FIFO claim, exact completion, action-start association, due-timer admission, and interrupted-job inspection methods on `SqliteStore`.

```ts
export type ServiceJobKind = 'owner_turn' | 'execute' | 'readback' | 'reminder' | 'monitor';
export type ServiceJobStatus = 'queued' | 'running' | 'finished' | 'stopped' | 'interrupted';
export interface ServiceJobClaim { jobId: string; claimId: string; instanceId: string }
export interface ServiceQueueCounts {
  queued: number; running: number; finished: number; stopped: number;
  interrupted: number; oldestQueuedAt: string | null; activeJobId: string | null;
}
```

- [ ] **Step 1: Preserve the paused red tests and inspect the diff.** In `.worktrees/unified-service`, verify the current dirty files are only the recorded Task 1 scaffolding. Run `npm run build && node --test tests/service-storage.test.mjs`; save the expected missing-interface failures before editing implementation.
- [ ] **Step 2: Finish the storage behavior tests.** Cover atomic owner/job admission, identical replay, conflicting request reuse, workspace scoping, 64-waiting capacity, duplicate lookup while full, FIFO/single-running claim, exact claim finalization, before-commit rollback, timer fire/admission, and restart inspection. Use synthetic IDs and private temporary directories.
- [ ] **Step 3: Implement additive schema versions and protected payloads.** Ordinary databases remain versions 1/2. Service-enabled databases explicitly upgrade to 3/4. Store request equality tokens, protected submitted envelopes, normalized first-admission parameters, receipts, lifecycle, results, and exact action/attempt/evidence associations. Authenticate FIFO position and lifecycle metadata; never expose a public transaction callback.
- [ ] **Step 4: Implement atomic APIs.** Duplicate comparison uses the canonical submitted envelope before capacity checks; normalized work/thread/model values are snapshotted once. `startActionAttempt(..., claim)` appends `action.started` and binds the running execution job in one transaction. Timer firing, inbox insertion, request receipt, and reminder job admission commit together.
- [ ] **Step 5: Extend schema validation and encrypted backup.** Validate exact v3/v4 objects, links, lookup tokens, claim transitions, and result provenance. Tampering returns fixed public errors. Rebuild does not mutate or dispatch operational rows.
- [ ] **Step 6: Run focused gates and commit.** Run `npm run build && node --test tests/service-storage.test.mjs tests/encrypted-storage.test.mjs tests/storage-backup.test.mjs` and `git diff --check`. Commit as `feat: persist atomic service jobs`.

### Task 2: Add bounded service runtime and lifecycle fencing

**Files:**
- Create: `src/runtime/service-runtime.ts`
- Modify: `src/runtime/agent-service.ts`, `src/runtime/operation-loop.ts`, `src/operations/service.ts`, `src/operations/execution-context.ts`, `src/storage/service-jobs.ts`
- Test: `tests/service-runtime.test.mjs`, `tests/agent-service.test.mjs`, `tests/operation-loop.test.mjs`, `tests/operations.test.mjs`

**Interfaces:**
- Consumes: Task 1 claims/admission/completion and existing `OperationService`.
- Produces: admitted owner-turn processing, prepare-only chat capability, serial worker, scheduler tick, trusted execution fence, and fatal storage boundary.

```ts
export interface TrustedExecutionFence {
  readonly serviceGeneration: string;
  readonly deadline: number;
  readonly signal: AbortSignal;
  assertCurrent(): Promise<void>;
}
export interface ServiceRuntimeSnapshot {
  accepting: boolean; faulted: boolean; activeJobId: string | null;
  activeStartedAt: string | null; lastSchedulerPollAt: string | null;
  nextDueAt: string | null;
}
```

- [ ] **Step 1: Write and run red runtime tests.** Prove an admitted input is processed without re-ingestion, chat cannot execute or verify even with approval, only one drain runs, failures advance FIFO, status remains responsive during inference, and trusted storage faults stop all admission/dispatch.
- [ ] **Step 2: Separate admission from processing.** Preserve legacy `runOwnerTurn`; add `processAdmittedOwnerTurn` over the stored owner record and snapshotted parameters. Commit reply/proposals/inbox/job terminal state atomically.
- [ ] **Step 3: Enforce prepare-only capability and bounded cancellation.** Keep eight completions, 120 seconds, and existing byte limits. Reject execute/verify inside the trusted invocation path, propagate abort/deadline, and emit fixed stop reasons without provider exception text.
- [ ] **Step 4: Run exact action/readback jobs.** Recheck digest, approval, revision, expiry, binding, generation, barriers, precondition, and fence before start. Execute directly through `OperationService`; accepted outcomes receive bounded readback, failed/unknown outcomes stop, and explicit readback never dispatches.
- [ ] **Step 5: Implement serial worker, one-second timer tick, and shutdown.** Consider at most 100 due timers per tick, coalesce wakeups, run reminders without model/effect calls, disable admission before abort, allow five seconds to settle, and fence late continuations before closing storage.
- [ ] **Step 6: Verify races and commit.** Test abort before/after start, late resolve/reject, failed outcome commit after a synthetic effect, 101 due timers, full queue, stale work, restart, and replay without dispatch. Run focused tests and commit `feat: run bounded local service jobs`.

### Task 3: Extend authenticated local control and compose the service

**Files:**
- Create: `src/control/service-control.ts`, `src/service/config.ts`, `src/service/local-service.ts`, `src/cli/service-main.ts`
- Modify: `src/control/types.ts`, `src/control/local-app.ts`, `src/control/http-server.ts`, `src/control/review-service.ts`, `src/control/web/index.html`, `src/control/web/app.js`, `src/control/web/styles.css`, `src/index.ts`, `package.json`
- Test: `tests/service-control.test.mjs`, `tests/service-http.test.mjs`, `tests/service-cli.test.mjs`, `tests/service-lifecycle.test.mjs`

**Interfaces:**
- Consumes: Task 2 runtime/status and existing pairing/session/review controls.
- Produces: authenticated admission/status/job/reminder/execute/readback routes; one-service composition; explicit foreground run and exclusive recovery commands.

- [ ] **Step 1: Write HTTP/control red tests.** Authenticate before duplicate lookup. Prove clients cannot set owner/workspace/source, approval does not execute, execution needs a fresh purpose-bound one-use confirmation, lost acknowledgements return the original receipt before token consumption, and legacy route allowlists remain unchanged without the service adapter.
- [ ] **Step 2: Add service-control methods and strict routes.** Add bounded `POST /api/chat`, `/api/reminders`, `/api/actions/:id/execute`, `/api/actions/:id/readback`; add read-only `/api/service`, `/api/jobs`, `/api/jobs/:id`. Return `202` only after durable admission. Use fixed safe errors and `no-store` headers.
- [ ] **Step 3: Normalize focus before admission.** Reuse an already-linked thread for focused work with pending approval; fingerprint the submitted envelope separately. Never link work during asynchronous processing.
- [ ] **Step 4: Build the single composition root.** Preflight path separation, storage mode, explicit schema upgrade, model state, synthetic sidecar, and process lock before readiness. Open one store and inject it into control/runtime. Missing model configuration blocks chat only. Persistent synthetic plus encrypted domain storage fails before creating either database.
- [ ] **Step 5: Add owned shutdown and recovery CLI.** `service run` is foreground POSIX. SIGINT/SIGTERM stops admission/timers/dequeue, revokes sessions, aborts active work, drains five seconds, closes resources, then releases the lock. `service recover --exclusive-maintenance` requires exclusive ownership and records unresolved running actions as unknown without retry.
- [ ] **Step 6: Complete responsive UI and tests.** Show pairing, chat, work focus, queue/result, reminders, review, approval/cancel, explicit execute/readback, lifecycle, unresolved barriers, and honest awake/running limits. Test real loopback HTTP, request bounds, origin/host checks, session expiry, queue saturation, restart, and second-process refusal.
- [ ] **Step 7: Commit the service slice.** Run focused HTTP/CLI/lifecycle tests and `git diff --check`; commit `feat: add unified laptop service`.

### Task 4: Add generic monitored-action grants and recurrence

**Files:**
- Create: `src/monitoring/types.ts`, `src/monitoring/policy.ts`, `src/monitoring/service.ts`, `src/monitoring/registry.ts`
- Modify: `src/kernel/types.ts`, `src/kernel/reducer.ts`, `src/kernel/policy.ts`, `src/storage/sqlite-store.ts`, `src/storage/service-jobs.ts`, `src/runtime/service-runtime.ts`, `src/index.ts`
- Test: `tests/monitoring-policy.test.mjs`, `tests/monitoring-service.test.mjs`, `tests/monitoring-storage.test.mjs`

**Interfaces:**
- Consumes: journal, service jobs, Task 2 fence, operation starts/outcomes.
- Produces: grant lifecycle, immutable scope digest, deterministic narrowing, recurring monitor admission, allowance reservation/settlement, and restored-copy activation barrier.

```ts
export interface MonitoredActionGrant {
  id: string; workspaceId: string; ownerId: string; adapter: string;
  adapterVersion: number; connectionId: string; connectionGeneration: number;
  browserProfileId: string; subjectDigest: string; scope: unknown;
  maximumEffects: 1; expiresAt: string; revision: number; digest: string;
  status: 'pending' | 'active' | 'revoked' | 'expired' | 'consumed' | 'blocked';
}
export interface Observation<Candidate = unknown> {
  observedAt: string; complete: boolean; coverage: unknown;
  candidates: Candidate[]; result: 'complete' | 'session_expired' |
    'needs_human' | 'rate_limited' | 'provider_unavailable' | 'contract_changed';
}
```

- [ ] **Step 1: Write reducer/policy red tests.** Cover exact digest/revision, owner activation, expiry/revocation, prohibited scope, material drift, routine observation not changing grant revision, one allowance, and replay-only reduction.
- [ ] **Step 2: Add journal events and validation.** Add proposed/activated/revoked/expired/reserved/settled grant events. Validate bounded JSON-safe scopes, exact workspace/owner/adapter/connection/profile/subject identity, UTC expiry, and `maximumEffects === 1` for v1.
- [ ] **Step 3: Implement deterministic evaluator and atomic reservation.** Only a complete fresh observation can yield an exact command. Reserve grant capacity with `action.started` in the same transaction. Unknown/accepted-unverified retains it; a negative readback cannot restore it. Material scope changes revoke.
- [ ] **Step 4: Add recurring monitor jobs.** Persist next due time, request budget, jitter bounds, last successful observation, coverage, failures/backoff, and pause state. Coalesce overdue polls; never catch up. Human/challenge/403/429/contract changes pause and release the worker.
- [ ] **Step 5: Add restored-copy and recovery barriers.** Activation binds an installation generation. Restored state blocks monitoring/execution until explicit reconciliation. Local process locks alone do not clear the barrier.
- [ ] **Step 6: Verify and commit.** Test concurrency, crash around reservation, new candidate/action IDs, restart, restored copies, incomplete search, stale observations, and no model discretion. Commit `feat: add monitored action authority`.

### Task 5: Add the browser extension/native-host boundary and synthetic portal

**Files:**
- Create: `extension/manifest.json`, `extension/background.ts`, `extension/content.ts`, `extension/protocol.ts`, `src/browser/types.ts`, `src/browser/session.ts`, `src/browser/native-host.ts`, `src/browser/native-manifest.ts`, `src/synthetic-portal/server.ts`, `src/synthetic-portal/state.ts`
- Modify: `src/service/local-service.ts`, `src/runtime/service-runtime.ts`, `package.json`, `tsconfig.json`, `.gitignore`
- Test: `tests/browser-protocol.test.mjs`, `tests/browser-session.test.mjs`, `tests/native-host.test.mjs`, `tests/synthetic-portal.test.mjs`, `tests/browser-crash.test.mjs`

**Interfaces:**
- Consumes: Task 2 execution fence and Task 4 observation/monitor contracts.
- Produces: exact-origin typed extension protocol, exclusive browser epochs, human ownership transfer, and synthetic site states.

```ts
export interface BrowserEpoch {
  profileId: string; connectionGeneration: number; epoch: string;
  serviceGeneration: string; allowedOrigin: string;
}
export interface BrowserSessionPort {
  inspect(expectedState: string, fence: TrustedExecutionFence): Promise<unknown>;
  gesture(command: unknown, fence: TrustedExecutionFence): Promise<unknown>;
  transferToHuman(reason: string): Promise<void>;
  resume(): Promise<BrowserEpoch>;
}
```

- [ ] **Step 1: Write protocol and epoch red tests.** Reject wrong origin, tab, profile, service generation, epoch, schema version, size, page state, replay, arbitrary URL/script, cookie export, and late response after handoff/shutdown.
- [ ] **Step 2: Implement the smallest Manifest V3 extension.** Allow only synthetic origin initially and native messaging to one host. Content code recognizes adapter-owned states and executes allowlisted typed gestures. It has no arbitrary JavaScript, network interception, password readback, or cross-origin access.
- [ ] **Step 3: Implement length-prefixed native messaging and session ownership.** Validate every message at both ends, enforce one profile/session, use random epochs, and call the trusted fence after each await. Human transfer durably pauses the monitor, invalidates epoch, and releases the worker. Resume rereads identity/subject/terms before returning authority.
- [ ] **Step 4: Build the synthetic scheduling portal.** Model login, security question, group roster, paged calendar coverage, no slot, matching slot, slot race, challenge, session expiry, 403/429, changed terms, unknown page, booking confirmation, ambiguous submission, and authoritative readback.
- [ ] **Step 5: Add crash/race acceptance.** Kill/restart before gesture, after durable intent, after provider mutation, after confirmation, and during handoff. Prove no late click and no second booking. Commit `feat: add fenced local browser sessions`.

### Task 6: Add Keychain-backed private connections

**Files:**
- Create: `src/secrets/types.ts`, `src/secrets/keychain.ts`, `src/secrets/synthetic.ts`, `src/connections/private-connection.ts`
- Modify: `src/browser/native-host.ts`, `src/service/config.ts`, `src/service/local-service.ts`, `src/control/service-control.ts`, `src/control/web/app.js`
- Test: `tests/secret-provider.test.mjs`, `tests/keychain-contract.test.mjs`, `tests/private-connection.test.mjs`, `tests/secret-leakage.test.mjs`

**Interfaces:**
- Consumes: private-path checks, dedicated profile ID, native host.
- Produces: opaque purpose-bound secret references, Keychain adapter, synthetic CI provider, disconnect/removal, and leakage gates.

- [ ] **Step 1: Write synthetic-provider and leakage red tests.** Use canary username/password/security answers and assert they never appear in journal, job payloads, errors, logs, status, model requests, screenshots, traces, backups, or verification directories.
- [ ] **Step 2: Implement `SecretProvider`.** Define `put`, `withSecret`, `delete`, and metadata-only `list`. Do not expose a general `get(): string`. Scope by service/connection/purpose/account and zero temporary byte buffers where practical.
- [ ] **Step 3: Implement macOS Keychain through a native helper boundary.** Never pass secret values in argv/environment/stdout. Fail closed on locked/unavailable Keychain or application-identity changes. CI exercises only the synthetic provider and contract fixtures.
- [ ] **Step 4: Enforce profile custody.** Require dedicated profile, owner-only directory, explicit full-disk-encryption acknowledgment for live mode, no cloud-sync path, single ownership, and no Git/support/backup inclusion. Disconnect revokes connection/epochs and deletes selected Keychain items before offering profile removal.
- [ ] **Step 5: Verify and commit.** Run contract/leakage tests and inspect all artifacts for canaries. Commit `feat: protect private browser connections`.

### Task 7: Add the disabled China visa discovery adapter

**Files:**
- Create: `src/adapters/us-visa-china/types.ts`, `src/adapters/us-visa-china/states.ts`, `src/adapters/us-visa-china/adapter.ts`, `src/adapters/us-visa-china/policy.ts`, `src/adapters/us-visa-china/discovery.ts`
- Modify: `src/monitoring/registry.ts`, `src/browser/native-manifest.ts`, `src/service/config.ts`, `src/control/service-control.ts`, `src/control/web/app.js`
- Test: `tests/us-visa-policy.test.mjs`, `tests/us-visa-adapter.test.mjs`, `tests/us-visa-discovery.test.mjs`, `tests/us-visa-unknown.test.mjs`

**Interfaces:**
- Consumes: Tasks 4–6 contracts and synthetic portal only in automated tests.
- Produces: disabled adapter registration, exact Beijing policy, sanitized discovery report, and post-discovery contract fixture. It cannot be armed from code defaults.

- [ ] **Step 1: Write policy red tests.** Accept Beijing candidates from 2026-12-15 through 2027-01-31 Shanghai time and choose earliest; reject other dates/locations, incomplete/stale coverage, roster drift, existing appointment, payment/reschedule/cancel/roster changes, adapter-version mismatch, and more than one effect.
- [ ] **Step 2: Define explicit page-state contracts against the synthetic site.** Login, optional security question, identity, group roster, appointment absence, terms, calendar coverage, candidate, pre-mutation review, submitted, confirmation, and authoritative appointment readback. Unknown states return `contract_changed`; selector failure never guesses.
- [ ] **Step 3: Implement read-only discovery mode.** Record only origins, fixed state IDs, contract version, sanitized field presence, coverage semantics, and terms digest/owner decision. It cannot click a possibly mutating control, store raw DOM/screenshots, arm recurrence, or create a grant.
- [ ] **Step 4: Implement deterministic synthetic execution.** Persist intent/reservation before the first synthetic mutation; recheck all fences; verify exact reference/status/Beijing/date/time/full roster. Ambiguous submission becomes unknown and verification-only.
- [ ] **Step 5: Keep live registration disabled.** Enabling requires a generated local contract fixture from supervised discovery, current-terms decision, allowed origin review, exact roster digest, polling limits, and a separately owner-reviewed grant. No repository default can satisfy these gates.
- [ ] **Step 6: Verify and commit.** Run adapter tests entirely against the synthetic portal. Commit `feat: add supervised visa adapter discovery`.

### Task 8: Complete product acceptance, documentation, review, and release

**Files:**
- Create: `src/service-demo.ts`, `docs/LOCAL_SERVICE.md`, `docs/MONITORED_ACTIONS.md`, `docs/VISA_DISCOVERY.md`
- Modify: `README.md`, `SECURITY.md`, `docs/architecture.md`, `docs/ROADMAP.md`, `docs/VERIFICATION.md`, `package.json`, `.github/workflows/ci.yml`
- Test: `tests/service-demo.test.mjs`, `tests/monitored-action-acceptance.test.mjs`, `tests/production-boundary.test.mjs`

**Interfaces:**
- Consumes: all prior tasks.
- Produces: synthetic end-to-end demo, accurate operational guides, final release gates, and evidence package.

- [ ] **Step 1: Write end-to-end red acceptance.** Through real loopback HTTP and native-messaging framing, create synthetic connection/group, grant one bounded appointment, monitor across restart, encounter and resume a human checkpoint, race a slot, book one later candidate, verify it, stop recurrence, and replay the journal with zero effects.
- [ ] **Step 2: Add production-boundary tests.** Prove live origins and Keychain are disabled in CI/default builds, synthetic artifacts contain no canaries, browser capability cannot escape allowlists, and scripted/model text cannot create grants or browser gestures.
- [ ] **Step 3: Build demo and documentation.** Clearly separate implemented synthetic behavior, supported local service, supervised discovery, and still-pending live acceptance. Document install/uninstall, Keychain/profile custody, awake limitation, handoff, unknown recovery, revocation, backup exclusions, and exact grant review.
- [ ] **Step 4: Run one final local verification.** Run `npm run verify` from a clean final tree. Read the terminal `data/verification/*/summary.json` and raw logs; require all gates pass and source fingerprints remain unchanged.
- [ ] **Step 5: Request mandatory independent review.** Sol-high reviews implementation/security; Astra-high reviews architecture/authority/recovery. Fix only evidence-supported findings with focused behavior tests, then rerun `npm run verify` once on the final tree.
- [ ] **Step 6: Publish and merge.** Push the exact verified commit, create a PR describing synthetic versus live evidence, inspect both Node 22.19 and Node 24 CI jobs/logs/artifacts, merge only if the expected head and required reviews remain current, then inspect post-merge CI and fast-forward local `master`.
- [ ] **Step 7: Perform supervised discovery separately on the owner laptop.** This is a post-merge operational gate, not CI. Review portal terms and page semantics with no booking, finalize sanitized contract/polling limits, run the required independent security review, and only then present the exact live grant for owner activation.

## Execution order and branch integration

Tasks 1–3 finish the existing `feat/unified-laptop-service` worktree first. Publish
and merge that independently because Tasks 4–8 depend on its reviewed contracts.
Then rebase `feat/monitored-actions` on the merged service commit and execute Tasks
4–8. Each task uses one implementation writer and one fresh reviewer before the
next dependent task. Routine storage/control/UI work uses Terra-medium; complex
runtime, browser, secrets, and recovery work uses Sol-high. Final review is
Sol-high plus Astra-high.
