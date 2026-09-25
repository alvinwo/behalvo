# Task 8A report — page-derived synthetic observation and preflight

Date: 2026-09-22

Base: `f7ef5ea5adecfcbac816c22a7e6f8ea753a1bf17`

Branch: `feat/monitored-actions`

## Recovery and RED evidence

The interrupted worker left the Task 8A tests and partial strict browser protocol/content changes uncommitted. I preserved every inherited change and the controller-owned nine-line `progress.md` resumption block.

The preserved RED is valid: after a successful build, the manifest-selected compiled content script, exported background boundary, framed native transport, fixed loopback origin, and `BrowserSession` reached the synthetic adapter and failed because `adapter.inspect` did not exist. See `task-8a-red-build.log` and `task-8a-red-observation.log` (`TypeError: adapter.inspect is not a function`).

The partial protocol implementation then reproduced a separate compile failure because `SyntheticPortalState` still emitted the old calendar shape. This was an incomplete GREEN, not an invalid RED. The remaining behavior tests were already present before the adapter implementation; the first missing `inspect` stopped their shared production path. After the first named GREEN, each preserved test was run by name. The metadata-omission test first exposed cleanup of an intentionally poisoned native transport; the test helper was corrected to preserve the intended rejection while still closing its streams. No individual RED is claimed beyond the preserved missing-`inspect` failure.

## Delivered behavior

- Calendar HTML, compiled content parsing, extension validation, and host-side parsing now require exact page-derived contract/scope, identity, subject, roster, terms, appointment-absence, and per-candidate evidence fields.
- The only new navigation capability is fixed `calendar.first_page`; it and the existing `calendar.next_page` remain calendar-only, argument-free, and read-only.
- The synthetic adapter now exposes a restricted read-only calendar reader. It always restarts at page 1, requires contiguous pages and stable bindings, and enforces 100 pages, 1,000 candidates, and 262,144 total inspected bytes without truncation.
- The adapter uses the existing deterministic visa policy to choose the earliest eligible candidate, then returns to that page and rereads the exact candidate evidence before producing a complete executable observation.
- Pre-reservation disappearance returns fixed sanitized non-complete evidence, no candidates, and performs no intent, selection, reservation, or booking gesture. The monotonic synthetic transition may later expose a distinct candidate without resetting mutation evidence.
- Login/session, security/challenge/403, 429, changed terms, and unknown pages map to their respective paused result classes instead of the retryable provider-unavailable path.
- Reserved execution performs the same fresh read-only pass before durable intent and selection. A missing/drifted exact candidate rejects the action and never substitutes another candidate. Existing post-reservation unknown/revocation/readback behavior remains intact.
- The new end-to-end harness uses the fixed allowlisted origin and actual server origin consistently, loads the manifest-selected compiled content artifact, and crosses real HTTP, exported background, and framed native messaging boundaries.

No Task 8B reservation/admission, Task 8C service/control/handoff persistence, or live browser capability was added.

## Verification performed

RED evidence:

- `npm run build` — passed before the original RED; `task-8a-red-build.log`.
- `node --test --test-reporter=spec --test-name-pattern='compiled synthetic page observation is contiguous' tests/us-visa-observation.test.mjs` — failed as expected with `adapter.inspect is not a function`; `task-8a-red-observation.log`.

Fresh GREEN evidence:

- `npm run build && node --test --test-reporter=spec tests/us-visa-observation.test.mjs` — 5 passed, 0 failed; `task-8a-green-observation.log`.
- `node --test --test-reporter=spec tests/browser-protocol.test.mjs tests/browser-extension-e2e.test.mjs tests/browser-session.test.mjs tests/native-host.test.mjs tests/synthetic-portal.test.mjs tests/browser-crash.test.mjs tests/us-visa-policy.test.mjs tests/us-visa-adapter.test.mjs tests/us-visa-runtime.test.mjs tests/us-visa-unknown.test.mjs tests/us-visa-observation.test.mjs` — 116 passed, 0 failed; `task-8a-focused-final.log`.
- `git diff --check` — passed.

Per the increment brief, I did not run the full product verification gate; the controller retains that Task 8 final gate.

## Concerns and boundaries

- The full product suite and final release gate remain unrun by design.
- The synthetic fixed port fails clearly if another process already owns it; the allowlist was not broadened.
- Live portal terms, live Chrome/native-host installation, credentials, owner-laptop discovery, and activation remain unavailable and disabled.
- Pre-reservation disappearance uses the existing retryable observation result with fixed `preflight: candidate_disappeared_before_reservation` coverage; it is explicitly before reservation and cannot release or retry a reserved allowance.
- The npm invocation emits the existing warning about the `http-proxy` npm environment setting; it did not affect the build or tests.

## Review fix round 1

