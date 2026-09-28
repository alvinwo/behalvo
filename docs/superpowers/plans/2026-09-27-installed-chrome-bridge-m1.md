# Installed Chrome bridge M1 implementation plan

> **Reconstructed checkpoint — 2026-09-27.**
>
> The original reported plan commit (`8146aca`) and its file were not recoverable
> from the synchronized checkout, GitHub branch, or accessible project artifacts.
> This plan reconstructs the owner-approved M1 decisions recorded in `RESUME.md`
> and the surviving bridge design. It does not claim to be the missing original.

## Goal

Prove that Behalvo can be installed against a dedicated Chrome profile and complete
one explicit, owner-initiated diagnostic round trip through the real Chrome native
messaging boundary.

M1 is deliberately narrower than visa scheduling. It grants no page-command or
booking authority. Synthetic booking remains M2; failure/restart recovery remains
M3.

## Preserved constraints

- Use one local Behalvo service as domain and booking authority; the native broker
  is only a framing relay.
- Register the native host for the exact dedicated Chrome user-data directory used
  by setup/run/doctor. Never select or mutate an everyday Chrome profile.
- Enrollment is explicit. Extension startup must not automatically connect the
  native host.
- Only the extension popup may initiate enrollment. The popup may provide only the
  one-use enrollment value.
- Background code discovers candidate tabs through Chrome APIs and accepts exactly
  one non-incognito tab at the fixed synthetic portal root. Pages and popup input
  cannot provide tab IDs, URLs, origins, native-host tokens, or browser commands.
- Enrollment states are explicit: `disconnected`, `enrolling`, `enrolled`,
  and `invalidated`. Native-port loss invalidates the current run rather than
  silently reconnecting.
- Setup refuses conflicting generated/registration files. Doctor is read-only.
  Removal is narrow: retain the profile, provider/service evidence, unknown files,
  and unknown directories including empty directories.
- Reuse existing private-profile validation/custody primitives. Do not introduce a
  second lock scheme.
- The broker uses strict bounded framing, fixed safe public errors, explicit
  cleanup, and no ambient secret/token transport.
- Never automatically retry an uncertain submission. Diagnostic M1 performs no
  booking mutation and does not solve old-tab handoff recovery.
- Use synthetic data only.

## Task 1 — explicit extension enrollment

### Behavior first

Add focused extension tests that initially fail and prove:

1. importing/starting the background does **not** call `chrome.runtime.connectNative`;
2. popup-initiated enrollment is the only path that can open the native port;
3. state transitions are `disconnected -> enrolling -> enrolled` on acceptance;
4. rejection/disconnect transitions to `invalidated` and does not reconnect;
5. background queries Chrome tabs itself, excludes incognito/wrong-origin tabs, and
   requires exactly one allowed candidate;
6. popup/page messages cannot choose tab ID, URL/origin, native capability, or a
   browser command;
7. the enrollment value is sent only in the native enrollment message and is not
   forwarded to a content script/page or persisted in extension storage;
8. status payload fields are strictly typed and reject malformed values.

### Implementation

Refactor the existing background controller around an explicit enrollment request.
Add the smallest popup surface/protocol required by the tests. Preserve the
existing post-enrollment browser protocol unchanged where possible.

### Verification and checkpoint

Run the focused extension/browser protocol suite, then the relevant build/typecheck.
Commit the verified Task 1 implementation separately and request focused independent
review before Task 2. Fix only supported findings and re-run the affected tests.

## Task 2 — installer and synthetic profile custody

### Behavior first

Add focused installer/custody tests that initially fail and prove:

1. setup stages a reviewed compiled extension and dedicated synthetic profile under
   a validated private canonical root;
2. finalization records the exact 32-character extension ID and current-user native
   host registration for the same dedicated profile/install metadata;
3. conflicting existing registration/generated files fail closed while exact
   repeated setup is idempotent;
4. doctor performs only reads and reports registration/configuration separately
   from an observed Chrome handshake;
5. launcher execution uses the absolute Node binary and compiled broker entry point,
   safely quotes paths, uses no `npm`, and is exercised as a separate process;
6. remove deletes only enumerated exact matching bridge-generated artifacts and
   retains profile contents, unknown files, and unknown directories, including
   unknown empty directories;
7. existing profile custody and Chrome Singleton checks are reused and conflicting
   ownership/recovery fails closed.

### Implementation

Add narrow installation/doctor/remove utilities and a synthetic profile-lease
wrapper over the existing custody primitives. Keep install metadata explicit and
bounded. No live portal or real account access is introduced.

### Verification and checkpoint

Run focused installer/custody tests plus regressions for the existing private
connection boundary. Commit separately, then perform focused independent review.

## Task 3 — native broker and diagnostic command

### Behavior first

Add separate-process broker/IPC tests that initially fail and prove:

- strict enrollment hello bindings and one-use capability consumption;
- exact extension origin, installation/run/service generation, tab, and fixed
  synthetic origin checks;
- 64 KiB outer framing, existing 32 KiB browser frame bound, invalid UTF-8,
  truncation, overflow, wrong channel, and broken-pipe failure;
- one physical reader per stream so coalesced frames are not lost;
- one enrolled channel per run and fail-stop behavior on channel loss;
- no broker database/grant/page-selection authority;
- diagnostic round trip only; no booking/page mutation authority;
- cleanup removes only exact owned runtime artifacts and does not delete the
  Chrome profile.

### Implementation

Add the Chrome-launched native broker, private IPC/enrollment adapter, coordinator,
and the explicitly synthetic browser CLI. The coordinator owns portal/service/
Chrome lifecycle and calls `startLocalService` exactly once. The broker remains
a relay.

### M1 laptop acceptance

After reviewed code exists, the owner-laptop acceptance must separately demonstrate:

1. installed Chrome loads the staged extension in the dedicated profile;
2. explicit popup enrollment launches the registered native host;
3. the background-selected real tab completes one diagnostic round trip;
4. navigation/document fencing remains enforced;
5. native-host failure is visible and a later explicit rerun requires fresh
   enrollment;
6. clean Chrome close releases runtime state without deleting the profile.

Fake-Chrome/Linux tests are not evidence for these laptop checks.

## Commit, publication, and review workflow

For every behavior task:

1. add the behavior test first and observe the expected RED result;
2. implement only the scoped behavior;
3. run focused regressions and record only observed evidence;
4. commit the meaningful verified change;
5. push/publish the checkpoint and verify the remote tree;
6. perform focused independent task review when reviewer contexts are available.

Before merge, inspect the complete branch diff against `master`, run
`npm run verify` on POSIX, retain its terminal summary/raw logs, and verify the
exact HEAD/tree. Then require hosted Node 22.19 and Node 24 CI.

This is high-risk browser/security work. Final merge requires independent
`gpt-5.6-sol` high and `gpt-6-astra` high review contexts. If either reviewer
is unavailable, keep the review gate pending and do not merge.

## Definition of done for M1

M1 is complete only when the reviewed branch is merged and the separate owner-laptop
acceptance above has passed. Completion proves an installed synthetic Chrome
diagnostic bridge only. It does not claim live visa portal compatibility, booking
authority, credential readiness, Keychain/signing readiness, or autonomous visa
scheduling.
