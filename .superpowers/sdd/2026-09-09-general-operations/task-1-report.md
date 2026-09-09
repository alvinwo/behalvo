# Task 1 implementation report

## Public API

All exports below are re-exported from `src/index.ts`.

```ts
class OperationRegistry {
  register(handler: OperationHandler): void;
  resolve(provider: string, id: string, version: string): OperationHandler;
  list(filter?: { provider?: string }): OperationMetadata[];
}

class OperationService {
  constructor(store: SqliteStore, registry: OperationRegistry, clock?: () => string);
  registerConnection(input: RegisterConnectionInput): Connection;
  revokeConnection(input: RevokeConnectionInput): Connection;
  prepare(input: PrepareOperationInput): Promise<OperationAction>;
  approveBatch(input: ApproveOperationBatchInput): OperationAction[];
  execute(input: ExecuteOperationInput): Promise<OperationAction>;
  verify(input: VerifyOperationInput): Promise<OperationAction>;
  reconcile(input: ReconcileOperationInput): OperationAction;
  recoverInterrupted(input: RecoverOperationsInput): number;
}
```

The exact input and handler contracts are:

```ts
type JsonPrimitive = null | boolean | number | string;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

interface RegisterConnectionInput {
  workspaceId: string;
  ownerId: string;
  connection: { id: string; provider: string; subject: string; label: string };
}
interface RevokeConnectionInput {
  workspaceId: string; ownerId: string; connectionId: string;
}
interface PrepareOperationInput {
  workspaceId: string; ownerId: string; workId: string; key: string;
  connectionId: string; operationId: string; operationVersion: string;
  resourceId: string; arguments: unknown;
}
interface ApproveOperationBatchInput {
  workspaceId: string; ownerId: string; expiresAt: string;
  approvals: { actionId: string; digest: string }[];
}
interface ExecuteOperationInput {
  workspaceId: string; ownerId: string; actionId: string;
}
interface VerifyOperationInput {
  workspaceId: string; ownerId: string; actionId: string;
}
interface ReconcileOperationInput {
  workspaceId: string; ownerId: string; actionId: string;
  status: 'accepted' | 'failed'; evidence: string;
}
interface RecoverOperationsInput {
  workspaceId: string; exclusiveMaintenance: boolean;
}

interface OperationHandler {
  readonly provider: string;
  readonly id: string;
  readonly version: string;
  validateArguments(value: unknown): JsonValue;
  identify(input: { connection: Readonly<Connection> }): Promise<string>;
  observe(input: {
    connection: Readonly<Connection>; resourceId: string;
  }): Promise<HandlerObservation>;
  prepare(input: {
    connection: Readonly<Connection>;
    arguments: JsonValue;
    observation: Readonly<OperationObservation>;
  }): OperationPreparation;
  comparePrecondition(input: {
    expected: Readonly<OperationPrecondition>;
    actual: Readonly<OperationObservation>;
  }): boolean;
  execute(input: {
    connection: Readonly<Connection>;
    command: Readonly<OperationCommand>;
    actionId: string;
    attemptId: string;
    idempotencyKey: string;
  }): Promise<OperationExecutionOutcome>;
  verify(input: {
    connection: Readonly<Connection>;
    command: Readonly<OperationCommand>;
    observation: Readonly<OperationObservation>;
  }): HandlerVerificationVerdict;
}

type HandlerObservation = {
  source: string; observedAt: string; state: JsonValue;
  providerVersion?: string; resourceId?: string;
};
interface OperationPreparation {
  arguments: JsonValue;
  affectedResourceIds: string[];
  expectedResult: JsonValue;
}
interface OperationExecutionOutcome {
  status: 'accepted' | 'failed' | 'unknown';
  evidence: string;
}
type HandlerVerificationVerdict = {
  status: 'satisfied' | 'not_satisfied' | 'unknown';
};
```

`failed` is reserved for a trusted handler's confirmed no-effect outcome. Exceptions and malformed outcomes after `action.started` are recorded as `unknown`.

The persistent operation structures are:

```ts
interface Connection {
  id: string; provider: string; subject: string; label: string;
  generation: number; status: 'active' | 'revoked';
}
interface OperationPrecondition {
  state: JsonValue; providerVersion?: string;
  source: string; observedAt: string;
}
interface OperationObservation extends OperationPrecondition {
  connectionId: string; provider: string; subject: string;
  connectionGeneration: number; resourceId: string;
}
interface OperationCommand {
  kind: 'operation.execute';
  operationId: string; operationVersion: string;
  connectionId: string; provider: string; subject: string;
  connectionGeneration: number; resourceId: string;
  arguments: JsonValue; affectedResourceIds: string[];
  precondition: OperationPrecondition; expectedResult: JsonValue;
  subjectRevision: number; requestFingerprint: string;
}
type VerificationState =
  | { status: 'satisfied' | 'not_satisfied' | 'unknown';
      observation: OperationObservation; recordedAt: string }
  | { status: 'owner_attested'; resolution: 'accepted' | 'failed';
      evidenceRef: string; recordedAt: string };
type OperationAction = Action & { command: OperationCommand };
interface OperationMetadata { provider: string; id: string; version: string }
```

