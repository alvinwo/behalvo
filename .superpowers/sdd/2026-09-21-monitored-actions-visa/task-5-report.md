# Task 5 report — fenced local browser sessions

## Result

Task 5 is implemented as a local-only, typed browser boundary backed by a deterministic synthetic scheduling portal. It introduces no Keychain integration, production credentials, real visa adapter, real portal automation, or external network behavior from Tasks 6–7.

## Delivered

- A Manifest V3 extension restricted to `http://127.0.0.1:43117/*`, the `nativeMessaging` permission, and the single `com.behalvo.synthetic_browser` native host.
- An exact, versioned, 32 KiB protocol independently validated at the native host, extension background, and content boundaries. Requests bind request ID, profile, connection generation, random epoch, service generation, origin, tab, monotonic sequence, and expected page state.
- Typed page snapshots and four fixed gestures only: calendar pagination, slot selection, booking submission, and appointment readback. Unknown keys, sensitive fields, arbitrary selectors/URLs/scripts/network data, invalid states, oversized messages, binding drift, and replay are rejected.
- Exclusive browser-session ownership per profile, fresh random epochs, trusted-fence checks after awaits and immediately before mutation, and service-shutdown invalidation.
- Durable human handoff ordering: block pending gestures, persist the pause, invalidate the epoch, abort outstanding continuations, release the worker, and reject late responses. Resume creates a fresh epoch only after exact profile, generation, identity, subject, terms, and appointment-absence preflight.
- Strict four-byte little-endian native-messaging framing with bounded, chunk-safe reads, callback/backpressure-safe writes, fatal UTF-8 parsing, and fixed safe framing/size errors. The native manifest accepts one extension origin and an absolute executable only.
- A loopback-only synthetic portal covering login, security question, group roster, paginated empty/matching calendars, slot race, booking review, challenge, session expiry, 403, 429, changed terms, unknown page, confirmation, ambiguous submission, and authoritative appointment readback.
- Durable synthetic state proving that restart before a gesture or after intent does not mutate provider state, and restart after provider mutation, ambiguity, or confirmation cannot create a second booking.

## TDD evidence

The first focused RED run was:

`npm run build && node --test --test-reporter=spec tests/browser-protocol.test.mjs tests/browser-session.test.mjs tests/native-host.test.mjs tests/synthetic-portal.test.mjs tests/browser-crash.test.mjs`

It failed all five test files because the Task 5 exports did not exist. Production code was added only after that failure; the first complete focused GREEN was 14 passed, 0 failed.

Review-driven RED/GREEN slices then separately demonstrated and fixed:

- missing native-to-content request forwarding and non-exact content snapshots;
- invalid calendar dates/times being admitted;
- invalid UTF-8 native messages being decoded permissively;
- a direct booking-review synthetic scenario without a selected slot;
- non-settling browser continuations retaining the worker after handoff;
- empty, nonpositive, or unbounded extension binding values;
- relative native-host executable paths;
- unknown keys in the outer durable-state envelope;
- clicks racing a durable pause that had started but not yet committed; and
- local-service shutdown not invalidating configured browser sessions.

Final focused and compatibility gate:

`npm run build && node --test --test-reporter=spec tests/browser-protocol.test.mjs tests/native-host.test.mjs tests/browser-session.test.mjs tests/browser-crash.test.mjs tests/synthetic-portal.test.mjs tests/service-lifecycle.test.mjs tests/service-runtime.test.mjs tests/monitoring-service.test.mjs`

- 100 passed, 0 failed, 0 skipped.

## Verification

- Final full `npm test`: 757 tests; 755 passed, 0 failed, 2 skipped.
- Final `npm run verify`: all five steps passed: typecheck, the same full suite, offline demo, synthetic operations demo, owner-control demo, and diff check. All demos reported zero real external effects; applicable demos reported replay equality.
- Verification source fingerprints were identical before and after: `c8e6f2fbb6e9c85db2f1c258f29ada7e3b6188fd448230da8313bdef2bb46721`.
- Evidence: `data/verification/2026-09-21T12-19-22.197Z-71e88cb6-4e4c-48d7-9c7e-941ab3cc78df/summary.json`.
- `git diff --check`: passed after the final implementation edits and before this evidence update.
- The only emitted warning is npm's pre-existing unknown `http-proxy` environment-config warning.

## Self-review

