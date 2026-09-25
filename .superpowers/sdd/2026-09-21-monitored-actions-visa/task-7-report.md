# Task 7 report: disabled China visa discovery adapter

## Outcome

Task 7 is implemented on base `47a8f3c` as a disabled-by-default adapter contract for one new complete-group Beijing appointment. It adds exact policy and page-state contracts, sanitized supervised discovery and authenticated fixture validation, fenced synthetic execution and verification-only unknown recovery, and sanitized readiness in the local control API/UI.

No live adapter or native-host registration exists. No portal was contacted, no credential was used or stored, no browser was installed, and no real effect was attempted.

## Delivered behavior

- Fixed adapter/contract version 1 and exact scope: Beijing, `Asia/Shanghai`, inclusive 2026-12-15 through 2027-01-31, any provider-offered working time, deterministic earliest candidate with ID tie-break, and one effect maximum.
- Complete contiguous pagination plus appointment-absence, identity, roster, and terms bindings. Wrong location, timezone, date, roster, version, or duplicate candidate/evidence fails closed. Generic Task 4 policy evaluation retains freshness and subject/connection/profile/generation drift enforcement.
- Twelve explicit page-state contracts: login, optional security question, identity, group roster, appointment absence, terms, calendar coverage, candidate, pre-mutation review, submitted, confirmation, and authoritative readback. Unknown versions, states, fields, or invalid bounds return `contract_changed`.
- Read-only discovery accepts one exact HTTPS origin, all fixed state IDs in order, exact sanitized presence fields, explicit coverage semantics and read-only owner decision, and digest-only authentication/identity/roster/terms evidence. It rejects raw DOM, screenshots, secrets, selectors, arbitrary text, click descriptions, incomplete reports, and tampered fixtures.
- Fixture creation requires a complete supervised report, current explicit terms decision, exact reviewed origin/roster, bounded polling, freshness, and a local secret-key authenticator binding owner/installation/session. Readiness additionally reports private-connection and active-grant blockers, but live registration remains disabled even when those inputs are present.
- Synthetic execution consumes the storage-owned running reservation and service claim, journals encrypted exact intent before selection, rechecks the Task 5 fence around every await and immediately before gestures, uses the real `BrowserSession` typed select/submit/readback capability, and requires exact confirmation plus exact authoritative readback. Ambiguous, interrupted, or incomplete submission/readback becomes durable `unknown` and verification-only; it never submits twice.
- Monitoring registry, local status API, and owner UI expose only the disabled adapter and sanitized readiness. `LIVE_US_VISA_NATIVE_HOST_REGISTRATION` is explicitly `null`.
- README and SECURITY distinguish implemented synthetic/discovery behavior from all still-pending live work.

## TDD evidence

- Baseline `npm test`: 883 tests / 878 passed / 0 failed / 5 environment-dependent skips.
- Initial Task 7 RED: all four new suites failed on missing exports; implementation then made the core suites GREEN.
- UI/API RED: readiness rendering/status assertions failed before the status projection and UI were implemented.
- Review RED/GREEN slices additionally proved typed verification readback, rejection of missing/extra booking fields, exact reserved-grant reference validation, state-specific sanitized discovery fields, complete discovery-report validation, and fixture-digest tamper detection.
- Final adapter suites: 15 passed / 0 failed / 0 skipped.
- Final focused plus Tasks 4–6/control/native compatibility gate: 118 passed / 0 failed / 0 skipped.

## Final verification

- `npm test`: 899 tests / 894 passed / 0 failed / 5 environment-dependent skips.
- `npm run verify`: all five steps passed (`check`, offline demo, synthetic operations demo, owner-control demo, and `git diff --check`). The full-suite step recorded 899 tests / 894 passed / 0 failed / 5 skips. All demos reported zero real external effects.
- Verification artifact: `data/verification/2026-09-21T18-52-04.253Z-4a0f816a-ddab-4047-b7a0-67c652bb12b6/summary.json`.
- Source fingerprint was unchanged across verification: `89b079e1187f342f196da8120ebd367eea46aa4b9e197f92d55585c530a08d8a`.

## Independent review round 1 resolution

All five findings in `task-7-review.md` were independently reproduced against exact commit `d4b699944336d0a29dffa7aa63f87d0f9581ef0e` before any fix edit. No finding was disputed.

