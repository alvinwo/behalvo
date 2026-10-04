# Browser discovery — next scope after Playwright P2

Status: scope approved by independent Sol-high review after Astra-max authoring.
Design only; no implementation or live discovery is approved by this note. Base: P2 merge
`4fa239488bcad79d11775368fa417559cc19bd70`. The owner delegates technical review;
actual account access still needs specific owner authorization.

## What changed, and what did not

[README](../../../README.md), [SECURITY](../../../SECURITY.md) and the
[P2 verification record](../../verification/2026-10-03-playwright-p2.md) establish
an owned visible Chromium path with synthetic DOM observations, fenced typed
forms, durable dispatch guards, unknown/readback handling and bounded cleanup.
The record reports 57 visible tests and successful diagnostic/action commands.
This is synthetic macOS evidence, not live compatibility or persistent-session
custody. Foreground operation and clean-supervisor restart limits remain.

[ROADMAP](../../ROADMAP.md) and [VISA_DISCOVERY](../../VISA_DISCOVERY.md) still
present dedicated normal Chrome, extension/native host and signed Keychain helper
as the discovery route. Reconcile that wording around required outcomes and
separate transport choices; do not interpret P2 as satisfying those live gates.

| Required outcome | Extension route | Owned Playwright route |
| --- | --- | --- |
| Bound browser/session, narrow requests, current authority | Existing compiled boundary; installed-host acceptance outstanding | P2 demonstrates synthetic ownership and dispatch only |
| Owner login, challenges, account/roster/terms checks | Supervised normal-Chrome discovery still outstanding | No live login or challenge compatibility established |
| Profile/secret custody and disconnect | Existing contracts; installed signed helper and live acceptance outstanding | Disposable synthetic profiles do not establish authenticated custody |
| Live registration and exact activation | Still gated | Still gated; no replacement live adapter |

Existing gates remain effective. A future reviewed live design must explicitly
identify which transport-specific installation requirements it retains or replaces,
and supply equivalent evidence for each required protection. This note removes
none. It also does not reorder the roadmap's independent live-model/manual,
OS-supervision, phone-control, mail or personal-alpha work.

## Smallest useful next milestone: synthetic evidence report

Recommend a bounded report exporter for the **existing** read-only P2 page-state
acceptance cases, plus documentation reconciliation. Do not add a new browser
mode, live URL option, transport, scheduler, grant or secret path to generate it.
Reuse actual `session.recognize` observations from the maintained visible tests;
keep their existing isolated owner, fixed loopback origin and zero-gesture checks.
The existing scheduling-action acceptance remains its own evidence.

The new value is a machine-validated, reviewer-readable record of exactly which
sanitized contract checks were observed, their provenance, and remaining gaps.
Current tests prove assertions; the current discovery recorder accepts manually
supplied metadata and requires a complete authenticated HTTPS contract. Neither
provides an honest partial bridge from P2 observations to later discovery review.

Keep the exporter in verification/test support, outside production registration.
Use a separate versioned artifact, `synthetic-browser-discovery-v1`, bounded to
`65_536` UTF-8 bytes, with a strict allowlist:

- `source: 'synthetic_owned_playwright'`, fixed loopback origin,
  `liveRegistration: 'disabled'`, synthetic run/workspace identifiers, actual
  adapter/browser versions and source revision or explicitly dirty provenance;
- fixed case/page-state identifiers, observed allowlisted field-presence checks,
  and `observed`, `unobserved` or `rejected` status per check;
- explicit `fixture_seeded` provenance for directly seeded states: observing
  confirmation markup does not establish how a real account reaches it;
- executed/skipped case counts, fixed outcome codes and confirmed/pending cleanup.
  A skipped case, failed assertion or pending cleanup cannot become passing
  discovery coverage. Missing evidence stays missing.

Export no raw HTML, screenshots, selectors, arbitrary text, credentials, cookies,
OTP/security answers, applicant values or hashes of actual account data. Record
neither owner terms approval nor authenticated account identity. Artifacts are
workspace/run-scoped local verification output, not journaled domain authority.
No model consumes them as permission. A digest, if used for integrity comparison,
does not authenticate a reviewer or confer authority.

The [existing discovery contract](../../../src/adapters/us-visa-china/discovery.ts)
requires HTTPS, a locally bound authenticator, complete discovery states, current
terms/origin/roster review, polling limits and expiry. Do not relax it for loopback
reports, fabricate a session authenticator, or convert this artifact into a
`UsVisaChinaContractFixture`. Some discovery concepts have no equivalent P2 field:
for example, a group digest is not evidence of member count and complete roster.
The mapping must mark such checks unobserved, not infer them from a page-state ID.

## Acceptance for that milestone

1. Offline behavior tests first: strict size/schema/provenance validation; partial,
   rejected and skipped evidence; deterministic mapping; duplicate case rejection;
   random sensitive-field canaries absent from reports and fixed errors.
2. Integrate reporting into existing opt-in visible read-only cases without
   changing their browser authority. Assert actual browser observations are the
   input, zero dispatched gestures/portal POSTs for these cases, and exact cleanup
   before successful report completion. Do not rerun booking to populate coverage.
3. Prove the new report is rejected by the existing authenticated fixture/readiness
   path and cannot register an adapter, propose/arm a grant or schedule a job.
   No report/import route is added to production control APIs.
4. Update ROADMAP/VISA_DISCOVERY to distinguish synthetic transport evidence from
   unresolved live gates, linking P2 and this scope. Run focused docs checks,
   required repository verification for executable changes, and the affected
   visible cases serially. Record actual revision/results; obtain independent
   review before claiming the milestone complete.

## Separate live discovery decision

No real origin, account, profile, credential or production terms were inspected
for this proposal. P2's JavaScript-disabled, redirect-free synthetic pages do not
establish compatibility with a production login or scheduling site.

Before any live session, a separately reviewed request must specify the exact
site/origins and permitted redirects, account/owner binding, purpose, permitted
read-only observations, time/request budget, stop conditions and retention rules.
The owner must authorize that concrete access. Current terms/access-pattern
permission and identity/complete roster semantics need recorded review; simulated
terms, fixture digests and previous synthetic approval cannot supply it.

That design must settle browser binary and transport, owner-only interactive
login/challenge handling, session/profile custody, cookie/credential protection,
backup exclusions, storage/disconnect policy and exact cleanup/recovery evidence.
Manual typing does not eliminate credential/session custody. Production scripts,
redirects or assets require an explicit narrow policy, not widening P2's allowlist.
Never perform a booking merely to discover confirmation/readback semantics; any
unobservable state remains a gap. Discovery creates no live grant or mutation.

Still unresolved for the later live design: owned disposable session versus a
persistent dedicated profile; whether secrets are owner-entered only or require
an installed signed helper; permitted origin/request graph and polling limits;
which states can be observed without mutation; and where reviewed sanitized live
evidence may be retained. These decisions do not block the synthetic exporter.

Next action: a short implementation plan for the exporter and documentation
update only. The plan must fix the case/check catalog, make any skipped/failed/
cleanup-pending run nonpassing overall, strictly parse snapshots (reject unexpected
fields), and distinguish clean commit from dirty-tree provenance unambiguously. Preserve the existing
[P2 scope](2026-10-03-playwright-p2-design.md) and all live-activation gates.
