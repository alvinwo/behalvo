# One end-to-end personal email follow-up

Local issue draft; not yet created on GitHub.

Milestone: M1
Area: Product
Risk: Medium

## Goal

Dogfood one persistent personal task from forwarded message to owner-confirmed resolution.

## Acceptance criteria

- [ ] Accept a forwarded synthetic/test message and associate it with one WorkItem.
- [ ] Produce a follow-up draft and request IM approval before sending.
- [ ] Record provider receipt, wait for reply and use a durable timer without closing work prematurely.
- [ ] Apply cancellation, quiet hours, maximum attempts and escalation rules.
- [ ] Measure owner time saved minus setup/approval/correction time and log every human intervention.
- [ ] Run for real users only after issues 01–04 pass their safety gates.
