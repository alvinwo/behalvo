# Verified email identity and relay adapter

Local issue draft; not yet created on GitHub.

Milestone: M1
Area: Integration
Risk: High

## Goal

Implement one real email ingress/egress path with a clear distinction between agent-owned and relayed identities.

## Acceptance criteria

- [ ] Validate provider signatures and dedupe by provider-account binding plus external message ID.
- [ ] Persist before ACK; preserve original sender separately from relay identity.
- [ ] Prevent sent-message echo loops and refuse implicit send-as-owner rights.
- [ ] Use a verified send identity; report accepted versus delivered versus unknown accurately.
- [ ] Document provider idempotency/readback and test response loss after provider acceptance.
- [ ] Use an authenticated owner surface for approval, not email-body instructions.
