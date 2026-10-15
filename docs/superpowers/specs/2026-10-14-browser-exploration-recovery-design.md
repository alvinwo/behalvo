# Browser navigation authority and exploration recovery

Status: approved for implementation by the delegated architecture reviewer.
Date: 2026-10-14.

## Intent and scope

The owner wants ordinary browsing to proceed without approving every URL or link,
and wants a browser rejection to explain what happened and preserve useful work.
The owner delegated design approval and selected the primary chat as the sole
product/test writer. This specification approves the design and its companion
implementation plan under that delegation; implementation review remains a
separate gate.

Amend the per-navigation review clauses of the
[managed-browser design](2026-10-11-managed-browser-design.md) and
[agent-navigation design](2026-10-11-agent-browser-navigation-design.md).
Keep their scope, network, input, cleanup, journal and unknown-outcome boundaries.
No additional permission setting, agent, dependency, persistent browser profile,
trace service or storage migration is introduced.

The investigation reproduced a covered-link rejection before the private DOM
helper's activation call. Current code marks possible dispatch before its helper
RPC, then discards the helper exception and records unknown. That reproduction
establishes a fixable mechanism; the original historical action cannot be assigned
that cause with certainty because its exception was not retained. Do not change
or reconcile any existing unknown action as part of this release.

## Selected approach

Use the existing managed browser, action broker and exploration loop. Grant
standing navigation authority in `--browser live`, distinguish it durably from
fresh review, and allow the fixed isolated-world helper to report a proven
pre-activation rejection. Recover by observing current state and returning coded
feedback within the existing loop budget. Keep uncertain effects terminal and
require explicit owner reconciliation.

Keeping per-page prompts does not meet the request. Automatically approving every
gesture would expand authority to forms and buttons. Inferring no effect from an
exception message or quick failure would break the unknown-outcome boundary.
Neither alternative is selected.

## Navigation authority

The trusted live controller authorizes the following operations without a new
approve/reject prompt:

- `visit` to a validated public HTTPS destination, including its exact path,
  query and fragment.
- `navigate` on a current observed native link accepted by the existing semantic
  adapter, with an exact public HTTPS destination. Downloads, other browsing
  targets and unsupported controls remain ineligible under current rules.

This is an explicit navigation policy, not a claim that links or GET requests are
read-only. Navigation can execute page handlers, send cookies and produce remote
effects. Do not classify by HTTP verb, URL keyword, visible label or model claims.
The model must not use a URL or link to bypass a required confirmation for a
known consequential operation; the browser cannot prove an arbitrary site's
semantics. Explain this limitation in startup/help and security documentation.

`click`, `fill` and `select` keep fresh private owner review. Buttons, form
controls and scripted controls are not promoted to navigation merely because they
could change the displayed page. Task input binding, manual login handoff and
explicit owner resume remain unchanged. The trusted `/browser open` command keeps
its exact one-use owner-source authority. Synthetic browsing policy is unchanged.

All navigation still prepares an immutable action, journals approval under its
actual authority, commits `action.started` before possible dispatch and dispatches
once. Recheck current work/revision, clarification holds, owner source/thread,
session/generation, network policy, unknown barrier, cancellation and deadline.
Standing authority cannot survive an invalid lease or permit work after handoff.

## Durable provenance and destination

Keep every version-1 browser command and digest unchanged. New live actions use
version 2 with the existing fields plus:

```ts
type BrowserActionAuthority =
  | 'owner_open'
  | 'navigation_policy_v1'
  | 'owner_review';
```

The required `authority` field is part of the immutable command and digest. The
controller stamps it; a model tool or page cannot supply it. Strict validation
permits `owner_open` only for `open`, `navigation_policy_v1` only for `visit` or an
`interact` with `navigate`, and `owner_review` only for an `interact` with `click`,
`fill` or `select`. The existing proposal-event actor/causation supplies the exact
owner-source provenance; a second grant projection or duplicate source field is
unnecessary. Legacy version-1 commands retain their historical interpretation.