- Confirmed the extension requests only its exact local host permission plus `nativeMessaging`; it contains no arbitrary fetch, navigation, script execution, cookie, credential, header/body, or cross-origin interface.
- Confirmed the native host and extension revalidate exact envelopes independently rather than trusting an upstream layer.
- Confirmed a gesture cannot pass authorization after handoff begins, even while durable pause persistence is pending, and a non-cooperative transport cannot retain the serial worker after the pause commits.
- Confirmed synthetic submission requires a recorded durable intent, an ambiguous submission mutates exactly once, and authoritative readback discovers the existing appointment after restart.
- Confirmed Task 4 monitoring and service tests remain green and no real-provider dispatch or credential surface was added.

## Ruling

The background module compiles through `tsconfig.extension.json`, while the static content script compiles through `tsconfig.extension-content.json` as one self-contained classic script. This keeps browser globals and `extension/dist` isolated from the existing Node `dist/index.js` package layout while matching the manifest execution contexts. The root build and typecheck scripts run all three configurations.

## Remaining concerns

No Task 5 blocker is known. The live browser/visa adapter, OS credential store, production extension installation, and real portal behavior intentionally remain unavailable for separately reviewed Tasks 6–7. The later adapter must supply the monitor-specific durable pause/resume implementation behind Task 5's required persistence interface.

## Independent-review fix round

All seven findings in `task-5-review.md` were independently reproduced against `0b9d810` before production edits and accepted as valid: five P1/high and two P2/medium.

- The manifest-referenced content artifact now builds as a self-contained classic script. The test reads the path from the actual manifest, parses it with `vm.Script`, executes it in a synthetic Chrome context, and drives the installed listener.
- Native transport, extension background, and compiled content now establish one exact live binding over profile, connection generation, epoch, service generation, origin, and tab. Requests use monotonic sequence/replay checks, fresh documents receive an exact sequence baseline, gestures use prepare/commit, and acknowledged revocation clears pending mutation authority. Duplicate/foreign revocation, replay, stale document binding, delayed delivery, and revocation racing a suspended bind are rejected.
- Each session operation captures its original epoch and abort controller before its first await. That immutable token is checked after every fence await, inside authorization, and by a synchronous final guard immediately before the commit frame; resume can never reauthorize an old continuation.
- A pause failure, including commit-then-reject ambiguity, invalidates the epoch and leaves the session faulted without releasing its worker. Only explicit persistence recovery permits resume.
- Resume, handoff/release, recovery, shutdown, activation, and revocation are single-flight or revision-fenced as appropriate. Shutdown permanently cancels held resume, concurrent resume is rejected, in-flight activation cannot be overtaken by revocation, and a failed native write rejects every pending exchange.
- The loopback portal renders only authoritative state, with exact adapter-owned fields for every advertised snapshot and fixed same-origin forms for page, selection, exact slot-plus-intent submission, and readback. Empty/paged/raced slots, durable intent typing, ambiguity, and appointment readback are covered through HTTP interactions.
- Native writes retain safe error/close consumers, bound missing responses, fail the channel on EOF/timeout/write failure, reject with fixed messages, and consume late raw stream errors. Subprocess tests prove no private provider text reaches stderr or an uncaught error.

The actual compiled-extension regression connects `BrowserSession` through real native framing, the exported background entrypoint, and the manifest content artifact. A delayed gesture is prepared but never committed after handoff; revocation is acknowledged before handoff completes and click count remains zero. A second end-to-end regression commits a compiled-content form rendered by the real loopback server and observes authoritative provider state advance.

### Review TDD evidence

Each review correction began with a focused failing test or independent reproduction. Representative RED results included the classic parse error `Cannot use import statement outside a module`, three replay/foreign clicks, an old authorization clicking after resume, a fresh click after failed pause, resume succeeding after shutdown, a false slot plus five schema-invalid recognizer results, and an uncaught raw native writer error. Additional audit REDs demonstrated generic booking submission, duplicate revocation, revocation racing a suspended document bind, revocation overtaking activation, a concurrent write leaving another exchange unsettled, and non-string HTTP intent coercion. Each corresponding focused slice passed after its minimal production change.

Final evidence for this fix round:

- Focused browser plus Task 4 compatibility gate: 122 passed, 0 failed, 0 skipped.
- Full `npm test`: 779 tests; 777 passed, 0 failed, 2 skipped.
- `npm run verify`: all five steps passed with identical before/after source fingerprint `3b64b57df38dee44310934ee739dd655cedfd2435cf51089bba7b74416f85d39`.
- Verification evidence: `data/verification/2026-09-21T13-22-36.811Z-e95109ec-e2eb-4005-a587-3eaf1f0f39fb/summary.json`.
- Capability scan found no arbitrary script, URL, fetch, cookie, credential, broad-origin, or external-provider path; the matches were the explicit sensitive-key deny lists only.
- `git diff --check` passed in the verification harness; the final post-report check is recorded in the ledger.

