# General prepared operations

Date: 2026-09-09. Direction authorized in the owner's request to design and implement the grilled proposal and create a PR.

## Goal and scope

Provide a working trusted-local TypeScript API for preparing, approving, executing, and verifying operations through multiple isolated connections. Reuse WorkItem, Action, the journal, and replay. Address changes are one demonstration, not a kernel special case. A second materially different operation must use the same runtime without adding a domain branch to it.

Node.js >=22.16.0. TypeScript modular monolith. No new runtime dependencies. Synthetic data only. No real bank connection, browser automation, paid resources, arbitrary plugin loading, remote authentication, credential vault, universal resource graph, delegation, workflow DSL, or model-initiated effects in this change. Connection metadata contains no secrets. Handler implementations are trusted code, not sandboxed by these interfaces.

## Representation

- Keep the existing message.send command shape, behavior, and approval digest compatible.
- Add a discriminated operation.execute command to the same Action model. Store the exact operation ID/version; connection ID, provider, verified subject and authorization generation; namespaced resource ID; validated JSON arguments; known affected resource IDs; observed precondition; expected result; and subject-scope revision. Canonicalize JSON object keys for hashing. Reject unsupported or non-JSON values, unsafe keys, excessive input, and unknown envelope fields.
- A Connection is workspace-scoped metadata: ID, provider, subject, label, generation, active/revoked status. Registering/rebinding/revoking is owner-only. Any binding change increments generation. No automatic equivalence of resources across remote subjects.
- An Observation identifies the exact binding, resource, trusted source, timestamp, JSON state, and optional provider version. Persist it as bounded evidence; do not infer verification from a success banner or arbitrary model text.
- Add optional verification state to Action, recording satisfied/not_satisfied/unknown or separately labeled owner_attested evidence. Observation matching is defined by the trusted versioned handler. Satisfied means the desired state was observed, not proof of causation or completion of every real-world account.
- Add connection and verification events with deterministic reducers. Existing schema-v1 journals and cached projections remain readable using additive empty defaults; replay must rebuild the same state without handler calls.

## Handler and runtime contracts

Introduce an OperationRegistry of explicitly registered, unique versioned handlers. Provide read-only metadata listing (ID/version/provider) for discovery without exposing handler functions. Each handler declares its provider, ID/version and implements input validation, remote subject identification, observation, pure preparation, execution, precondition comparison, and result verification. Use JSON-compatible inputs/outputs. The registry validates runtime data; TypeScript declarations alone are insufficient. An unavailable handler/version or unsupported target fails before dispatch.

OperationService composes the existing Operator/SqliteStore; it must use the same action lifecycle, not a second outbox. Provide documented public methods to register/revoke a connection; prepare a concrete action; approve an exact batch of action ID/digest pairs atomically; execute; verify/read back; reconcile an ambiguous outcome by an explicitly authorized owner decision; and recover interrupted operation attempts in exclusive maintenance. Reuse existing owner approval/cancel semantics where safe. Legacy Operator propose/dispatch/reconcile entrypoints must reject operation commands when they would bypass the operation-specific gates.

Preparation authenticates the trusted local owner, resolves the registered connection and handler, validates input, checks the actual remote subject, reads a fresh observation, and constructs a concrete immutable command using handler preparation. Preparation never performs the mutation. Recheck connection generation after asynchronous reads before recording the proposal. Approval does not authorize other targets or an expanded operation scope.

Execution checks owner, exact handler/version, current binding/generation, approval digest/expiry, work revision, and subject-scope revision. It identifies the remote subject again and reads a fresh precondition. Any stale identity, precondition, or local mutation revision prevents submission. Recheck all mutable local gates after asynchronous preflight. Append action.started transactionally before invoking the handler. Exceptions and invalid outcomes after dispatch become unknown with sanitized evidence. failed is reserved for a handler's confirmed no-effect outcome. Never repeat a started/terminal action.

Use a conservative conflict scope of (workspace, provider, remote subject). Serialize mutation attempts across connections and WorkItems in that scope. running, unknown, and accepted-but-unverified operations retain the conflict barrier. A prepared command binds a revision derived from prior attempts in that scope, so two independently prepared actions cannot sequentially overwrite each other after one executes. Starting an operation checks the revision and barrier inside deterministic reduction as well as runtime preflight. A replacement must be freshly prepared after the prior outcome is settled. This intentionally requires re-preparation for dependent mutations under the same subject; batching distinct subjects is supported. No cross-workspace or cross-subject alias coordination is claimed.

Verification calls the exact handler and connection, checks remote identity, and validates scoped, fresh readback. Persist the observation and handler's explicit verdict. Unknown/mismatching/missing evidence cannot mark an action satisfied. A satisfied readback can settle unknown to accepted without resubmission; a mismatching state does not prove that an unknown submission had no effect. Owner attestation is a distinct, auditable reconciliation path, never automatic verification. An accepted unresolved action remains a barrier until satisfied readback or explicit owner resolution. WorkItem completion remains an owner-controlled separate transition with evidence: this runtime does not claim exhaustive account discovery or universal goal inference.

A handler may enforce conditional writes using the saved provider version. Without conditional writes, preflight cannot eliminate races with an external actor; document this limitation. Cancellation stops undispatched work only. Recovery requires exclusive maintenance and never dispatches effects.

## Acceptance evidence

Tests must cover two connections under one provider; switched remote subject; rebind/revoke while preflight awaits; unregistered/version-changed handlers; altered arguments/scope/approval; atomic batch approval; expired approval; stale observations; conflicting WorkItems and multiple runtime instances on the same store; unknown replacement under a new ID; accepted-but-unverified barriers; unavailable/stale/wrong-resource readback; explicit owner attestation; interrupt/restart/replay; unsupported/non-JSON envelope inputs; legacy message and old database compatibility.

A runnable offline operations demo must perform two semantically different operations (profile field update and subscription cancellation) through identical preparation/authorization/execution/verification machinery, show a paused/unknown outcome and reconciliation, and report synthetic-only evidence. Test the demo as a subprocess. Explain setup and handler contracts in a user-facing developer guide.

Run npm run check, npm run demo, npm run mvp:demo, npm run operations:demo, and git diff --check. Conduct independent implementation review, fix confirmed findings, publish a feature branch, create a PR, and verify Actions against its exact head. Leave the PR open for review.