For version-2 `interact`/`navigate`, require an exact canonical HTTPS
`destination` field. Derive it from the trusted observed descriptor, not the model
or label, and compare it against the href used at dispatch. The existing `origin`
continues to identify the source document; cross-origin navigation is valid under
the public network policy. `open` and `visit` already carry their exact `url`.
Other operation shapes reject `destination`. These URLs have the same privacy and
storage-protection treatment as existing visit commands; do not add HTML, request
bodies, hidden values, cookies or provider errors to the command.

The ordinary Action approval record still binds owner, digest and expiry. In this
context it records authorization, not necessarily a new human prompt. User-facing
audit output distinguishes standing navigation, direct owner command and private
review from the command's authority field. Do not relabel old records.

## Proven no-dispatch receipts

Retain the possible-dispatch marker immediately before the single helper RPC.
Move only known pre-activation rejection branches in the fixed isolated-world
helper from thrown exceptions to a closed return union:

```ts
type WorldDispatchReceipt =
  | { status: 'dispatched' }
  | { status: 'not_dispatched'; code:
      'control_missing' | 'control_changed' | 'control_covered' |
      'field_ambiguous' | 'option_changed' | 'deadline_expired' };
```

Every `not_dispatched` branch must return before native click, a value/selection
setter or input/change event. Final validation and first activation remain in one
synchronous function with trusted isolated-world DOM intrinsics. Keep the current
hit-target guard; the reproduced overlay is a real covered control, not evidence
to remove the guard or change geometry selection.

The host accepts only an exact, allowlisted receipt returned by that invocation
of the fixed helper. An exception, malformed receipt, page text, missing return,
RPC loss, deadline race or process failure is not a receipt. Do not parse exception
strings or convert a catch-all into `not_dispatched`. The helper response is tied
to its existing RPC; no receipt persistence or second effect protocol is needed.

A trusted host-side typed rejection transports a valid no-dispatch receipt to the
broker. It may settle that started action as `failed` even though the RPC was
marked possible dispatch. The failure means that this selected gesture was not
activated; it does not assert that the page performed no background work. A
timeout or cancellation settled first remains unknown; a late receipt cannot
rewrite it. A generic error before the possible-dispatch marker retains the
existing no-dispatch treatment but does not automatically establish that the
browser is healthy enough to resume.

## Bounded diagnostics and recovery

Add a small typed diagnostic with a fixed `code` and `phase`; use existing action
evidence artifacts for durable recording. Phases are `validation`, `dispatch`,
`navigation` and `observation`. The no-dispatch codes above use `validation`.
Additional fixed codes are `pre_dispatch_stopped`, `dispatch_unconfirmed`,
`navigation_unsettled` and `observation_unavailable`. Assign them at the trusted
operation boundary that knows the phase. A diagnostic describes where evidence
was lost; it never changes the effect status by itself. Arbitrary exceptions,
stack traces, page/provider error strings and raw network data remain excluded.

After a valid recoverable no-dispatch result, settle the failed action first.
Do not close a healthy, current session for `control_missing`, `control_changed`,
`control_covered`, `field_ambiguous` or `option_changed`. In the same exploration
turn, obtain one fresh observation, journal it and return tool feedback containing
the action ID, failed/no-dispatch disposition, fixed code/phase and that new
observation. Expire old executable references. The model may choose its next step
from current evidence or hand control to the owner. Never silently repeat the
original gesture. Any new mutation proposal still needs a new private review.

This consumes the current loop's remaining model calls and deadline; keep the
eight-call and 120-second limits. Do not add a retry worker, new run, budget reset,
sleep loop or automatic dismissal of overlays. If authority expired/cancelled,
the fresh observation fails, or cleanup/retirement is unconfirmed, stop under the
existing lifecycle rules. A failure to observe after proven no dispatch does not
retroactively turn that failed action into an unknown effect.