Reviewed head: `1cc150bcd603576ada842a80ea33e62742f024bf`

All four findings in `task-8a-review.md` were reproduced or covered by an explicit failing regression before production changes. The focused RED build passed and all four selected behavioral tests failed for the reviewed reasons; see `task-8a-fix-r1-red.log`.

Corrections:

- The bounded inspector now retains each page's normalized candidate set and `hasNext` evidence. Initial reads, final rereads, and reserved execution preflight reject duplicate candidate IDs or evidence digests and reject candidate-set or pagination contradictions with fixed non-complete `contract_changed` evidence. Exact selected-candidate disappearance remains the distinct pre-reservation no-mutation outcome.
- A strict malformed declared-calendar parser result now crosses the compiled-content/background/host boundary as a fixed sanitized `unknown` snapshot, producing a non-complete `contract_changed` observation instead of an ordinary retryable outage. The background accepts only the exact internal marker; generic rejection text, an extra-field marker, and a bare string remain invalid. Existing deadline, cancellation, supersession, and non-calendar malformed-page behavior remain unchanged.
- The synthetic browser harness now follows the POST/303 navigation explicitly, requires an exact same-origin HTML destination and a recognized rendered state/status pair, and installs valid rendered 403/429 checkpoint documents. Other destinations fail closed.
- The existing disappearance fixture now removes only the selected reread control while retaining consistent pagination, so it continues to test disappearance rather than the newly rejected intermediate-pagination contradiction.
- The asynchronous timeout compatibility test's synthetic operation budget was raised from 60 ms to 300 ms. This lets the stricter read-only preflight reach the deliberately held `slot.select` boundary; the production deadline is unchanged and the test still proves timeout to unknown with zero submit or mutation.

Fix-round verification:

- `npm run build && node --test --test-reporter=spec tests/us-visa-observation.test.mjs` — 8 passed, 0 failed; `task-8a-fix-r1-green-observation.log`.
- `node --test --test-reporter=spec --test-name-pattern='page-contract marker|contradictory visa review|superseded|cancellation' tests/browser-protocol.test.mjs tests/browser-extension-e2e.test.mjs tests/browser-session.test.mjs` — 11 passed, 0 failed. This includes exact-marker anti-forgery and the existing cancellation/deadline cases.
- `node --test --test-reporter=spec tests/browser-protocol.test.mjs tests/browser-extension-e2e.test.mjs tests/browser-session.test.mjs tests/native-host.test.mjs tests/synthetic-portal.test.mjs tests/browser-crash.test.mjs tests/us-visa-policy.test.mjs tests/us-visa-adapter.test.mjs tests/us-visa-runtime.test.mjs tests/us-visa-unknown.test.mjs tests/us-visa-observation.test.mjs` — 120 passed, 0 failed; `task-8a-fix-r1-focused-final.log`.
- `git diff --check` — passed.

The full product verification gate remains intentionally unrun for Task 8 final integration. This fix round adds no Task 8B dispatch/admission or Task 8C control/handoff behavior.

## Review fix round 2/5

Reviewed head: `48504063fef7554647ecdb0abd2843016b6d654b`

The two supported findings in `task-8a-review-r1.md` were verified against the Task 8A brief and accepted wiring design before editing. Fresh compiled-boundary tests were applied to the reviewed head in an isolated temporary worktree and run before production changes. The build passed and all four selected cases failed: gesture-preparation and gesture-commit contract loss timed out, real provider withdrawal returned `pagination_changed`, and incoherent rendered pagination evidence was not rejected at the content contract. The raw runner output and nonzero exit trailer are in `task-8a-fix-r2-red.log`.

Corrections:

- Compiled content now requires `hasNext` to agree with presence of the fixed read-only next-page control. Incoherent pagination markup becomes the exact sanitized page-contract marker; coherent terminal expansion remains adapter-level `pagination_changed` evidence.
- Background no longer reports a rejected preparation as `gesture.prepared`. The exact page-contract marker settles the non-mutating operation and returns a sanitized result immediately, while generic or forged marker shapes remain invalid. Commit-time page-contract rejection clears content's pending non-authorized operation.
- Native transport accepts only the exact bound `unknown` early result and converts preparation- or commit-time contract rejection to a typed internal gesture rejection. `BrowserSession` maps only that typed rejection to an unexpected checkpoint; synchronous compatibility transports may still return their destination snapshot normally. Cancellation, deadline, replay, and exact response binding continue to take precedence.
- The final reread treats an unchanged-candidate, unchanged-binding pagination contraction before the selected page as the selected candidate disappearing. It returns fixed `candidate_disappeared_before_reservation` evidence for candidate A, no candidates, and no mutation. Contradictory candidate sets, duplicate identity/evidence, incoherent pagination markup, and pagination expansion remain contract changes.
- The original monotonic provider withdrawal fixture is restored: `withdrawCandidateBeforeReservation()` runs before the final first-page navigation, and `publishLaterCandidate()` allows the next fresh observation to return distinct candidate B without owner resume, allowance release, selection, or booking.

