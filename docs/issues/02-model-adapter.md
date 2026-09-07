# Proposal-only model adapter and bounded dispatcher

Local issue draft; not yet created on GitHub.

Milestone: M1
Area: Kernel
Risk: High

## Goal

Connect one model through Planner while keeping all state/effects behind validated application commands.

## Acceptance criteria

- [ ] Load scoped ContextPacket.text with provider-specific token accounting and tool/output reserves.
- [ ] Validate proposals at runtime; never expose SqliteStore or Operator administrative methods as arbitrary tools.
- [ ] Process one workspace decision at a time; recheck the state revision before committing.
- [ ] Commit proposed actions and inbox acknowledgement atomically; derive operation keys from persisted logical steps.
- [ ] Cap iterations, tokens, wall-clock duration and concurrent calls; log concise decisions, not private reasoning.
- [ ] Test stale plans, malformed responses, context overflow, model failure and resumable processing.
