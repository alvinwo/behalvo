# Playwright P2 — architecture checkpoint

Status: draft research checkpoint. Not approved for implementation. No P2
executable changes or acceptance claims are included. Base: merged P1 `6b6ef82`.

## Intended outcome

Demonstrate authorized synthetic scheduling actions in a fresh application-owned
browser through `SyntheticMonitoringBrowserFactory` and the existing
`BrowserSession`, monitoring service, journal and worker. Retain the fixed
`http://127.0.0.1:43117` origin, typed commands, disposable profile ownership and
bounded cleanup. No real accounts, arbitrary browser tools or model-controlled
selectors/scripts are introduced. The read-only P1 command retains its boundary.

## Decisions to validate

Use a separate synthetic action transport. Fixed DOM form activation should
produce a browser POST intercepted by the application. A single-use permit must
bind its exact command/body, Page, main frame, source document, epoch, sequence
and operation deadline. Check authorization in the route, immediately before
the sole outbound dispatch, not only before a Playwright click. Disable network
retries and redirect following for that dispatch. Direct calls to the portal's
`/api/gesture` endpoint would bypass the intended browser acceptance boundary.

The first implementation task must be a failing real-browser contract test for
the pinned Playwright build: trusted fixed DOM activation with page JavaScript
disabled, exact source-document attribution, single intercepted POST, and the
expected 303-to-root navigation. Do not enable actions if those assumptions fail.
This is a proposed approach, not verified Playwright behavior.

The existing async authorization callback returns a synchronous guard that checks
epoch, signal and deadline (`src/browser/session.ts`). It does not itself perform
a new durable grant/work-state check. The full design must resolve whether a
narrow synchronous trusted-fence hook is required at dispatch. Include a regression
that changes durable authority between async preflight and outbound dispatch;
revocation must prevent the request from reaching the portal. Do not claim that
an earlier async check eliminates this race.

## Lifecycle and uncertainty

Preserve durable reservation and encrypted intent ordering before any booking
submission. A timeout after possible dispatch is unknown, never evidence of
nonexecution; no automatic resubmission or late journal write is allowed.
Reconciliation must use authoritative readback.

Same-run handoff/resume must retire the old epoch and use fresh read-only preflight
for the candidate epoch (existing service sequence 1/2). A fresh transport must
not claim that an old service generation's browser was retired without exact
owned-resource evidence. Initial scope should cover same-run handoff and clean
service restart under one synthetic acceptance supervisor. Crash recovery must
remain fail-closed unless a separate ownership proof is designed and tested.

## Next work

1. Finish the design against the actual transport, portal and service interfaces;
   resolve the dispatch-hook and historical-resource retirement questions.
2. Write a bounded implementation plan with behavior tests first: feasibility,
   strict DOM observations and commands, authorization/unknown semantics,
   service composition and lifecycle, then visible synthetic acceptance.
3. Obtain independent specialist design/security approval and address findings.
4. Implement only the approved scope. Run the repository verification gates and
   real visible browser acceptance, then independent code reviews before merge.

The owner delegates technical review and merge/revise decisions to specialists;
the owner is not expected to perform code reviews. Product-scope changes still
require owner direction.

## Evidence and routing

Architecture research: `gpt-6-astra`, max, reused architecture context; no fix
retries. Source tracing identified the route-dispatch authority gap and restart
ownership constraint. Primary recorded this checkpoint from that research.
The full design/plan and independent approval remain pending. No executable tests
were run for this documentation checkpoint.

References: [P1 design](2026-10-03-playwright-browser-adapter-design.md),
[architecture](2026-09-07-architecture-v0.md),
[P1 verification](../../verification/2026-10-03-playwright-p1.md).