- R1: added a synthetic-only production composition that resolves the retained Task 4 action/grant/connection/installation state, binds a real service job claim, persists exact intent in an encrypted artifact plus journal event before any browser gesture, dispatches only through Task 5 `BrowserSession`, and finalizes action verification and grant settlement through `ServiceRuntime`. Startup inspection converts interrupted monitored execution at before-intent, after-intent, after-mutation, and after-confirmation boundaries to durable `unknown`/verification-only. Re-admitted execute jobs never submit again; authoritative readback alone may reconcile a booking.
- R2: the pre-submit review is an exact schema. Candidate ID/date/time/Beijing/`Asia/Shanghai`/evidence, full roster, identity, terms, appointment absence, and new-group booking type must match the retained command. Missing, extra, or changed fields return fixed `failed/contract_changed` before submit.
- R3: confirmation and authoritative appointment readback have distinct exact schemas; appointment requires explicit completeness. Execution requires identical reference/status/date/time/location/timezone/roster across both states. The immutable confirmation reference and encrypted confirmation evidence are persisted before readback, survive interruption, and constrain later verification-only recovery. Confirmation-only, changed reference, or incomplete readback remains unknown.
- R4: any rejection, timeout, cancellation, or malformed response after submit invocation returns fixed unknown and verification-only without provider text or retry. The runtime persists the same safe uncertainty and retains the one allowance.
- R5: fixture authentication is now HMAC-SHA256 with secret key material retained by a local authenticator, never embedded in the fixture. The authenticated payload binds the owner, installation generation, authenticated discovery session, origin, terms, identity, roster, state coverage, polling, owner decisions, issue time, and expiry. Rehashed edits, arbitrary tags, wrong key/session/installation/owner, future issuance, and expiry fail.

The browser protocol and local synthetic portal were correspondingly tightened so review, confirmation, and appointment are distinct typed snapshots end-to-end. Repository live registration remains disabled and the native-host registration remains `null`.

## Round-1 TDD and verification

- Review RED: all five independent findings reproduced before edits.
- Strict-contract/authentication focused GREEN: 15/15.
- Real encrypted SQLite/service-runtime/BrowserSession execution and crash/restart GREEN: 8/8.
- Focused adapter/browser/monitoring/storage/runtime compatibility: 261/261.
- Full suite: 911 tests / 906 passed / 0 failed / 5 environment-dependent skips.
- `npm run verify`: all five steps passed; all demos reported zero real external effects.
- Verification artifact: `data/verification/2026-09-21T19-58-00.794Z-bac72015-18f9-46c5-96b0-e5e8a0a94e0c/summary.json`.
- Source fingerprint unchanged across verification: `1a7c9a50ec75b747dd593afd470a8d60731bb8cec33e9aeb9736bb57208af6d9`.
- Final `git diff --check`: passed.

## Remaining gates and concerns

- This commit is not live acceptance. Owner-laptop supervised discovery, current portal terms review, real origin/page semantics, safe polling limits, exact group review, signed local installation, private connection, explicit grant activation, and independent security/architecture review remain mandatory.
- The adapter intentionally has no repository path that converts readiness into live registration. A later separately reviewed task must add any live composition only after the external gates pass.
- The first independent review findings are resolved in this implementation. A fresh independent re-review remains required before integration acceptance.

## Independent review round 2 resolution

All five re-review findings in `task-7-review.md` were verified against exact
commit `7139423af03ae9377e4da5bfc123f6427cd4c4f3`; none was disputed.

- R1.1: execution now composes the lifecycle fence with current encrypted-domain
  authority. Every continuation re-reads the exact action/attempt, blocked grant
  reservation/digest/revision, active connection/generation/provider/subject,
  profile, installation generation, and mutation-time grant expiry. Authority
  loss before dispatch safely fails without intent or submission; authority loss
  after durable intent becomes unknown and retains the allowance.
- R1.2: manifest-compiled content reads and exact-validates appointment absence,
  booking type, timezone, location, status, completeness, roster/identity/terms
  digests, calendar bounds, and slot fields from bounded DOM attributes. Missing,
  unknown, or contradictory values are rejected rather than replaced with safe
  constants.
- R1.3: verification-only recovery sends a non-mutating `recognize` request and
  binds `appointment.readback` to the exact current confirmation,
  ambiguous-submission, or appointment state. The subsequent gesture still
  performs the ordinary exact page-state and epoch checks, so a navigation race
  fails closed.
- R1.4: both reserved execution and readback adapter promises are run through the
  trusted deadline/cancellation race. A post-intent stop settles unknown; a
  readback stop preserves the unknown barrier. Late fulfillment or rejection is
  consumed, and every abandoned browser or storage continuation encounters the
  stopped current-authority fence before it can click or append. The runtime
  worker is released without weakening the native layer's validated cancellation
  acknowledgement/no-click ordering.
- R1.5: journaled intent is delivered through the narrow typed
  `booking.intent` browser gesture and compiled content form to the loopback
  synthetic portal before slot selection. The portal's durable state carries the
  exact intent/slot binding across restore; runtime fixtures no longer inject
  provider intent inside the submit transport.

### Round-2 TDD and verification

- The recorded RED attacks reproduced expired dispatch, in-flight connection
  revocation, and synthesized compiled-DOM evidence before their fixes. The
  remaining exact-state, intent, and non-cooperative tests were completed during
  interrupted-work recovery; execute and readback now cover never/late settling,
  both late resolve and reject, no late journal writes, no submit, and no portal
  mutation.
