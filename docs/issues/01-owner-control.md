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