If dispatch may have occurred and fresh evidence is unavailable, preserve
`unknown`, close the owned browser and retain the work-wide barrier. Return a
fixed message identifying the action and diagnostic, explaining that the gesture
may have occurred and was not retried, and pointing to `/actions` plus explicit
`/browser resolve`. `failed` reconciliation means independently confirmed no
effect. Never suggest that a fresh turn alone clears the barrier.

`/browser status` must expose unresolved action IDs even when the session has
closed; an absent window must not hide durable work state. A later browser turn
with an unresolved `running`/`unknown` action returns actionable barrier guidance
before model calls or browser allocation. Status and guidance are read-only.
Normal observation-only reads or explicit human reconciliation remain permitted;
no new action, replacement browser or replay may bypass the barrier.

## Acceptance and delivery

Use synthetic fixtures and test-first implementation. Required behavior includes:

1. A natural task can visit and follow an observed native link without a review
   callback, while button/fill/select still require review. All actions retain
   journal ordering, exact bindings and one-shot dispatch. A direct answer still
   allocates nothing.
2. Version-1 digest fixtures remain byte-stable; version-2 digests bind authority
   and navigate destination. Invalid authority/operation shapes and forged model
   fields reject. Replay and backup/restore do not prompt, browse or dispatch.
3. A synthetic overlay rejects at the private helper before activation, records
   failed with `control_covered`/`validation`, retains a healthy session, gives the
   model fresh references and lets exploration finish without owner resolution.
   Server/handler counters prove no activation. No automatic overlay click occurs.
4. A mutation applied before a dropped response, helper exception or missing
   post-action observation remains unknown, runs once, closes and blocks later
   browser turns across restart. A late no-dispatch receipt cannot replace an
   already settled unknown. Malformed receipts cannot claim no effect.
5. Task correction, handoff, changed destination, stale node/option, cancellation,
   deadline and lease invalidation preserve their current guards during automatic
   navigation and recovery. Fresh recovery cannot disclose an unauthorized value.
6. Fixed diagnostics reach durable evidence and tool/final guidance; synthetic
   secret canaries in thrown errors never enter journal, reply or diagnostics.
   Closed-session status shows the unknown barrier and correct action ID.

Update README's implementation table, SECURITY, the browser guide and relevant
model/startup copy when operational. Record the reproduction as a matching
mechanism, not proof of the original lost exception. Run focused real-Chromium
synthetic acceptance, final POSIX `npm run verify`, independent Sol/high and
Astra/high reviews, and exact-head hosted CI before authorized integration.
Configured CI is not passing CI. This work authorizes no real booking, login,
unknown-action reconciliation or change to the owner's running process.

## Approved review amendment: interrupted running actions

The delegated architect approved this narrow amendment after independent review
found that a crash can preserve `running`, while owner reconciliation accepts
only `unknown`. Guidance must preserve each action's status and show both routes
when a task contains running and unknown actions.

Add `npm run storage -- recover-browser --db <database> --workspace <workspace>
--exclusive-maintenance [--key-file <key-file>]`. The explicit maintenance flag
asserts that all Behalvo processes and effect workers have stopped. Acquire the
existing database process lock first; authenticate the existing file and validate
the workspace through a read-only open before any writable open. Never steal a
stale lock, create a missing database/workspace, enable the service queue or bind
a service mode. Retain the existing manual stale-lock procedure.

The broker records each running browser action's exact attempt as unknown using
the normal journal settlement API and fixed diagnostic evidence. It does not
dispatch, retry, reconcile or change non-browser actions or other workspaces.
Repeating maintenance emits no events for already settled actions. Clear loaded
key bytes and release store/lock resources. Ordinary replay remains read/reduce
only. Cover crash/reopen, plaintext and encrypted storage, lock contention,
invalid keys/inputs, scope isolation, idempotence and subsequent owner resolution
with synthetic tests. Re-run verification and the same independent review pair.
