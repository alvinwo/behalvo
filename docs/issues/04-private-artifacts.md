# Protect secrets and personal artifacts before dogfooding

Local issue draft; not yet created on GitHub.

Milestone: M1
Area: Security
Risk: High

## Goal

Enable controlled real-account testing only after sensitive data handling is explicit.

## Acceptance criteria

- [ ] Keep tokens and OTPs out of journal payloads and model context; use isolated credential handles.
- [ ] Encrypt sensitive artifacts and define key ownership, access and rotation.
- [ ] Implement erasure across raw artifacts, summaries, indexes and caches; document backup retention.
- [ ] Prevent accidental publication of database files, logs and personal fixtures.
- [ ] Test cross-workspace access and erasure without promising impossible full replay of deleted payloads.
