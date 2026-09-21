# Milestone Fix Round 3 Implementation Plan

> **For Codex:** Execute this plan with strict test-driven development, one reviewer finding at a time.

**Goal:** Correct explicit readback terminal semantics, make verification-to-service-claim persistence crash-safe, and expose a bounded authenticated reminder projection through the service API and UI.

**Architecture:** Extend the existing single SQLite composition root. Persist the exact verification record identifier on the claimed service job in the same transaction that appends verification events, then derive terminal status and crash recovery only from that association. Project reminder lifecycle from durable owner scheduling receipts plus journal state through a fixed paginated DTO.

**Tech Stack:** Node.js, TypeScript, SQLite, `node:test`, POSIX service/UI HTTP server.

## Task 1: Readback Semantics

- Add runtime tests for `satisfied`, `not_satisfied`, `unknown`, and `owner_attested` readback outcomes.
- Add storage-validation tests rejecting false completed result shapes.
- Implement the minimal terminal-classification and validator changes so only exact `satisfied` verification can complete a readback.

## Task 2: Atomic Verification Association

- Add crash-injection and recovery tests for execute and readback jobs after verification persistence but before job finalization.
- Add an atomic store operation that appends verification events and associates the exact record with the running service claim.
- Use only that association for normal finalization and recovery; never select a latest verification by action.

## Task 3: Reminder Projection

- Add authenticated HTTP/control tests for bounded pagination, workspace scope, auth-before-lookup, and fixed response fields.
- Add scheduled, fired, cancelled, and restart persistence coverage, including original owner request identity.
- Implement the durable projection, detail DTO, routes, and responsive UI rendering without exposing request payloads.

## Task 4: Verification and Handoff

- Run affected tests, the full Task 3 focused suite, `npm test`, `npm run verify`, and `git diff --check`.
- Update the Task 3 report and progress ledger with RED/GREEN evidence and reviewer disposition.
- Review the diff for scope/security regressions and create one scoped commit.
