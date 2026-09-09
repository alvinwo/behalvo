# General prepared operations

Behalvo can prepare, approve, execute, and verify versioned operations through the same durable `Action` lifecycle used by the rest of the runtime. The shipped operations demo is offline: its two handlers and provider state are synthetic, it opens no remote connection, and it performs zero real external effects.

```bash
npm ci
npm run operations:demo
```

The command prints JSON like this:

```json
{
  "mode": "synthetic-operations",
  "realExternalEffects": 0,
  "verifiedOperations": 3,
  "unknownBlocked": true,
  "replayMatches": true
}
```

The demo updates a contact profile and cancels a subscription through one `OperationService`. Those handlers use different arguments and provider-state contracts. It also applies a synthetic contact update and loses the response, observes `unknown`, confirms that replacement preparation is blocked, and settles the original action with trusted readback. Verification does not call `execute` again. Finally, it closes and reopens the temporary SQLite database and checks the live projection and journal rebuild for equality.

## Complete trusted-local example

Save this as `operations-example.mjs` at the repository root, run `npm run build`, then run `node operations-example.mjs`. It creates an in-memory workspace, one WorkItem, three explicit connection bindings, and two prepared actions for distinct subjects. The synthetic handlers are demonstration helpers; the operation runtime itself is imported through the public package entry point.

```js
import {
  OperationRegistry,
  OperationService,
  Operator,
  SqliteStore
} from './dist/index.js';
import {
  SyntheticContactUpdateHandler,
  SyntheticOperationsProvider,
  SyntheticSubscriptionCancellationHandler
} from './dist/operations/demo-handlers.js';

let milliseconds = Date.parse('2026-09-09T12:00:00.000Z');
const clock = () => new Date(milliseconds++).toISOString();
const store = new SqliteStore(':memory:');

try {
  store.createWorkspace('personal', 'owner');
  new Operator(store, clock).createWork('personal', 'owner', {
    id: 'account-maintenance',
    title: 'Account maintenance',
    goal: 'Observe every requested account change',
    threadId: 'local-control'
  });

  const remote = new SyntheticOperationsProvider(clock);
  remote.seedContact('customer-ada', {
    email: 'ada@old.example.test', locale: 'en-GB'
  });
  remote.seedSubscription('account-grace', {
    plan: 'synthetic-monthly', status: 'active', cancellationReason: null
  });
  remote.seedContact('customer-linus', {
    email: 'linus@old.example.test', locale: 'fi-FI'
  });

  const registry = new OperationRegistry();
  registry.register(new SyntheticContactUpdateHandler(remote));
  registry.register(new SyntheticSubscriptionCancellationHandler(remote));
  const operations = new OperationService(store, registry, clock);

  operations.registerConnection({
    workspaceId: 'personal', ownerId: 'owner',
    connection: {
      id: 'profile-ada', provider: remote.provider,
      subject: 'customer-ada', label: 'Ada customer profile'
    }
  });
  operations.registerConnection({
    workspaceId: 'personal', ownerId: 'owner',
    connection: {
      id: 'subscription-grace', provider: remote.provider,
      subject: 'account-grace', label: 'Grace subscription account'
    }
  });
  operations.registerConnection({
    workspaceId: 'personal', ownerId: 'owner',
    connection: {
      id: 'profile-linus', provider: remote.provider,
      subject: 'customer-linus', label: 'Linus customer profile'
    }
  });

  const profile = await operations.prepare({
    workspaceId: 'personal', ownerId: 'owner', workId: 'account-maintenance',
    key: 'profile-ada-email', connectionId: 'profile-ada',
    operationId: 'contact.update', operationVersion: '1',
    resourceId: 'contact-profile', arguments: { email: 'ada@new.example.test' }
  });
  const cancellation = await operations.prepare({
    workspaceId: 'personal', ownerId: 'owner', workId: 'account-maintenance',
    key: 'subscription-grace-cancel', connectionId: 'subscription-grace',
    operationId: 'subscription.cancel', operationVersion: '1',
    resourceId: 'subscription', arguments: { reason: 'Owner requested cancellation' }
  });

  const expiresAt = new Date(Date.parse(clock()) + 3_600_000).toISOString();
  operations.approveBatch({
    workspaceId: 'personal', ownerId: 'owner', expiresAt,
    approvals: [
      { actionId: profile.id, digest: profile.digest },
      { actionId: cancellation.id, digest: cancellation.digest }
    ]
  });

  for (const action of [profile, cancellation]) {
    await operations.execute({
      workspaceId: 'personal', ownerId: 'owner', actionId: action.id
    });
    const readback = await operations.verify({
      workspaceId: 'personal', ownerId: 'owner', actionId: action.id
    });
    if (readback.verification?.status !== 'satisfied')
      throw new Error(`Readback did not satisfy action ${action.id}`);
  }
} finally {
  store.close();
}
```