The independent-review findings are resolved within Task 5's local synthetic boundary. Production Chrome installation, a real portal adapter, real credentials, and Tasks 6–7 remain intentionally excluded.

## Final re-review fix round

The three remaining findings in the final re-review of `0b9d810..cafbfff` were reproduced before production edits and resolved:

- Every gesture now carries a native-generated operation identifier and bounded TTL derived once from the trusted execution deadline. Native transport sends explicit cancellation on deadline or abort; background tracks cancellation even while document binding is suspended; content pins the exact operation and checks its locally measured monotonic expiry, active binding, and document identity synchronously immediately before `click()`. A cancelled, expired, handed-off, replayed, or late framed commit cannot click.
- Each compiled content-document instance creates a random document identity. Background pins operation prepare/commit/cancel to that exact identity, while a fresh document can acknowledge revocation without acquiring authority. Content retains a bounded retired-binding set, so an old delayed bind cannot revive a revoked epoch or block activation of the next epoch.
- Native exchange timeout and close now race the entire exchange, including a stalled writable callback. The response rejection has a consumer before any await; timeout, EOF, write failure, and close promptly settle public callers with fixed errors; late callbacks and stream errors remain consumed without leaking provider text or terminating the process.

### Final re-review TDD evidence

The accepted RED reproductions were: an aborted fence passing its returned final guard and clicking; compiled framed commits clicking after deadline or abort; a fresh compiled document rejecting revoke; an old delayed bind reactivating a retired epoch; and a held native write producing an unhandled timeout while public inspect remained pending after close. An additional RED proved that cancellation arriving while background awaited `document.bind` was not acknowledged. Each focused regression passed after its corresponding minimal change.

Final evidence for this round:

- Timing-sensitive repetition gate: 10 runs of 7 deadline, cancellation, navigation, and stalled-writer regressions; 70 passed, 0 failed.
- Focused browser plus Task 4 compatibility gate: 129 passed, 0 failed, 0 skipped.
- Full `npm test`: 786 tests; 784 passed, 0 failed, 2 environment-dependent skips.
- `npm run verify`: all five steps passed with identical before/after source fingerprint `c51abf269fb0145e645faf24095d9308aec1d462295a73f0e570b8643753ab2c`.
- Verification evidence: `data/verification/2026-09-21T13-57-20.440Z-fbbf9799-07e3-4c6a-9f0d-2f179b570bc4/summary.json`.
- All demos reported zero real external effects; applicable demos reported replay equality. No arbitrary script, URL, fetch, cookie, credential, broad-origin, real portal, or Tasks 6–7 integration was introduced.

## Final re-review round 3

The final round-2 review narrowed R1 to the background-to-content delivery hop and supplied an exact synthetic-booking reproduction. The reproduction failed before production edits: prepare delivery rebased the TTL, background removed the pending operation before awaiting commit delivery, cancellation was rejected during that await, and releasing the held commit after the trusted deadline changed provider state from `booking_review` to `confirmation`.

The final boundary now behaves as follows:

- Native transport creates one absolute monotonic `operationExpiresAt`. Background and content validate and compare that same value using their monotonic epoch clocks; neither receiver restarts a relative TTL. Delayed prepare and commit delivery therefore cannot extend authority.
- Background retains explicit binding, preparing, prepared, committing, cancelled, and settled operation states until content settlement. Cancellation can overtake a held prepare or commit; content checks exact binding/document/operation/expiry immediately before mutation. A completed mutation is recorded as `gesture.settled`, so a later cancel or late acknowledgement reports the already-linearized outcome without corrupting the channel or authorizing a retry. The installed background dispatcher suppresses only the obsolete superseded completion while preserving disconnect-on-fatal-validation behavior.
- The exact framed native/background/compiled-content reproduction now acknowledges cancellation, releases the held post-deadline commit with a fixed rejection, records zero booking mutations, leaves authoritative state at `booking_review`, and then completes acknowledged shutdown on the same native channel.
- A separate compiled regression proves delayed prepare delivery plus a commit held past the original absolute expiry is rejected with zero clicks even without relying on cancellation delivery.
- A final installed-dispatcher review exposed the revoke-only form of the same race: acknowledged handoff suppressed the obsolete background completion but left the native commit exchange pending. Successful revoke now rejects every outstanding old-binding exchange with the existing typed nonfatal cancellation, releasing the native operation without failing the channel. The exact compiled-content/framed-transport regression holds a commit, revokes without explicit gesture cancellation, releases the late delivery, then resumes, inspects, and shuts down through the same port with zero clicks and zero disconnects.

