# Supervised managed browser

Status: approved by the delegated architecture reviewer for implementation.
Date: 2026-10-11.

## Intent and finish line

The owner wants a browser the agent can actually use on ordinary websites, without
requiring a developer to encode each site's workflow. It must retain a manually
authenticated session across owner turns and preserve Behalvo's task, evidence,
approval, and unknown-outcome boundaries. This follows the approved harness and
continuity work. The existing synthetic adapters and vault flow remain regression
fixtures, not the implementation of general browsing.

Deliver a visible, isolated, locally managed Chromium browser in the normal agent
CLI. The owner chooses a starting HTTPS URL and exact additional origins. The
model explores current semantic controls; the owner supervises each proposed
gesture. JavaScript, ordinary resources, same-origin redirects, and fetch/XHR work
without site-specific selectors or request-path policies. Manual login/challenge
handoff retains the same temporary browser. The owner can resume model observation
afterward. No real account, booking, or sensitive owner data is used in tests or
acceptance.

This is supervised general browsing, not unattended booking or a guarantee that
all sites work. An arbitrary page's visible contents may be private and will be
sent to the selected model and retained as task evidence. The general adapter does
not borrow vault credentials or promise that a malicious website cannot reflect a
manually entered secret into visible page text. The existing synthetic vault
secret-output guarantee must not be advertised for arbitrary live pages.

## Research and choice

Official sources inspected on 2026-10-11:

