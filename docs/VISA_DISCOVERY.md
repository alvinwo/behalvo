# China visa scheduling discovery

The China visa adapter is disabled by default. Its current purpose is to define
and test a sanitized discovery contract before any owner-laptop or live booking
work. Repository code registers no live adapter or visa native host, collects no
portal credentials, and installs nothing.

## What synthetic discovery proves

The synthetic contract recognizes login, security question, group roster,
calendar, booking review, challenge, expired session, forbidden/rate-limited,
changed terms, unknown, confirmation, ambiguous submission, and appointment
states. Calendar evidence binds the Beijing location, `Asia/Shanghai`, inclusive
2026-12-15 through 2027-01-31 window, identity, account subject, complete group
roster, terms, appointment absence, contiguous pagination, and candidate evidence.

Authenticated fixture reports bind owner, installation, browser session, origin,
terms, roster, polling limits, and expiry. They contain sanitized metadata, not
credentials or applicant values. A valid fixture still reports live registration
as disabled and cannot activate a grant.

## Partial browser verification report

The separate `synthetic-browser-discovery-v1` report uses the existing 13 read-only
P2 browser cases. It records validated page-state and selected field-presence
checks, zero-gesture/POST evidence, cleanup, installed versions and source
provenance. State-only cases prove only the synthetic page state. Every row is
fixture-seeded; no snapshot values, credentials or applicant data are exported.
Calendar pagination and all live identity, roster, terms, origins, polling,
profile-custody and reachability gaps remain unobserved even when the report passes.
This report is not an authenticated contract fixture, readiness approval or grant.
See [execution and output](PLAYWRIGHT_BROWSER.md#synthetic-discovery-report).

## Required supervised owner-laptop discovery

This later operation must be read-only and separate from CI and synthetic
acceptance. A separately reviewed transport must own or bind a dedicated profile
with verified custody. The owner logs in, handles
every challenge, and reviews:

1. current portal terms and whether the intended access pattern is permitted;
2. exact production origins and redirects;
3. account identity and the existing complete group roster;
4. new-group appointment semantics and current appointment absence;
5. calendar page states, pagination, candidate fields, mutation boundary,
   confirmation, and authoritative appointment readback;
6. conservative polling, request budgets, backoff, session expiry, 403/429, and
   challenge behavior; and
7. sanitized evidence for independent security and architecture review.

Discovery performs no booking, creates no live grant, and stores no credential,
OTP, security answer, applicant name, passport number, or other actual account
data in the repository or report.

## Gates before live activation

Live use remains blocked until current terms/group semantics are accepted; the
final contract and polling plan are reviewed; the signed Keychain/helper and
installed extension/native-host path, or an independently reviewed equivalent
transport with the same credential, installation and session trust outcomes, is
accepted; the dedicated profile satisfies custody and
backup exclusions; the private connection and current installation are bound;
owner-laptop read-only and live acceptance pass; independent reviews are clean;
and the owner reviews and activates the exact live grant.

The service is foreground and awake-only. Phone/remote takeover, OS supervision,
automatic browser installation, signed helper distribution, credential setup,
and live activation are not available in this revision.
