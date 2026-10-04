# Playwright browser adapter — proposed design

Status: owner LGTM and independent architecture/design approval on 2026-10-03.
The owner authorized P1 implementation after those reviews cleared.
Architecture: gpt-6-astra/max; design/security: gpt-5.6-sol/high, independent
non-implementer contexts. Focused review cleared the revised lifecycle, cancellation,
request fencing and leakage-test contracts. This is design approval, not code acceptance.

## Purpose and success criteria

Replace manual extension installation and timed enrollment in the next synthetic
browser milestone with an application-owned Playwright browser. The owner asked
for an established browser-control solution after the installed-extension path
proved difficult to operate. Success is one command that opens a visible isolated
browser, inspects the synthetic page through Behalvo, reports a validated result,
and shuts down without manual browser or file operations.

Preserve the provider-neutral kernel, modular monolith, journal, deterministic
reduction, approval boundaries, and unknown-effect handling. This proposal changes
the browser integration choice; it does not authorize live accounts or effects.
It supersedes the extension-only/no-browser-driver constraint for this proposed
path. The old extension path remains separate and is not silently substituted.

## Evidence and alternatives

A throwaway local probe on 2026-10-03 used Playwright 1.63.0 and installed Chrome
154.0.8037.93 at source head 634c7910bf85a74bd83f089e72e199ec06a0d32c.
Both tests passed: normal browser shutdown, and forced browser death during a
pending DOM read. Existing BrowserSession recognized and inspected the actual
synthetic login page. Normal exit was code 0; the forced crash rejected the pending
read and a subsequent read. Playwright removed the temporary profiles in both
cases. No non-GET page requests were observed. A fixture omission in the first
run was corrected before the passing run; no product code was changed.

Raw evidence is local and ignored by Git:
`data/verification/playwright-spike-2026-10-03/`. The probe used launchServer and
an adapter-local tab handle, a login-only parser, and a worker-release fixture.
It did not test durable service integration, gestures, human handoff, or real sites.
It must not be promoted unchanged into production.

Alternatives considered:

- Playwright: recommended. Fits the TypeScript application and existing transport
  interface, supplies DOM inspection and browser lifecycle control.
- A higher-level browser agent framework: defer. Another planning/execution loop
  would need to be constrained by Behalvo's existing authority and journal rules;
  it is unnecessary for proving browser transport.
- Screenshot-driven desktop control: defer. Useful for non-browser applications,
  but requires desktop focus, visual interpretation, and a different executor.
- Custom extension: retain as historical implementation. Installed acceptance is
  incomplete, and no further manual enrollment attempts are part of this milestone.

## Milestones and explicit limits

**P1: implemented read-only diagnostic**, the scope of the first implementation
plan. Launch, inspect the synthetic login state, report, and stop. No approval,
booking, calendar mutation, arbitrary navigation, model-generated script, or
unattended scheduling is enabled. `gesture` always rejects before dispatch.

**P2: authorized synthetic actions**, a subsequent design and plan. Reuse existing
service composition through SyntheticMonitoringBrowserFactory; demonstrate each
operation's final authorization fence, reservation/intent ordering, cancellation,
unknown outcome, handoff, and readback before enabling it. P1 success does not
approve P2 implementation or establish those guarantees.

General website browsing, real visa portals, stored logins, remote/cloud browsers,
paid services, and arbitrary model-to-Playwright access are outside both P1 and
this design's implementation authorization.

## P1 components and ownership

1. A Playwright browser owner launches exactly one visible browser with a fresh
   temporary profile and one private context/page. It records only owned resources
   and exposes bounded close and terminal failure. It never attaches to an existing
   browser, accepts a remote endpoint, or discovers everyday profiles.
2. A read-only transport implements BrowserSessionTransport. Playwright objects
   remain private to it; callers receive typed snapshots, never a Page, locator,
   browser endpoint, raw DOM, or arbitrary evaluation interface.
3. A diagnostic coordinator starts the existing synthetic portal and uses the
   existing BrowserSession with an isolated registry and fresh generation values.
   It owns no monitoring worker, grant, model run, or domain mutation. Its
   releaseWorker callback represents that explicitly empty worker ownership;
   it must not impersonate a durable worker release or claim journal acceptance.
4. An explicit diagnostic CLI command wires those components. Existing service,
   extension CLI, and normal agent defaults are unchanged. Proposed command:
   `npm run browser:playwright -- diagnostic`. No user-provided URLs, browser args,
   profiles, selectors, scripts, or remote endpoints are accepted.

