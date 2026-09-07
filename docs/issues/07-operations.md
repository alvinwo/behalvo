# Durability, budgets and production operations

Local issue draft; not yet created on GitHub.

Milestone: M2
Area: Kernel / Security
Risk: High

## Goal

Convert the offline kernel into a supervised, recoverable single-daemon service.

## Acceptance criteria

- [ ] Add safe daemon locking, shutdown/drain, due-work scheduling and bounded dispatch.
- [ ] Add provider-specific reconciliation for unknown operations and an operator review queue.
- [ ] Test process termination before/after network dispatch and before/after journal commit.
- [ ] Validate backup/restore with SQLite WAL; do not copy only a live .db file.
- [ ] Enforce per-workspace token/message/cost ceilings, consent, rate limits and timezone-aware quiet hours.
- [ ] Only add multi-process leases/fencing when measured load requires them.
