# Public HTTPS browsing verification

Date: 2026-10-11. Final executable source: `05111a59c8b98ea2bddf190723ec43575db26a53`.
Subsequent changes in this PR are documentation only.

## Change

Managed browsing admits public HTTPS destinations, redirects and resources
without per-origin enrollment. `/browser allow` is a validated compatibility
response only; it changes no policy, expiry, lease, journal or network state.
Status reports `networkPolicy: "public_https"`. Startup, help and compatibility
copy use the existing English catalog in `src/browser/live-messages.ts`; the CLI
has no other supported locales.

The checked-DNS proxy, no-direct-fallback settings, private-address restrictions,
session revocation, task/field input binding, Chromium cookie policy, reviewed
journaled gestures, unknown-outcome barrier and synthetic vault are preserved.
The legacy numeric `grantRevision` remains audit metadata, with live authority
separately checked against the session and lease. No storage migration is needed.

## Local evidence

Behavior tests first reproduced the missing feature: a new public origin was
rejected, a real Chromium page stayed at “Loading” when its CDN/API was denied,
public cross-origin navigation was rejected before the input-binding test could
complete, and the old CLI command did not explain the new policy.

The finished managed-browser cases passed across focused runs: 37 initial cases,
15 network/CLI cases after adding late-DNS closure and invalid-origin coverage,
and eight action cases. These overlap; together they cover all 46 managed-browser
cases with no skips or failures. Raw logs are local ignored files under
`data/verification/public-https/{focused,extra,actions}.log`.

Coverage includes public cross-origin scripts, images, CSS, content APIs and
redirects; more than eight public hosts; private literals/mixed DNS; checked
literal dialing; revoked-session traffic; DNS completing after closure; stale
leases; separate cookie jars; SameSite and omitted cookies; unchanged gesture
approval/unknown barriers; and a real journal input binding rejected on another
origin after a successful authorized fill on its original site.

`PATH=/opt/homebrew/opt/node/bin:$PATH TMPDIR=/private/tmp npm run verify` passed
on Node 25.8.1/npm 11.11.0. All six steps exited zero: check, kernel demo,
prepared-operation demo, POSIX owner-control demo, service demo and diff check.
The default suite reported 1,450 tests, 1,365 passed, 85 opt-in skips and zero
failures. The opt-in Chromium cases above supply managed-browser acceptance.

Terminal evidence:
`data/verification/2026-10-11T20-09-57.509Z-f54fe5f8-a12d-4007-b850-a33b927df769/summary.json`.
It records source head `05111a5` and unchanged before/after source fingerprint
`4ba779f0034acc905b9724a7983c5ad7fd592a0130741b888b7a872525691ab5`.
Only documentation changes followed. An earlier full pass on `068cda8` preceded
the review fix below; the final run includes it. Hosted CI is separate evidence
and is required on the final PR head before merge.

The Sol reviewer found stale origin-grant guidance in the live model system
prompt. A test capturing the request actually delivered through `AgentService`
failed on that guidance, then passed after the prompt was corrected. All 14
exploration-loop tests passed, and both reviewers approved the focused fix.
Local evidence: `data/verification/public-https/prompt-{red,green}.log`.

## Public page smoke and limits

At source `068cda8`, a fresh, isolated visible Chromium opened
`https://www.ustraveldocs.com/cn/en/nonimmigrant-visa` using production DNS,
checked-address dialing, certificate validation and proxy settings. A trusted
diagnostic wrapper recorded only public resource paths/status and page metrics;
no private profile, login, account, owner credential or booking was involved.
No `/browser allow`, DNS override or TLS override was used. There was no model
call: this was an adapter/network smoke, not live-model acceptance.

After five seconds the observation contained 1,655 visible characters and 55
controls. The content API returned 290 successful responses. Cleanup of the owned
browser/profile/proxy was confirmed. Local diagnostic script/log:
`data/verification/public-https/{probe.mjs,public-page.log}`.

The page was no longer blank, but the run also recorded 125 content-API connection
resets, 41 content-API HTTP 403 responses, and public-site HTTP 404/403 responses.
These remaining resource/server errors were not diagnosed or fixed by this
network-policy change. This does not establish complete portal rendering,
authenticated H-1B appointment compatibility or booking readiness. Existing
resource budgets and unsupported browser features remain as documented in the
[browser guide](../PLAYWRIGHT_BROWSER.md).

## Review ledger

- Architecture: `gpt-6-astra`, max; real network-policy decision; zero retries;
  approved the scope and immutable policy/session authority separation.
- Independent security/architecture review: `gpt-6-astra`, high; high-risk final
  pair; one focused follow-up for the prompt fix; approved with no blocking findings. Suggested additional
  composed redirect coverage for HTTP and private DNS as a nonblocking gap.
- Independent code/security review: `gpt-5.6-sol`, high; high-risk final pair;
  one focused follow-up after the stale model instruction was corrected; approved.