Use Playwright 1.63.0 as the initial exact package pin with a lockfile. Prefer
Playwright's matching Chromium build for the reproducible product test baseline,
with a documented one-time explicit browser install. P1 uses
`chromium.launchServer` with host `127.0.0.1`, an ephemeral port and generated
unguessable path. Only the owning process connects to its own returned endpoint;
no endpoint option, discovery, logging or remote browser is exposed. Same-UID
processes remain inside the local trust boundary. This replaces the initial
direct-launch proposal: the public BrowserServer API supplies exact process
ownership and termination, which direct Browser does not expose. Retain only that
returned ChildProcess and its own single `--user-data-dir` spawn argument for
profile evidence; never scan other processes or use private Playwright fields.
The matched Chromium build requires new tests, not inference from the Chrome probe.

Reject ambient Selenium remote routing, Playwright browser/platform overrides,
and protocol/debug logging before loading Playwright. Do not pass ambient
credentials, proxies or arbitrary browser environment to the launched browser.
Use a minimal platform environment and fixed launch options. Preflight the matched
executable; absent browsers produce a fixed installation instruction without download.

An explicit fixed `chrome` channel may be offered only after the same acceptance
passes on installed Chrome. It must use Playwright's fresh profile, not the owner's
normal Chrome profile. Chrome upgrades must not require editing an installation
hash manifest or reloading an extension. Record actual versions in diagnostics;
fail normally on incompatibility. Dependency/browser upgrades remain explicit.

## Observation and session bindings

The fixed page origin is `http://127.0.0.1:43117`, with exactly one owned page.
Install context-wide routing before creating/navigating the page: allow only GET
of exactly `http://127.0.0.1:43117/`, with no query or fragment, from the owned main
frame. Deny every other method/path/origin before network dispatch, including the
existing synthetic POST mutation endpoints. Block service workers, WebSockets,
downloads, unexpected popups, subframes and off-origin navigation. Browser background
traffic is not claimed to be a complete OS network sandbox.

The adapter assigns a positive internal tab handle scoped to its generation; it
is not a Chrome extension tab ID. Bind it to the exact owned Page object. A main
frame navigation creates a new adapter-owned document identity and invalidates
any read that began in the old document. Unexpected origin, page closure, browser
disconnect, or protocol mismatch makes the run terminal; no replacement tab,
reconnection, or automatic read retry is performed.

Validate request origin, profile, service and connection generations, epoch, tab,
and sequence. Bind the first accepted epoch from the trusted session, never from
a page. Reads recheck identity and lifecycle before and after asynchronous work.
Return only the strict BrowserResponse envelope, with the actual observed state.
P1 recognizes and inspects only the synthetic login contract. Missing or changed
markup fails closed; do not return a fabricated login state. Other states remain
unsupported until their parser and policy tests exist.

Keep BrowserSession's checks rather than bypassing them with direct coordinator
DOM reads. Refactoring shared pure page-contract parsing is permitted only when
necessary and separately covered by existing extension and adapter regressions.
Do not build a general parser framework for P1.

## Failure, cancellation, and cleanup

Observe Playwright page/context/browser termination and stop admitting reads
immediately. A pending read must settle with a fixed typed error within the
configured deadline. The coordinator owns cancellation and deadlines across
portal start, browser setup, session observations and cleanup. BrowserSession's
existing inspect interface carries no AbortSignal, so coordinator cancellation
must immediately invalidate the session and stop transport reads; post-read fence
checks alone do not interrupt a pending read. Bound setup/launch to 15 seconds,
each observation to 10 seconds, and total shutdown (including portal) to 5 seconds.
The CLI is the sole signal owner; disable Playwright's SIGINT/SIGTERM/SIGHUP
handlers. SIGINT and SIGTERM use the same bounded shutdown path, including signals
while launch is pending. Observe late promise
settlement and close late-created resources; never permit a late result or launch
to restore authority. Cancellation before launch starts no browser.

A valid snapshot is not overall success until cleanup is confirmed. Require the
owned process exit, BrowserServer closure and absence of its exact temporary
profile, since Playwright can log and suppress profile-removal errors; do not equate nonempty Chrome
stderr with failure, or an elapsed timeout with successful termination. Capture
only fixed diagnostic categories. Never dump browser stderr, page content, local
secrets, endpoints, or arbitrary exception messages to application logs.

Attempt graceful close first. If shutdown exceeds its bound, report cleanup
pending and preserve the owned temporary profile path and relevant lifecycle
metadata. Force termination is limited to the exact process tree owned by this
launch through BrowserServer.kill() when that identity is available; lack of such identity is not permission
to kill by application name. No broad process search/kill or Singleton deletion.
An unconfirmed close must not produce a successful diagnostic or immediate retry.
Use one shutdown promise and split its 5-second total budget between graceful
close and owned escalation; repeated close callers observe the same result.

