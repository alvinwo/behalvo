# Authenticated owner control and approval UI

Local issue draft; not yet created on GitHub.

Milestone: M1
Area: Security / Integration
Risk: High

## Goal

Provide one authenticated owner interaction surface without using email as the control plane.

## Acceptance criteria

- [ ] Bind a verified owner identity to one workspace; reject spoofed owner IDs and replayed approvals.
- [ ] Display recipient, channel, exact message body, work revision and expiry before approval.
- [ ] Authenticate approval and cancellation separately from conversation content.
- [ ] Add negative tests for impersonation, stale approval, wrong workspace and modified command.
- [ ] Choose one practical IM or local UI first; do not claim WeChat/WhatsApp support without a working adapter.


## Partial delivery (2026-09-14)

Implemented a local loopback synthetic pairing/review console with durable approvals and cancellations. This does not close the issue: remote identity, real message preview, phone connectivity, protected credentials/settings, real-provider authorization/readback and manual live-model acceptance remain required.