- [OpenClaw browser](https://docs.openclaw.ai/tools/browser) separates an agent's
  managed profile from the owner's daily browser.
- [OpenClaw browser tools](https://docs.openclaw.ai/tools/browser/agent-tools)
  use current snapshots and captured references, returning fresh state after
  navigation. Behalvo adopts that interaction pattern without exposing selectors
  or arbitrary evaluation.
- [Hermes browser](https://hermes-agent.nousresearch.com/docs/user-guide/features/browser)
  supports separate browser sessions and a headed mode that keeps the window and
  login state between turns for human intervention. Behalvo adopts scoped
  lifetime and explicit handoff, not real-profile import or cloud services.
- [Playwright network](https://playwright.dev/docs/network) supports context-wide
  request routing and WebSocket routing; its documentation calls out service
  workers as a route-interception gap. Service workers remain blocked here.
- [Chromium proxy behavior](https://chromium.googlesource.com/chromium/src/+/HEAD/net/docs/proxy.md)
  distinguishes proxy resolution from direct resolution and documents implicit
  loopback bypass. The network gate must account for that bypass explicitly.

Three options were considered. More compiled fixture policies do not meet the
goal. Unrestricted Playwright/CDP or model-authored scripts discard the existing
authority boundary. A managed browser with current references, owner origin
access, and supervised gestures meets the goal with one local adapter and the
existing journal-backed action lifecycle. Select the third option.

## Session lifetime and commands

`--browser live` installs the capability; startup itself opens no website.
Trusted owner commands are:

- `/browser open <https-url>`: open for the focused work and current chat. The
  command authorizes that exact initial navigation and its exact origin after
  the CLI has explained the managed-browser access scope. No model may manufacture
  this command or grant. Reject userinfo, unsupported schemes, and invalid URLs.
- `/browser allow <https-origin>`: admit one additional exact origin for the
  current browser. No wildcard or suffix matching. Show existing/blocked origins
  in status; an observed redirect or dependency never admits itself. Admit at most
  eight origins per session.
- `/browser status`: show bound work/chat, state, current sanitized location,
  allowed origins, expiry, current owner input references, and any unresolved
  gesture.
- `/browser input <input-ref> <text>`: authorize a non-secret owner value for
  one field in the latest owner descriptor catalog. Capture an exact owner source,
  derive the field purpose as specified below, and use the existing input-binding
  journal event. This command can run between turns; it does not acquire a browser
  lease, interact with the page, or disclose the value. A later fill requires a
  fresh matching control and gesture approval.
- `/browser handoff`: retire automation and let the owner operate the visible
  browser. Login and challenge controls use this path.
- `/browser resume`: explicitly return the same browser to automation after
  handoff. This acknowledges that visible page content enters model/task context.
- `/browser close`: retire automation and close the exact owned resources.
- `/browser resolve <action-id> <accepted|failed> <owner-note>`: record an explicit
  owner reconciliation of an unknown gesture, using existing reconciliation
  events. `failed` means the owner has confirmed no effect, not merely that no
  result was seen. Resolution never redispatches the command.

The controller holds at most two independent sessions keyed by workspace, owner,
thread, and work. Each owns a fresh disposable profile; cookies are shared only
between successive turns borrowing that exact session. Switching tasks/chats
never shares cookies or implicitly focuses another browser. An idle session
expires ten minutes after the last trusted owner command or borrowed owner turn;
page background traffic does not extend its lifetime. Task closure, browser
failure, explicit close, and application shutdown also retire the session.

No profile path, remote CDP endpoint, executable override, imported cookies,
personal-profile snapshot, or persisted browser attachment is accepted by the
public CLI. A restart resumes durable work and evidence, never a browser handle
or an effect. Existing owned-process receipts remain the cleanup evidence.

Separate a session's lifetime from a run's lease. A session has operational states
`idle`, `leased`, `human`, `closing`, `closed`, and `faulted`. A lease contains the
current work revision, run deadline, cancellation signal, and a fresh generation.
Only one lease may exist for that session. Every new lease clears old references
and observes current state before interaction. A teaching revision invalidates
the old lease/approval, but does not erase cookies or silently transfer the
session's origin access to another task.

Executable references and owner input references are separate namespaces. Normal
lease retirement discards every executable handle/reference. It may retain the
last observation's bounded, read-only input descriptor catalog for the owner;
the catalog contains no handles, selectors, field values, or executable commands.
Retaining this catalog does not make a retired control reference executable.

Normal turn completion retires the lease and preserves the window. Handoff also
retires the lease and all references before returning control to the owner. There
are no snapshots, model calls, or automated gestures while in `human` state.
Trusted resume checks the exact task/chat/session and current main-frame origin,
then creates a new generation and obtains fresh observation. A model may request
handoff but cannot resume it or approve an action.

Do not call lease retirement browser cleanup. Exploration results distinguish
`leaseRetired` from `sessionDisposition: retained | human | closed` and actual
`cleanupConfirmed` on closure. Final reply/progress may settle after a confirmed
lease retirement. Failed retirement faults the controller and blocks later
browser turns; it cannot be reported as retained success. Final application
shutdown still requires confirmed process exit, server closure, and profile
absence under the existing ownership contract.

## Network access

An origin access grant is permission to run that web application, including its
JavaScript and background requests, within exact owner-selected origins. It is
not a claim of read-only access. GET can mutate; POST can fetch data. Neither
method nor a page/model label determines effect permission. The access grant is
separate from permission for a model-selected gesture.

All live destinations use HTTPS. Context-wide routing checks the current grant
before every request, including redirects and subresources. Allowed same-origin
redirects work; a new origin is blocked and surfaced for a trusted owner decision.
No request body, cookie, authorization header, console output, or raw network
trace is exposed to the model or included in diagnostics. Browser request routing
does not bypass CSP or certificate validation.

Use a small per-session loopback CONNECT proxy as an application-owned network
gate. It accepts only authorities matching granted HTTPS origins, resolves the
host, rejects non-public addresses, and connects to one of those exact checked
addresses. Resolve-and-check followed by letting Chromium resolve again is not a
private-network boundary. Validate IPv4, IPv6, IPv4-mapped IPv6, all returned DNS
addresses, and literal addresses; reject loopback, private, link-local, multicast,
unspecified, documentation/reserved destinations, and local-only names. No direct
fallback is configured. Origin revocation/session closure destroys existing
tunnels as well as denying new ones. Limit a session to 32 concurrent tunnels,
2,048 routed requests, and 128 MiB of tunneled traffic in either direction
combined; connection setup has a ten-second deadline and inactive tunnels close
after sixty seconds. Reaching a limit stops access visibly without an automatic
retry. Use fixed errors; do not log tunneled data.

The Chromium composition disables implicit loopback proxy bypass and non-proxied
UDP channels, including QUIC/WebTransport. Service workers, WebSockets, downloads,
uploads/file choosers, browser permissions, and unsupported protocols are denied
in this increment. Context routing remains necessary because an existing TLS
connection may serve more than one hostname. The local controller endpoint is
never exposed as an admissible website. These are tested application/browser
boundaries, not a general OS sandbox or defense against same-UID code.

Synthetic browser tests inject resolver/dial/browser dependencies through trusted
construction seams. The production constructor always uses the public-address
policy. There is no `allow-localhost`, insecure-certificate, proxy override, or
test mode available through public CLI arguments or environment variables.

A single main tab is automated initially. Deny automatic popups. Frames may load
only through the same exact-origin network gate; model control references cover
the main document. An unsupported frame or popup flow is an explicit manual
blocker, not permission to widen scope. Manual handoff can use already admitted
frames without exposing their controls to the model.

## Observation and interaction

Generalize the semantic data contract's origin validation to canonical HTTPS
origins while preserving existing synthetic-origin records. This validator checks
data shape only; live authority comes from the controller, never from an observed
origin or a historical note. Keep compiled synthetic request policies unchanged.

The adapter exposes bounded visible text and controls using application-generated
references. It supports ordinary semantic links, buttons, text/search inputs,
selects, checkboxes, and radio controls; use native semantics and ARIA where
available. Omit password/OTP/payment and upload controls from model interaction;
unsupported or ambiguous custom controls require handoff. Never return input
values, hidden fields, cookies, raw HTML, selector strings, or script handles.
No model-provided URL, selector, JavaScript, evaluation, arbitrary key sequence,
or network request is accepted. Owner-provided opening URLs and current observed
links supply navigation targets.

Preserve the existing observation contract: at most 100 controls, 100 options per
control, and 32,768 UTF-8 bytes for the complete serialized observation. Produce
bounded snapshots within these limits. Checkbox/radio controls use the existing
`button` role and `click` action; expose their checked state in readable observation
text and owner review, and bind that state in the private descriptor fingerprint.
No checkbox/radio protocol kind or arbitrary key action is needed.

Every interaction resolves the exact current session/generation/document/
observation/control. Recheck connectedness, visibility, enabled state, semantic
identity, and relevant link/form/option properties before and after owner review
and immediately before dispatch. Document navigation or replacement invalidates
references. A fresh observation returns after every completed interaction.
JavaScript applications can still change hidden server/client state without a
visible DOM change; this design does not claim semantic immutability of a website.

Text fill uses an existing owner-sourced TaskInputBinding. For general sites the
trusted owner binds it to the current observed field and exact origin, rather
than a compiled fixture field name. The private descriptor catalog is scoped to
workspace, owner, thread, work and revision, session, document, origin, and an
owner-input epoch. A catalog entry carries an opaque `input-ref`, an owner-readable
field description, and a canonical descriptor fingerprint. Derive that fingerprint
from non-secret field semantics: element/ARIA type, accessible name, field name/id,
enabled/read-only state, relevant autocomplete, and owning form identity, method,
resolved action and target. Exclude current field values, hidden inputs, cookies,
live control refs, and lease generations.

`/browser input` validates the catalog's exact binding against the current
controller/work state. It derives a versioned purpose hash from the session,
document, origin, owner-input epoch and descriptor fingerprint; the existing
TaskInputBinding already carries workspace/work/revision and exact owner-source
provenance. Normal lease retirement preserves the catalog and epoch. A navigation
or document replacement invalidates the catalog/document identity; handoff clears
the catalog and advances the owner-input epoch. Closing the session or changing
the work revision also invalidates the catalog. Only a new observation in a valid
automation lease can publish its replacement. No raw input value enters this
operational catalog.

On a later lease, freshly observe and require exactly one eligible field with the
same session/document/origin/epoch and descriptor fingerprint. Resolve the source
value with `resolveTaskInput` using that purpose hash and current work revision.
Zero or multiple matches reject; matching across documents, sessions or handoff
epochs rejects. This is semantic field authorization, not revived node identity:
the fresh field receives a new executable reference, and all ordinary current-ref
and DOM-replacement checks still apply around review and dispatch. Changes between
owner binding and the next observation therefore disclose no value until matching
has succeeded.

Show the exact non-secret value and destination in review. The model passes only
its opaque input ID. A fill fires page handlers and therefore requires the same
gesture review as a click. Select uses only current observed options; checkbox and
radio clicks bind the current checked state. There is no model text-to-URL path.
Sensitive values are entered by the owner in human mode.

Page text remains untrusted. Browser-enabled final output may propose only
source-linked notes and advisory progress; it cannot create owner teachings,
facts, approvals, identities, or completion evidence. A claimed save must map to
an actual journaled note. Historical recall strips reusable references and
current-state claims as today.

## Gesture approval, audit, and unknown outcomes

Reuse `Action`, its immutable digest, approval, attempt identity, existing journal
events, and `SqliteStore.finishActionAttempt`. Add a versioned typed
`BrowserActionCommand` to the command union and canonical digest validation. Do
not add a second approval engine, scheduler, connection hierarchy, or mutable
browser-policy projection. Existing message and prepared-operation command
digests retain their formats.

Use this minimal discriminated shape; strict validation rejects unknown keys:

```ts
type LiveBrowserGesture =
  | { kind: 'navigate' | 'click'; observationId: string; ref: string }
  | { kind: 'fill'; observationId: string; ref: string; taskInputId: string }
  | { kind: 'select'; observationId: string; ref: string; optionRef: string };

type BrowserActionCommand = {
  kind: 'browser.gesture';
  version: 1;
  threadId: string;
  sessionId: string;
  generation: number;
  grantRevision: number;
  origin: string;
} & (
  | { operation: 'open'; url: string }
  | {
      operation: 'interact';
      documentId: string;
      controlFingerprint: string;
      gesture: LiveBrowserGesture;
    }
);
```

The Action binds workspace/work/revision; the command binds thread/session/lease
and origin authority. `open` is owner-authored and has no invented observation or
control. Its URL's origin must equal the bound origin. `interact` binds the current
observation/control and private descriptor fingerprint. Its input/option IDs are
resolved and revalidated at dispatch; exact fill text comes from the immutable
owner source, not model arguments. Handoff is a controller transition, not a
`request_login` effect or credential action. Do not copy cookies, hidden fields,
or request bodies into action payloads. A runtime-assigned idempotency key
identifies the owner record and gesture proposal. Durable references are audit
data only; they cannot reconnect or become usable after lease retirement/restart.

For a model proposal, prepare the concrete action without interacting. A trusted
interactive prompt displays operation, task, site, current control, and any
source-bound value, then accepts approve, reject, or handoff. Page/model text
cannot answer this prompt. Noninteractive callers cannot approve. The exact
initial `/browser open` command is already a trusted owner instruction and does
not require a duplicate confirmation. Approval remains one-use and expires no
later than the active run/lease. An origin grant alone never approves a model
gesture.

After approval, recheck work, clarification holds, grant revision, lease,
document/control, input bindings, cancellation, and deadline. Commit
`action.started` before invoking the gesture. Perform a synchronous final guard
at the browser dispatch boundary. If source validation fails before any dispatch,
cancel an unstarted action or record a proven no-dispatch failure. Once dispatch
may have occurred, timeout, cancellation, lost response, process failure, or
unavailable post-action observation is `unknown`, not failed. Never repeat a
gesture to discover whether it worked.

`accepted` means the adapter observed completion of the approved browser gesture
and captured fresh page state. It does not prove a booking, a remote account
mutation, or the WorkItem goal. Evidence states this distinction. No generic site
success banner is provider-authoritative readback. Browser action status and
evidence are inspectable in `/actions` and browser status; approval remains in
the current live review prompt.

A running or unknown browser action blocks all further model browser gestures
for that work, even in another chat or newly created session. Enforce the barrier
both in the broker and deterministic action-start validation. Observation and
explicit human handling are permitted; no auto-resubmit or automatic replacement
action is allowed. On ambiguous dispatch, retire the run and close the owned
browser, preserving the durable barrier and cleanup evidence. The owner can
inspect independently and reconcile explicitly. Existing exclusive-maintenance
recovery handles a retained `running` action after process loss; ordinary startup
does not assume it owns an old worker. Reconciliation is owner attestation and
does not claim independent verification or redispatch.

Late fulfillment is consumed without new gestures, final model writes, or
overwriting a settled unknown attempt. Successful close does not resolve an
unknown remote outcome. Replay/rebuild executes only deterministic reduction and
never starts Chromium, a proxy, a prompt, or network traffic.

## Minimum interfaces and file boundaries

- `browser/managed-session.ts`: controller, exact binding, origin grants, run
  borrow/release, handoff/resume, expiry and shutdown; operational resources only.
- `browser/live-playwright.ts`: semantic snapshot/ref implementation and guarded
  native interactions; consumes the controller's private lease and network gate.
- `browser/public-network.ts`: canonical origin/public-address validation and the
  bounded CONNECT gate; production defaults and trusted dependency seams.
- `kernel/browser-action.ts`: versioned browser command shape and pure validation;
  existing types/policy/reducer handle digest and Action lifecycle invariants.
- `runtime/browser-actions.ts`: concrete gesture preparation, trusted approval,
  started-before-dispatch, outcome settlement and unknown barrier.
- `runtime/browser-exploration.ts`: capability-selected live/synthetic protocol,
  shared recall and model budget, explicit lease retirement result. Retain the
  existing per-turn close behavior for synthetic adapters.
- `cli/browser-commands.ts`: trusted lifecycle/input/origin/reconciliation surface
  and owner review; `cli/main.ts` composes it only with `--browser live`.

The existing process owner may accept narrowly typed internal proxy/launch
configuration needed for the network gate. No raw browser options are public.
No storage shape change is needed: browser actions use existing action events and
observations use existing evidence records. Add strict new-command validation
without reinterpreting old journal records. Update the implementation status table,
README, browser guide, and security scope to match actual behavior.

## Acceptance

Write behavior tests first and observe failure before each implementation step.

1. Run the same live adapter against two unrelated dynamic synthetic websites
   without fixture-specific policy or selector branches. Exercise JavaScript
   rendering, CSS/script/image dependencies, allowed redirects, fetch/XHR, a
   nonmutating POST search, and a GET endpoint that would mutate. The latter must
   never be classified as safe merely because it is GET.
2. Through the actual agent/CLI path, create/focus a task, open a website, approve
   current controls, fill an owner-bound search term, compare results, and journal
   sourced notes/progress. Run a separate non-sensitive public HTTPS smoke using
   the shipped public configuration and record the observed outcome. The product
   must accept owner URLs; synthetic acceptance alone cannot prove live access.
3. Human handoff performs synthetic login in the visible window while snapshots
   and model access are suspended. Resume sees the authenticated result in the
   same browser on a later owner turn. No vault calls occur; password input values
   are absent from snapshots and audit. Do not infer a guarantee against malicious
   reflection from this fixture.
4. New leases invalidate prior refs. Work/chat/session crossover, stale task or
   input revision, replacement controls, revoked origins, cancelled review, and
   changed documents reject before dispatch. Two work/chat sessions cannot share
   cookies or controls. Unknown outcome blocks replacement sessions for that work.
   Owner input authorization between turns succeeds for one freshly matching
   descriptor; retired executable refs remain unusable. Changed/ambiguous fields,
   navigation and handoff invalidate matching before any value is disclosed.
5. Reject unapproved origins, redirects, private/literal/DNS/rebinding targets,
   unsupported protocols, service workers, WebSockets, files, downloads, and
   proxy bypass. Server-side counters prove no prohibited dispatch. Public CLI
   cannot invoke trusted test-only routing or certificate seams.
6. A mutating gesture is withheld without owner confirmation, recorded started
   before its first request, and attempted once. A server applies it then drops
   the response: outcome is unknown, late completion cannot overwrite it, and
   another turn/restart does not retry. Page success text alone cannot close work.
7. Final turn release preserves a healthy browser; handoff retires automation;
   cancellation, unknown, expiry, explicit close and application shutdown follow
   their documented closure paths. Verify owned process/server/profile cleanup,
   retained receipts on uncertainty, and no false cleanup claim for retention.
8. Rebuild and encrypted backup/restore preserve action/evidence data without
   browser/network/prompt access. Existing synthetic browsing, credential vault,
   operation-loop, and owner-control acceptance stay passing.
9. Record exact source head, browser/model versions, task text, tool calls,
   interventions, unknowns, limitations, and cleanup. Scripted tests, real
   Chromium tests, live-model synthetic runs, and public-web smoke are distinct
   evidence categories. Finish full POSIX `npm run verify`, independent Sol/high
   and Astra/high source review, and exact-head hosted checks before authorized
   integration.

No new owner design decision is required under the existing delegation. Runtime
origin access, gesture review, handoff, and reconciliation are concrete owner
controls of the delivered product; they are not permission gates for this
implementation work.