The completion review also found an adjacent document-replacement edge and one exact-version omission. Both began RED and are fixed narrowly: background keeps a bounded authoritative retired-binding set, announces retired epochs to fresh documents, and issues a compensating revoke when a stale bind returns after ownership changes. A delayed bind delivered to replacement document B after revoke on document A can no longer block fresh activation. `document.bound` now requires protocol version 1.

Final round-3 evidence:

- New timing/replacement/version regression gate: 5 tests repeated 10 times; 50 passed, 0 failed. The final revoke-only channel-reuse regression also passed 10 consecutive repetitions.
- Focused browser plus Task 4 compatibility gate: 135 passed, 0 failed, 0 skipped.
- Full `npm test`: 792 tests; 790 passed, 0 failed, 2 environment-dependent skips.
- `npm run verify`: all five steps passed with identical before/after source fingerprint `881c44763963086a1b56cacea71370fa3d0253f2281fe3704e640bc51e85886a`.
- Verification evidence: `data/verification/2026-09-21T14-37-29.117Z-84a84662-3bce-41fe-a656-51d5d895e49d/summary.json`.
- Every demo again reported zero real external effects. The extension permissions and fixed capabilities remain unchanged; no real portal, credential, arbitrary network/script, or Tasks 6–7 path was added.

## Final re-review round 4 — cancellation acknowledgement ordering

The remaining P2/R4 in the independent round-3 review was reproduced against
`0b083b4` before production edits. The regression uses `BrowserSession`, real
little-endian native framing and transport, the installed background dispatcher,
the manifest's compiled content listener, and authoritative `SyntheticPortalState`.
It starts from a genuinely available slot, records durable intent, and selects the
slot before attempting booking. Content applies cancellation while its response
is held; releasing the previously held commit first produces the expected safe
content rejection but caused one native disconnect in the RED run.

Background now retains the exact cancellation-completion promise on the pending
operation. The concurrent commit continuation waits for that promise before
classifying its content result. Only a fully validated `gesture.cancelled` outcome
supersedes the obsolete completion; a validated `gesture.settled` preserves the
already-executed result. Failed or malformed acknowledgements remain fatal, and
missing acknowledgement remains bounded by the existing native exchange timeout.
No authority is inferred merely from having requested cancellation. The absolute
expiry, content's synchronous final guard, and all document/epoch checks are unchanged.

Five parameterized full-boundary regressions cover the held cancelled, failed,
malformed, timed-out, and already-settled acknowledgement orderings. All began RED
at premature commit completion/disconnect and passed after the scoped change.
The successful cancellation case proves zero clicks and provider mutations, one
public request settlement, no stale native result, exactly one cancellation reply,
zero disconnects, then inspect, handoff, resume, inspect, and acknowledged shutdown
on the same transport. The inverse successful-mutation case proves one booking,
`gesture.settled`, one result, no retry, and subsequent same-port inspect/handoff.
The failure cases prove no false cancellation success and no subsequent operation
on a failed transport; a late timeout acknowledgement causes no additional mutation
or public settlement.

Round-4 evidence:

- Focused browser plus service/runtime/Task 4 compatibility gate: **140 passed, 0 failed, 0 skipped**.
- Nine cancellation/expiry/revoke/settled ordering regressions repeated ten times: **90 passed, 0 failed**.
- Full `npm test`: **797 tests; 795 passed, 0 failed, 2 skipped**. The skips are the foreign-owned POSIX directory fixture unavailable in this filesystem and the Windows-only protected model-state refusal case.
- `npm run verify`: all five steps passed; its full suite also reports **795 passed, 0 failed, 2 skipped**. All demos report zero real external effects; applicable demos report replay equality.
- Inspected terminal evidence: `data/verification/2026-09-21T14-50-07.134Z-a189a768-c814-4715-8852-ead760bf892d/summary.json`; unchanged before/after fingerprint `7fc91441ed7464aef2d0d245ce831213d636167ed7dcc62ddc611a172a6dd703`.
- `git diff --check` passed after production/test edits and after this report/ledger update.
- Only production change: `extension/background.ts`. The added tests are in `tests/browser-extension-e2e.test.mjs`. Permissions, protocol envelopes, native expiry, content mutation authority, and Tasks 6–7 remain unchanged.

No remaining issue is known from this scoped implementation/self-review. This is
local synthetic evidence, not installed Chrome, live-provider, or hosted-CI evidence.
