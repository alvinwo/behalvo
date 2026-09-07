# ADR 0002 — Explicit effects with uncertainty

Status: accepted for M0.

Action command content is immutable. Owner approval binds command digest,
workspace, work revision and expiry. The runner rechecks these before dispatch.
A started action without a trustworthy result is unknown, not automatically failed.

Stable operation IDs suppress ordinary duplicate dispatch and are forwarded to the
provider. They do not establish exactly-once remote effects on their own.
Unknown outcomes need readback or an explicit owner reconciliation. This sacrifices
some automatic liveness to avoid sending, booking or charging twice.

A provider-accepted effect does not independently establish the work goal.