During GREEN, an initially broad `BrowserSession` source-state check broke synchronous compatibility transports. The runtime compatibility file exposed that regression. The check was replaced with the narrow typed native-transport rejection above; the runtime file then passed 30/30 before the final focused gate.

Fix-round verification:

- `npm run build && node --test --test-reporter=spec tests/us-visa-observation.test.mjs` — 10 passed, 0 failed; `task-8a-fix-r2-green-observation.log`.
- `node --test --test-reporter=spec --test-name-pattern='page-contract marker|cancellation|superseded|deadline|prepared|gesture' tests/browser-protocol.test.mjs tests/browser-extension-e2e.test.mjs tests/browser-session.test.mjs tests/native-host.test.mjs` — 19 passed, 0 failed.
- `node --test --test-reporter=spec tests/us-visa-runtime.test.mjs` — 30 passed, 0 failed after the compatibility correction.
- `node --test --test-reporter=spec tests/browser-protocol.test.mjs tests/browser-extension-e2e.test.mjs tests/browser-session.test.mjs tests/native-host.test.mjs tests/synthetic-portal.test.mjs tests/browser-crash.test.mjs tests/us-visa-policy.test.mjs tests/us-visa-adapter.test.mjs tests/us-visa-runtime.test.mjs tests/us-visa-unknown.test.mjs tests/us-visa-observation.test.mjs` — 122 passed, 0 failed; `task-8a-fix-r2-focused-final.log`.
- `git diff --check` — passed.

No full product verification, hosted CI, live portal, installed-browser acceptance, credential access, or external effect was attempted. No Task 8B dispatch/admission or Task 8C control/handoff behavior was added.

## Review fix round 3/5

Reviewed head: `c6cb5429392da2c656ff488a0c186d1feeb284e6`

The supported Important finding N2 in `task-8a-review-r2.md` was verified against the Task 8A original-fence requirement before editing. Four real compiled-content, fixed-origin HTTP, background, framed-native, and `BrowserSession` regressions crossed gesture preparation and gesture commit with either a trusted-fence revocation or abort at the typed page-rejection boundary. On the reviewed implementation, all four failed: inspection resolved a stale `contract_changed` observation, and the trusted authority callback recorded no post-invalidation check. The raw failing runner output and nonzero exit trailer are in `task-8a-fix-r3-red.log`.

Correction:

- `BrowserSession.#gestureResponse` now runs the same captured-token and original trusted-fence `#assertCurrent` check on a typed `BrowserGestureRejectedError` continuation before translating its sanitized page snapshot to `BrowserUnexpectedDestinationError`.
- A still-current operation preserves the established typed `contract_changed` observation. A revoked fence preserves the exact trusted callback error, while an aborted operation preserves `OperationStoppedError`; neither stale continuation becomes page evidence.
- The four regressions assert the post-invalidation authority check, zero browser commands, zero provider mutation, no navigation error, and no preparation-to-commit continuation after a preparation rejection.
- Native cancellation acknowledgement, replay binding, genuine page-contract classification, and the existing normal-authority preparation/commit behavior are unchanged. No Task 8B dispatch/admission or Task 8C control/handoff behavior was added.

Fix-round verification:

- `npm run build && node --test --test-reporter=spec --test-name-pattern='compiled (gesture|gesture.commit) contract rejection preserves' tests/us-visa-observation.test.mjs` — 4 passed, 0 failed after the recorded four-test RED.
- `npm run build && node --test --test-reporter=spec tests/us-visa-observation.test.mjs` — 14 passed, 0 failed; `task-8a-fix-r3-green-observation.log`.
- `node --test --test-reporter=spec tests/browser-protocol.test.mjs tests/browser-extension-e2e.test.mjs tests/browser-session.test.mjs tests/native-host.test.mjs tests/synthetic-portal.test.mjs tests/browser-crash.test.mjs tests/us-visa-policy.test.mjs tests/us-visa-adapter.test.mjs tests/us-visa-runtime.test.mjs tests/us-visa-unknown.test.mjs tests/us-visa-observation.test.mjs` — 126 passed, 0 failed; `task-8a-fix-r3-focused-final.log`. This gate includes the existing cancellation, revocation, supersession, replay, ambiguous-submission, and Task 8A compatibility coverage.
- `git diff --check` — passed.

Per the increment brief, the full product verification gate remains intentionally unrun for Task 8 final integration. Live portal and installed-browser acceptance also remain outside this synthetic fix round.
