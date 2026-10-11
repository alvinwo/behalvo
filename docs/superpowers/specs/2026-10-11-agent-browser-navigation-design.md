# Agent-initiated browser navigation

Status: approved for implementation by the delegated architecture reviewer.
Date: 2026-10-11.

## Intent and scope

With `--browser live`, an ordinary owner task lets the model decide whether to
browse and which public HTTPS URL to visit. `/browser open` remains an optional
owner control. Starting the CLI or answering a task directly creates no browser,
profile, proxy, page or network request. This is a generic navigation capability;
no site workflow, search provider API or runtime agent is added.

This amends the owner-selected-start and no-model-URL clauses in the
[managed-browser design](2026-10-11-managed-browser-design.md). Its network,
cookie, input, handoff, journal, unknown-outcome and cleanup requirements remain
in force. The user delegated design approval and selected the primary chat as
the sole implementation writer; no further owner design decision is needed.

## Selected approach

Extend the existing browser exploration loop with one tool:

```json
{"tool":{"name":"visit","arguments":{"url":"https://example.com/"}}}
```

For a resolved, explicitly linked task, live capability enables this loop even
when no session exists. A direct final response is always permitted. The live
protocol accurately states whether a page is connected or absent and never
orders unconditional `observe`. With no page, `observe` or `handoff` returns fixed
tool feedback that a model-selected `visit` can start browsing; it creates no
resources and does not require an owner command. Existing synthetic behavior is
unchanged, and synthetic mode rejects `visit` before opening a browser.

Validate the exact tool envelope and bounded URL before allocation. Use the
existing production `publicHttpsUrl` policy; no extra keys, selectors, scripts,
request options or browser settings are accepted. A URL may include a search
query. Its exact path and query are part of the reviewed destination and audit
command; they can disclose data or cause effects. Public HTTPS access does not
grant gesture authority and HTTP method does not establish harmlessness.

The alternatives were reusing auto-approved `open`, which conflates owner and
model authority, or adding a separate browsing agent/service, which adds no
required capability. Select the existing loop plus an explicit reviewed tool.

## Interfaces and authority

- Add optional `visit(context: BrowserExecution, url: string):
  Promise<BrowserObservation>` to `SemanticBrowserPort`.
- Keep `available(scope)` as the existing-session query. Add an optional
  `sessionState(scope): 'absent' | 'connected'` to browser exploration options for
  protocol state. Existing scope, human-mode, busy and fault guards remain
  authoritative; this descriptive state grants nothing.
- The live `options.open(context, binding)` returns a lazy owned port. It may
  borrow an existing session, or defer session creation until `visit`; simply
  acquiring this port allocates no browser or network resource.
- Add `operation: 'visit'; url: string` to the version-1 browser command union.
  Retain strict existing fields: thread, session, lease generation, fixed network
  policy revision and destination origin. The URL origin must match that origin.
  Old `open` and `interact` payloads and digest serialization remain unchanged.

`visit` always uses `BrowserActionBroker` and the private owner-review callback,
including its first navigation. Show the exact URL in review. Neither the model
tool nor a page can select `operation: 'open'` or supply an approval flag. The
trusted `/browser open` route alone may use the existing exact-URL initial-open
authority. Bind that one-use privilege to the exact owner source, URL and initial
open invocation, and consume it once; it is not a session-wide privilege. Do not
infer that authority from model text, source role, network
policy, a historical action or the new port. No projection migration or second
approval engine is needed.

## Lifecycle and dispatch

The port owns retirement responsibility before the first allocating await.
Creation reserves the exact workspace/owner/chat/task session; concurrent or
late creation cannot replace another session. The first `visit` materializes it
once. Later visits and later turns reuse that session, page and cookies. Existing
two-session capacity, single lease, expiry and scope isolation remain unchanged.

Creating a blank owned browser after a valid `visit` proposal is allowed, but no
request to the proposed destination occurs before approval and `action.started`.
Reject sends no target traffic. Handoff sends no target traffic, invalidates
automation references and leaves any created browser under existing human-mode
rules; a handoff request without a browser does not create one.

After review, recheck current task revision, unresolved-action barrier, lease,
network policy, deadline and cancellation before dispatch. Mark possible dispatch
immediately before the single `goto`. Never retry the navigation. Capture fresh
state only after navigation readiness. Old observations, controls and owner input
descriptors must be invalidated when explicit navigation starts, including
same-document/fragment visits; no stale field permission survives a visit.

Normal lease retirement retains a healthy session. Cancellation, startup failure,
unknown dispatch and unhealthy retirement close the exact owned resources.
Pending or late allocation is consumed and closed; it cannot navigate, publish
fresh evidence or resurrect a retired lease. Report unconfirmed cleanup honestly
and block subsequent browser work. Retention is never reported as process cleanup.
Unknown/running actions continue to block new gestures across turns, replacement
sessions and restart. Rebuild remains read/reduce only.

## Acceptance

Write behavior tests and observe RED before each executable change. Prove:

1. A natural-language task yields reviewed `visit`, fresh evidence and a final
   answer with no `/browser open`; a direct answer allocates nothing.
2. Absent `observe` gives recoverable tool feedback; malformed, non-public or
   synthetic-mode visits allocate nothing.
3. Model `visit` invokes review; trusted legacy `open` retains its distinct
   authority. Reject/handoff create no target traffic; approve dispatches once
   only after `action.started`.
4. Subsequent URLs reuse cookies and the same scoped session, expire old controls
   and input bindings, and obey cross-work/chat isolation.
5. Changed task, cancellation during creation/review, late startup, unknown
   response and unconfirmed closure preserve existing guards and cleanup truth.
6. Legacy digest/replay fixtures remain stable; new visits replay without effects.
   Run real Chromium against synthetic HTTPS fixtures through the product loop;
   classify scripted and live-model evidence separately.

Update README, SECURITY, the browser guide and implementation status to describe
the operational interface. Finish POSIX `npm run verify`, independent Sol/high
and Astra/high review, and exact-head hosted CI before authorized integration.