- Exact reviewer-focused gate: 296 passed / 0 failed / 0 skipped.
- Full `npm test`: 921 tests / 916 passed / 0 failed / 5 environment-dependent
  skips.
- `npm run verify`: all five gates passed, including the same full-suite counts
  and `git diff --check`. Verification artifact:
  `data/verification/2026-09-21T21-31-39.354Z-5ba9c2f0-26bc-47e5-9659-63284fd64dc7/summary.json`.
- Source fingerprint was unchanged across verification:
  `349a69404b9be396770ef292d40d313593ef2e8dfac2d4f891fb30d9b86c5b6c`.
  All demos reported zero real external effects.

This round does not constitute a fresh independent acceptance review or live
acceptance. Live registration and native-host defaults remain disabled, and the
owner-laptop discovery, current terms/origin/roster/polling review, private
connection, exact grant, signed installation, hosted CI, and independent
security/architecture gates remain outstanding.

Round-2 fix commit: `bcd2319` (`fix: close visa adapter review gaps`).

## Independent review round 3 resolution

R2.1 from `task-7-review-r2.md` was reproduced against exact base
`bcd231994a8b02e66f52fa3184c002fca5e92396` before production edits. The RED
used the encrypted `SqliteStore`, `ServiceRuntime`, `BrowserSession`, framed
`NativeMessagingTransport`, exported background boundary, manifest-selected
compiled content, and ordinary POST/303 navigation through the real loopback
HTTP portal. The portal reached `booking_review`, but the action failed because
the source content document returned its still-`calendar` snapshot immediately
after the click.

- Every validated browser response now carries the exact compiled-content
  document identity selected by the background boundary. The identity is exact,
  bounded, replay-bound, and included in prepared, committed, inspect, and
  recognize responses.
- `BrowserSession.gestureAndWaitForNavigation` commits the gesture once, then
  performs read-only recognition until a different document identity appears.
  It accepts only the caller's exact destination-state set. The wait retains the
  captured browser epoch and uses one absolute deadline no later than either the
  original fence deadline or the native protocol's 60-second gesture ceiling.
  Abort, handoff, shutdown, deadline, or current-authority loss stops the wait;
  late recognition is consumed and cannot cause another click or journal write.
- The visa composition requires a fresh `calendar` document after typed intent,
  `booking_review` after selection, `confirmation` or
  `ambiguous_submission` after submit, and `appointment` after authoritative
  readback. An unexpected fresh pre-submit destination becomes
  `failed/contract_changed`; timeout or post-submit uncertainty remains
  verification-only unknown. No gesture is replayed to obtain destination
  evidence.
- The real boundary regression also exposed that `recognize` was accepted by
  the request schema but omitted from the native-to-background message-kind
  dispatcher. The allowlisted read-only kind is now admitted through the same
  exact request validation; no new command or mutation authority was added.
- The native prepare/commit/cancel path and cancellation-acknowledgement ordering
  are unchanged. Existing held-cancelled, failed, malformed, timed-out,
  already-settled, revoke, expiry, and no-click regressions remain green.

### Round-3 TDD and verification

- RED before production edits: the full asynchronous HTTP-form runtime
  regression returned action `failed` after commands `booking.intent` and
  `slot.select`, while the portal had already reached exact `booking_review`
  with zero booking mutations.
- GREEN full-chain ordinary execution: exact commands
  `booking.intent`, `slot.select`, `booking.submit`, and
  `appointment.readback`; one booking mutation; exact confirmation and
  authoritative appointment reference; accepted/satisfied action; consumed
  grant.
- GREEN full-chain recovery and failures: ambiguous submit survives encrypted
  restart, execute is never replayed, and one form readback reconciles the
  appointment; a missing destination is bounded by the original runtime
  deadline and remains unknown with no submit; an unexpected fresh destination
  fails the review contract with no submit. A separate captured-epoch regression
  proves handoff rejects late destination recognition without replaying the
  committed gesture.
- Focused browser/runtime compatibility gate: 79 passed / 0 failed / 0 skipped.
- Exact reviewer-focused gate: 301 passed / 0 failed / 0 skipped.
- Final `npm run verify`: all five gates passed. The full suite reported 926
  tests / 921 passed / 0 failed / 5 environment-dependent skips. All demos
  reported zero real external effects; applicable demos retained replay equality.
  Verification artifact:
  `data/verification/2026-09-22T05-30-22.963Z-ed47342b-f953-4e5c-9f5c-15468bd265bf/summary.json`.
  The source fingerprint was unchanged across verification:
  `cb6cc08ff0fb886cd3cf324df6e39c072ee8dff7dd2c97c9a2196cac3f62805c`.

The supplementary reserved-grant owner-revoke limitation remains separately
recorded for Task 8. Round 3 does not change the grant reducer/policy or claim
that reserved grants can be revoked. Live registration and the synthetic native
host default remain disabled.
