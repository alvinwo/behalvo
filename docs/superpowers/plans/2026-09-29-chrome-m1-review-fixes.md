# Chrome M1 review fixes implementation plan

> **For agentic workers:** Use superpowers:executing-plans for sequential inline execution when independent worker tools are unavailable. Keep review gates pending rather than self-certifying.

**Goal:** Correct the supported PR #12 installation and lifecycle findings without expanding M1 authority.

**Architecture:** Retain one local diagnostic service, the existing private-profile lease, explicit one-use enrollment, and the framed relay. Correct failure propagation and ownership checks at their existing boundaries; do not introduce reconnect or recovery authority.

**Tech Stack:** TypeScript, Node.js 22.19+/24, Node test runner, existing GitHub Actions verification.

**Spec:** `docs/superpowers/plans/2026-09-27-installed-chrome-bridge-m1.md`; the applicable lifecycle/security sections of `docs/superpowers/specs/2026-09-25-installed-chrome-bridge-design.md`.

## Global constraints

- Starting head: `19b5551d3304cb20c3a9546723a06e72c4328289`; base: `09b99e6b9464b0765a7fa1bc517c34ea47cce405`.
- Work only on `feat/installed-chrome-bridge`; preserve ancestry and do not force-push.
- Synthetic data and one read-only diagnostic only. No live portal, secrets, booking, automatic reconnect, or M3 recovery.
- Observe an expected failing behavior test before each production correction; verify focused and full regressions afterward.
- Keep PR #12 draft. Separate Sol-high/Astra-high final reviews and owner-laptop acceptance remain required.
- This runtime has no checkout and direct network access failed. Use connected source reads and existing hosted CI for RED/GREEN evidence; do not claim a local full-suite run. An attempted scratch-workspace workflow write was blocked and that approach was abandoned; no snapshot workflow was published.

## Review focus

- Previously absent dedicated profile: setup must create its exact native-host directory, never bless an unrelated location.
- Channel loss after inspection: later normal Chrome exit must not turn the failed run into success.
- Cleanup before launch or after partial shutdown: release custody only with the correct lifecycle evidence.
- Stalled input/peers: deadline and shutdown must terminate owned physical I/O rather than wait for cooperation.
- Changed dependency bytes, dangling Singleton entries, and process signals: fail closed without deleting profile data or exposing secret values.

## Task 1 — installation boundaries (R1, R6, R7)

Files: `src/browser/installation.ts`, existing installation callers/fixtures in `tests/`, and `tests/chrome-installation-review.test.mjs`.

Keep `stageChromeBridgeInstallation`, `finalizeChromeBridgeInstallation`, `doctorChromeBridgeInstallation`, and `removeChromeBridgeInstallation` as the public operations.

- [ ] Add and observe R1 failures for a fresh nested `chrome-profile/NativeMessagingHosts` location and rejection of an unrelated directory.
- [ ] Derive/check the dedicated registration location, create it after the private profile, and migrate synthetic fixtures to that layout. Doctor must not report an unrelated registration as healthy.
- [ ] Add and observe R6 failures for dangling `SingletonLock`, `SingletonCookie`, and `SingletonSocket`; use no-follow entry detection before removal.
- [ ] Add and observe R7 failures for an imported compiled helper changing while the broker entry stays unchanged; pin the executable dependency bundle and keep explicit stale-install removal possible.
- [ ] Verify and publish each meaningful correction, retaining exact CI evidence.

## Task 2 — coordinator lifecycle (R2, R3)

Files: `src/browser/coordinator.ts`, `tests/browser-coordinator.test.mjs`.

- [ ] Reproduce transport failure after successful inspection, pre-Chrome startup failure, and unsuccessful service/bridge cleanup.
- [ ] Observe transport completion throughout enrollment and the enrolled wait. Stop admission and enter cleanup on channel failure.
- [ ] Distinguish Chrome-never-launched from Chrome-exit-unconfirmed. Require service/bridge shutdown and idle-profile evidence before custody release.
- [ ] Verify focused regressions and publish a verified correction.

## Task 3 — bounded owned I/O teardown (R4, R5)

Files: `src/browser/native-broker.ts`, `src/browser/rendezvous.ts`, and corresponding broker/rendezvous tests.

- [ ] Add subprocess regressions for incomplete native input and an uncooperative pre-enrollment socket; observe expected bounded-exit failures.
- [ ] Cancel/destroy owned pending reads on broker failure. Track and close all accepted rendezvous sockets, including unauthenticated clients.
- [ ] Preserve one physical reader, bounded framing, one-use enrollment, fixed errors, and no reconnect.
- [ ] Verify and publish the corrections.

## Task 4 — signal cleanup and final evidence (R8)

Files: `src/cli/browser-main.ts`, `src/browser/coordinator.ts`, relevant CLI/coordinator tests, `RESUME.md`, and a verification record.

- [ ] Reproduce SIGINT/SIGTERM during enrollment and after inspection with a still-open synthetic Chrome process.
- [ ] Route signals through one idempotent bounded shutdown path. Retain custody if Chrome exit remains unconfirmed and report a fixed cleanup-pending outcome.
- [ ] Verify storage-key cleanup and no secret-value output on cancellation paths.
- [ ] Require `npm run verify` on exact final head in hosted Node 22.19 and Node 24; inspect terminal results and retained logs.
- [ ] Update handoff with exact head/tree, observed evidence, remaining gates, and next action. Leave final independent review and real-Chrome acceptance pending unless actually performed.