`Command` remains a discriminated union of `MessageCommand | OperationCommand`. Legacy message ports accept only `MessageCommand`; `Operator.propose`, `Operator.runEffect`/`startEffect`, and `Operator.reconcile` cannot dispatch or reconcile operation commands.

## Behavior and invariants

- Connections are workspace-scoped journal state. Registration/rebinding and revocation are owner-only and advance a generation.
- Preparation validates bounded JSON, requires an initially settled subject scope, captures its attempt revision before remote reads, identifies the exact subject, requests a current scoped observation, and rechecks work, connection, scope revision, and barriers after callbacks. It persists observation source/time/state/version in the immutable command and never executes.
- An identical preparation retry uses a stable request fingerprint to recover the original action. The same key with changed intent or binding is rejected.
- Batch approval validates every action/digest/expiry first and appends one transactional event list.
- Execution rechecks owner, work revision, handler version, digest, expiry, connection generation, identity, observation recency, precondition, subject revision, and conflict barriers in the runtime before the reducer independently enforces its start invariants and records `action.started`.
- Conflict scope is workspace plus provider plus verified remote subject, so aliases and distinct WorkItems share the barrier. Running, unknown, and accepted unresolved actions block replacement. Every attempted mutation advances the subject revision.
- Verification uses the exact handler and current binding. Only a strict handler verdict is accepted. Satisfied readback can reconcile unknown to accepted without execution. Satisfied and owner-attested results are terminal; nonterminal verdicts may be replaced by later fresh observations.
- Owner attestation is a separate `action.verification_recorded` event paired transactionally with `action.reconciled`. An accepted unresolved action can only be attested as accepted.
- Recovery requires explicit exclusive maintenance and converts only running operation actions to unknown. Rebuild and restart do not call handlers.
- Observation source metadata is capped at 200 bytes, provider versions at 4,096 bytes, JSON state at 65,536 bytes, and the complete persisted observation envelope at 262,144 bytes. Live and replay validation apply the same metadata and envelope limits.

## TDD evidence

Red:

- `npm run build && node --test tests/operations.test.mjs` initially failed because `dist/index.js` did not export `OperationRegistry`.
- After the minimal export shell, the expanded run reported 1 pass and 12 failures at the missing `registry.register` boundary.
- Lifecycle regressions later reported 16 passes and 3 failures: repeat verification threw `Operation action changed during verification`, a pre-request cached observation was accepted, and accepted unresolved reconciliation threw `Only unknown actions can be reconciled`.
- Independent-review regressions reported 22 passes and 4 failures: preparation crossed an intervening settled same-subject attempt, preparation proceeded during an unknown outcome, a 300,000-character provider version persisted, and an accepted legacy message allowed evidence reconciliation.

Green:

- Focused operation suite: 26/26 passed.
- `npm run check`: 112/112 tests passed, including typecheck and build.
- `npm run demo`: passed; offline fake provider reported `realMessagesSent: 0` and `replayMatches: true`.
- `npm run mvp:demo`: passed; existing restart/cross-thread behavior remained intact.
- `git diff --check`: passed with no output.

The focused tests cover public exports and WorkItem ownership; exact preparation/idempotence; preparation across an intervening settled attempt and during unresolved outcomes; two connections and alias scope; switched identity; async rebind/revoke during preparation and dispatch; exact handler version; metadata listing; atomic/expired approvals; stale preconditions and observations; multiple WorkItems and runtime instances; unknown and accepted-unverified barriers; strict/unavailable/stale/wrong-resource/oversized verification evidence; repeated readback; unknown settlement; accepted and failed owner attestation; file restart/recovery/replay; old cached projections; invalid JSON/envelopes; operation bypass rejection; and preserved legacy accepted-message reconciliation behavior.

## Assumptions and limitations

- This is a trusted-local API. Owner IDs are trust bindings, and registered handlers run as trusted in-process code.
- Provider timestamps must be UTC timestamps comparable with the injected service clock. A read is accepted only when its timestamp is at or after the request start and no later than the response validation time.
- A handler may use the saved provider version for a conditional write. Without provider-side conditional writes, external actors can race after preflight; the local checks cannot eliminate that remote race.
- Conflict coordination covers one workspace/provider/subject scope. It does not claim cross-workspace or cross-subject alias discovery.
- Persisted observations and evidence are bounded but remain plaintext under the existing SQLite artifact/security model.
- Handler discovery lists only provider/ID/version metadata. The runtime does not discover remote resources, credentials, or handlers dynamically.
