# Security status

**Offline prototype. Not ready for sensitive accounts, customer data or public hosting.**

The offline M0 kernel uses fake providers and has no remote server. The local MVP
adds an optional Pi adapter that can contact model providers and stores credentials
separately in `data/pi-auth.json` by default. Live Pi/Codex operation has not yet
been verified; this credential store is not production secrets protection.

The owner ID checks assume a trusted local caller. They are not a login system,
signature check or authorization token. External-audience context is denied.

SQLite artifacts are plaintext. The append-only journal triggers protect normal
application behavior, not an adversary controlling the process or database file.
Third-party in-process code is trusted code, regardless of the TypeScript interface.

All implemented message effects require a current owner approval. A fake provider
is the only shipped driver. Approval binds command contents, work revision and
expiry; model output cannot turn itself into approval through the supported API.
Unknown execution outcomes are quarantined rather than automatically retried.

General prepared operations use explicit workspace-scoped connection metadata and
trusted versioned handlers. A connection's owner ID, provider, subject and label
are local bindings, not remote authentication or credentials. Handler code must
enforce its provider identity and resource scope on every callback. The shipped
contact-update and subscription-cancellation handlers are synthetic and contact no
real account.

Trusted readback can show that a desired resource state is present, but it does not
prove which action caused that state, cover every remote account, or complete a
WorkItem. Without provider-side conditional writes, an external actor can race
after the local preflight. Real handlers therefore require protected credentials,
provider-specific authentication, conditional-write and readback design, rate
limits, and independent review.

Before real use: authenticated owner control, webhook signature verification,
replay protection, protected secrets, encrypted artifacts, appropriate retention
and erasure, scoped retrieval, provider readback, rate/budget caps, safe backups,
loop detection and independent security review are required.

Do not put real messages, tokens, OTPs, financial data, addresses or customer
records in public issues. A private vulnerability reporting route must be
configured on the GitHub repository before broader public distribution.
