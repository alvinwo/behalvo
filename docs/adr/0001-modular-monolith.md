# ADR 0001 — Modular monolith with workspace-scoped durability

Status: accepted for M0.

Use one TypeScript package and SQLite, with internal kernel/storage/runtime/memory
boundaries. A workspace is the state and policy partition; a thread is not.

This avoids distributed delivery/transaction coordination while the first personal
workflow is still being learned. Expected stream revisions reject stale writes.
It does not create multi-process scheduling, tenant authentication or a sandbox.

Extract packages or switch persistence only when a second real consumer or measured
load justifies it. Preserve transaction semantics rather than exposing generic CRUD.