Before launch, persist a private operational receipt with a fresh run identity and
fixed phase (not domain state). If launch fails or times out before BrowserServer
returns, record cleanup pending and profile path unavailable. No global temporary
folder search or invented ownership is allowed. A late returned handle is closed
immediately without connection/inspection. Bounded CLI exit can outlive the late
handler: record that cleanup is then unconfirmed; process exit hooks are only best
effort. P1 does not guarantee identification/termination of a process whose launch
never returned a handle. This limitation makes that run a failure, never success.
Keep the receipt on failure; report only its generated local path and fixed codes.

P1 uses disposable isolated state, not the existing persistent synthetic lease.
Do not reuse, delete, or recover the previous extension profiles as part of P1.
Any leftover resources from a failed new run remain distinguishable from those
old profiles. Cleanup must not be implemented by recursively deleting unknown
paths. Persistent authenticated profiles require a later ownership design.

## P2 constraints retained for later design

Playwright's locator waiting/retry behavior must not become permission to repeat
an unknown effect. A future action adapter must preserve the existing authorize
callback's final guard immediately before dispatch, bind the exact document and
operation deadline, and coordinate revocation with in-flight work. A disconnect
after possible dispatch remains unknown/readback-only. A timed-out Playwright
promise does not prove nonexecution. Page actions cannot journal results or arm
grants on their own. No claim is made that replacing transport automatically
preserves these semantics; P2 requires independent security review and adversarial
behavior tests before it is operational.

## Required P1 acceptance

Write behavior tests before executable implementation. Cover:

- Real visible browser launch in a fresh owned profile, actual DOM observation
  through BrowserSession, validated login response, graceful close, and cleanup.
- Missing/changed page contract; wrong origin/tab/epoch/generation/sequence;
  navigation during a pending read; popups and off-origin redirects.
- Browser crash during a pending read; later reads rejected without reconnection.
- Cancellation before launch, during launch (including late settlement) and during read; repeated close; close timeout and
  cleanup-pending evidence; signal-driven shutdown without affecting other browsers.
- All gesture requests rejected without browser mutation; attempted POST and
  off-origin requests never reach or mutate the synthetic portal, not merely zero
  non-GET in the happy path; no model, account, or credential access.
- Inject canaries in Playwright exceptions, browser stderr, page DOM and endpoint;
  assert only fixed CLI/log codes and the private receipt's allowlisted schema,
  with none of the canaries, raw errors, content or endpoints retained.
- Browser dependency absent: actionable fixed error, no silent download or fallback.
- One command completes without enrollment, extension installation, or manual quit.

Run focused tests, `npm run verify`, and a real macOS acceptance on the final code
head. Record exact source head, Playwright/browser versions, scenario results,
cleanup evidence, and limitations. Linux CI may run headless checks, but they do
not replace visible macOS acceptance. Update the implementation status only when
P1 is operational. Obtain the repository-required independent reviews; existing
extension reviews do not approve this new transport.

## Replacement PR integration

On 2026-10-03 the owner authorized a new current-work PR and closure of stale
PR #12. The replacement branch `codex/playwright-p1` starts directly at master
`09b99e6`; it carries only P1 files and depends on BrowserSession and the synthetic
portal already on master. It excludes PR #12's extension enrollment, installer,
native broker, rendezvous, coordinator, CLI and custody changes. The original
`codex/playwright-browser-adapter` and `feat/installed-chrome-bridge` branches
preserve the work and historical evidence. Fresh verification and focused reviews
must establish this new base before publishing. No merge is authorized.

## Historical branch and release handling

Design branch: `codex/playwright-browser-adapter`, based on `634c791`.
The `feat/installed-chrome-bridge` branch and draft PR #12 are preserved. This is
currently a stacked branch, not an independent diff from master. Before a later
PR, determine which prerequisites should land or be carried forward; do not
silently merge the incomplete extension milestone. No push, new PR, merge,
installation migration, or cleanup of the old profiles is part of this design.

## References

- [Existing architecture](2026-09-07-architecture-v0.md)
- [Superseded installed Chrome PR](https://github.com/alvinwo/behalvo/pull/12)
- [Playwright browser support](https://playwright.dev/docs/browsers)
- [Playwright browser lifecycle API](https://playwright.dev/docs/api/class-browserserver)
- [Development workflow](../../../.agents/skills/behalvo-development/SKILL.md)
