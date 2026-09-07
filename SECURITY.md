# Security status

**Offline prototype. Not ready for sensitive accounts, customer data or public hosting.**

M0 has no remote server, live provider connection, API key store or production
model. The owner ID checks assume a trusted local caller. They are not a login
system, signature check or authorization token. External-audience context is denied.

SQLite artifacts are plaintext. The append-only journal triggers protect normal
application behavior, not an adversary controlling the process or database file.
Third-party in-process code is trusted code, regardless of the TypeScript interface.

All implemented message effects require a current owner approval. A fake provider
is the only shipped driver. Approval binds command contents, work revision and
expiry; model output cannot turn itself into approval through the supported API.
Unknown execution outcomes are quarantined rather than automatically retried.

Before real use: authenticated owner control, webhook signature verification,
replay protection, protected secrets, encrypted artifacts, appropriate retention
and erasure, scoped retrieval, provider readback, rate/budget caps, safe backups,
loop detection and independent security review are required.

Do not put real messages, tokens, OTPs, financial data, addresses or customer
records in public issues. A private vulnerability reporting route must be
configured on the eventual GitHub repository before public distribution.