`ownerId` is a local trust binding. Passing it does not authenticate a remote user, connection, or provider. Handler implementations run as trusted in-process code; the registry is not a plugin sandbox.

Each connection binds one local ID to an exact provider subject. Connection metadata contains no credential and grants no capability by itself. Credentials, client construction, remote identity checks, resource namespaces, and write support are responsibilities of the trusted handler and its provider adapter.

A provider's customer/profile subject and its account or subscription resources may have different meanings. The handler defines and validates those semantics. Behalvo does not claim a universal banking API, infer equivalent accounts, or assume every provider supports writes.

Preparation reads a fresh observation and records an immutable expected result; it does not perform the mutation. The two actions above belong to one WorkItem but target distinct subjects, so the owner can approve their exact ID/digest pairs atomically. Approval is all-or-nothing for the supplied batch. It authorizes only those exact actions and digests until `expiresAt`, which must be a future UTC timestamp no more than 24 hours from the service clock. It does not authorize a broader goal, another resource, changed arguments, or a rebound connection.

## Scope serialization and uncertainty

Mutation attempts are serialized by workspace, provider, and verified remote subject. Different connection IDs do not create different subjects: two aliases bound to the same provider and subject share one barrier across connections, WorkItems, and runtime instances using the store. Distinct verified subjects can be prepared and approved together.

Every started attempt advances the subject revision. A running, unknown, or accepted-but-unverified action blocks new preparation in that scope. Do not prepare a replacement before uncertainty is settled. After satisfied readback or an explicit owner attestation, prepare a fresh replacement with a new key and a new observation.

An exception or malformed response after dispatch becomes `unknown`; it is not proof of failure. The runtime does not retry it automatically. `verify` reads the exact resource through the exact versioned handler. A satisfied readback can settle an unknown action as accepted without resubmitting it. A mismatching or unavailable readback cannot prove that the earlier mutation had no effect.

When provider readback is unavailable, leave the action unresolved while evidence is gathered or use the owner-only `reconcile` method with concrete evidence text, which the service stores as an artifact. Owner attestation is recorded separately from trusted readback and does not become provider verification. An accepted action may only be attested as accepted.

Evidence has distinct meanings:

| Evidence | What it establishes | What it does not establish |
| --- | --- | --- |
| Provider acceptance | The provider reported accepting one submission | Desired state, causation, or completion |
| Satisfied handler readback | The handler observed its expected resource state | That this action caused it or every account was covered |
| Owner attestation | The owner explicitly resolved an ambiguous action | Provider-authenticated state |
| WorkItem evidence and phase | The owner-controlled work record changed | Automatic exhaustive account discovery |

## Public API

All names below are exported from `src/index.ts`.

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

The exact service inputs are:

```ts
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
```

A handler is bound to one provider, operation ID, and version. It must validate JSON arguments, identify the current remote subject for the connection, return fresh scoped observations, construct a pure preparation, compare preconditions, submit one command, and classify readback strictly:

```ts
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
```

Handlers must enforce their connection and resource obligations on every callback, treat external content as untrusted input, keep observations and evidence within runtime limits, and avoid putting secrets in connection metadata or error evidence. They are responsible for provider authentication outside this API.

The runtime rechecks local identity, generation, approval, work revision, subject revision, freshness, and preconditions before starting. A handler should also use a saved provider version or equivalent conditional write when the provider supports it. Without a provider-side conditional write, another external actor can still race after preflight; local serialization cannot eliminate that remote race.

## Current integration limits

The repository ships no real account, banking, subscription, profile, or credential adapter. It does not discover remote resources, prove that aliases across different provider subjects refer to the same person, authenticate public callers, protect secrets, provide cross-workspace coordination, or determine that a WorkItem is complete. Recovery requires exclusive maintenance and converts interrupted attempts to unknown without dispatching them. Real integrations need provider-specific authentication, protected credentials, resource contracts, conditional-write behavior, readback semantics, rate limits, and independent security review.
