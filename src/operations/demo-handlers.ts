import type {
  Connection,
  HandlerObservation,
  JsonValue,
  OperationCommand,
  OperationHandler,
  OperationObservation,
  OperationPrecondition
} from '../index.js';

const PROVIDER = 'synthetic-accounts';
export const CONTACT_RESOURCE = 'contact-profile';
export const SUBSCRIPTION_RESOURCE = 'subscription';

type ContactProfile = {
  kind: 'contact-profile';
  email: string;
  locale: string;
};

type Subscription = {
  kind: 'subscription';
  plan: string;
  status: 'active' | 'cancelled';
  cancellationReason: string | null;
};

type Versioned<T> = { state: T; version: number };

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index]))
    throw new Error(`${label} has unexpected fields`);
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 200)
    throw new Error(`${label} must be a non-empty string of at most 200 characters`);
  return value;
}

function contactState(value: JsonValue): ContactProfile {
  const input = record(value, 'contact state');
  exactKeys(input, ['kind', 'email', 'locale'], 'contact state');
  if (input.kind !== 'contact-profile') throw new Error('Invalid contact state kind');
  return {
    kind: 'contact-profile',
    email: text(input.email, 'contact email'),
    locale: text(input.locale, 'contact locale')
  };
}

function subscriptionState(value: JsonValue): Subscription {
  const input = record(value, 'subscription state');
  exactKeys(input, ['kind', 'plan', 'status', 'cancellationReason'], 'subscription state');
  if (input.kind !== 'subscription' || !['active', 'cancelled'].includes(String(input.status)) ||
      (input.cancellationReason !== null && typeof input.cancellationReason !== 'string'))
    throw new Error('Invalid subscription state');
  return {
    kind: 'subscription',
    plan: text(input.plan, 'subscription plan'),
    status: input.status as Subscription['status'],
    cancellationReason: input.cancellationReason as string | null
  };
}

function sameState(expected: Readonly<OperationPrecondition>, actual: Readonly<OperationObservation>): boolean {
  return expected.providerVersion === actual.providerVersion &&
    JSON.stringify(expected.state) === JSON.stringify(actual.state);
}

/** In-memory provider used only by the offline operations demonstration. */
export class SyntheticOperationsProvider {
  readonly provider = PROVIDER;
  #contacts = new Map<string, Versioned<ContactProfile>>();
  #subscriptions = new Map<string, Versioned<Subscription>>();
  #loseContactResponse = false;
  #submissionCount = 0;

  constructor(private readonly clock: () => string) { }

  seedContact(subject: string, state: Omit<ContactProfile, 'kind'>): void {
    this.#contacts.set(subject, { state: { kind: 'contact-profile', ...state }, version: 1 });
  }

  seedSubscription(subject: string, state: Omit<Subscription, 'kind'>): void {
    this.#subscriptions.set(subject, { state: { kind: 'subscription', ...state }, version: 1 });
  }

  loseNextContactResponse(): void { this.#loseContactResponse = true; }

  get submissionCount(): number { return this.#submissionCount; }

  identify(connection: Readonly<Connection>): string {
    if (connection.provider !== PROVIDER) throw new Error('Synthetic provider binding mismatch');
    return connection.subject;
  }

  observeContact(connection: Readonly<Connection>, resourceId: string): HandlerObservation {
    if (resourceId !== CONTACT_RESOURCE) throw new Error('Contact handler requires the contact-profile resource');
    const row = this.#contacts.get(this.identify(connection));
    if (!row) throw new Error('Synthetic contact subject is unavailable');
    return {
      source: 'synthetic-contact-readback', observedAt: this.clock(), resourceId,
      providerVersion: `contact:${row.version}`, state: structuredClone(row.state)
    };
  }

  observeSubscription(connection: Readonly<Connection>, resourceId: string): HandlerObservation {
    if (resourceId !== SUBSCRIPTION_RESOURCE) throw new Error('Cancellation handler requires the subscription resource');
    const row = this.#subscriptions.get(this.identify(connection));
    if (!row) throw new Error('Synthetic subscription subject is unavailable');
    return {
      source: 'synthetic-subscription-readback', observedAt: this.clock(), resourceId,
      providerVersion: `subscription:${row.version}`, state: structuredClone(row.state)
    };
  }

  updateContact(connection: Readonly<Connection>, expected: ContactProfile): void {
    const subject = this.identify(connection);
    const row = this.#contacts.get(subject);
    if (!row) throw new Error('Synthetic contact subject is unavailable');
    this.#submissionCount++;
    this.#contacts.set(subject, { state: structuredClone(expected), version: row.version + 1 });
    if (this.#loseContactResponse) {
      this.#loseContactResponse = false;
      throw new Error('Synthetic response lost after applying contact update');
    }
  }

  cancelSubscription(connection: Readonly<Connection>, expected: Subscription): void {
    const subject = this.identify(connection);
    const row = this.#subscriptions.get(subject);
    if (!row) throw new Error('Synthetic subscription subject is unavailable');
    this.#submissionCount++;
    this.#subscriptions.set(subject, { state: structuredClone(expected), version: row.version + 1 });
  }
}

export class SyntheticContactUpdateHandler implements OperationHandler {
  readonly provider = PROVIDER;
  readonly id = 'contact.update';
  readonly version = '1';

  constructor(private readonly remote: SyntheticOperationsProvider) { }

  validateArguments(value: unknown): JsonValue {
    const input = record(value, 'contact arguments');
    exactKeys(input, ['email'], 'contact arguments');
    return { email: text(input.email, 'contact email') };
  }

  async identify({ connection }: { connection: Readonly<Connection> }): Promise<string> {
    return this.remote.identify(connection);
  }

  async observe(input: { connection: Readonly<Connection>; resourceId: string }): Promise<HandlerObservation> {
    return this.remote.observeContact(input.connection, input.resourceId);
  }

  prepare(input: {
    connection: Readonly<Connection>;
    arguments: JsonValue;
    observation: Readonly<OperationObservation>;
  }) {
    const current = contactState(input.observation.state);
    const args = record(input.arguments, 'contact arguments');
    return {
      arguments: input.arguments,
      affectedResourceIds: [CONTACT_RESOURCE],
      expectedResult: { kind: 'contact-profile', email: text(args.email, 'contact email'), locale: current.locale }
    };
  }

  comparePrecondition(input: { expected: Readonly<OperationPrecondition>; actual: Readonly<OperationObservation> }): boolean {
    return sameState(input.expected, input.actual);
  }

  async execute(input: { connection: Readonly<Connection>; command: Readonly<OperationCommand> }) {
    if (input.command.resourceId !== CONTACT_RESOURCE) throw new Error('Contact command resource mismatch');
    this.remote.updateContact(input.connection, contactState(input.command.expectedResult));
    return { status: 'accepted' as const, evidence: 'Synthetic contact provider accepted the update; no remote API was called.' };
  }

  verify(input: { command: Readonly<OperationCommand>; observation: Readonly<OperationObservation> }) {
    contactState(input.observation.state);
    return {
      status: JSON.stringify(input.command.expectedResult) === JSON.stringify(input.observation.state)
        ? 'satisfied' as const : 'not_satisfied' as const
    };
  }
}

export class SyntheticSubscriptionCancellationHandler implements OperationHandler {
  readonly provider = PROVIDER;
  readonly id = 'subscription.cancel';
  readonly version = '1';

  constructor(private readonly remote: SyntheticOperationsProvider) { }

  validateArguments(value: unknown): JsonValue {
    const input = record(value, 'cancellation arguments');
    exactKeys(input, ['reason'], 'cancellation arguments');
    return { reason: text(input.reason, 'cancellation reason') };
  }

  async identify({ connection }: { connection: Readonly<Connection> }): Promise<string> {
    return this.remote.identify(connection);
  }

  async observe(input: { connection: Readonly<Connection>; resourceId: string }): Promise<HandlerObservation> {
    return this.remote.observeSubscription(input.connection, input.resourceId);
  }

  prepare(input: {
    connection: Readonly<Connection>;
    arguments: JsonValue;
    observation: Readonly<OperationObservation>;
  }) {
    const current = subscriptionState(input.observation.state);
    const args = record(input.arguments, 'cancellation arguments');
    return {
      arguments: input.arguments,
      affectedResourceIds: [SUBSCRIPTION_RESOURCE],
      expectedResult: {
        kind: 'subscription', plan: current.plan, status: 'cancelled',
        cancellationReason: text(args.reason, 'cancellation reason')
      }
    };
  }

  comparePrecondition(input: { expected: Readonly<OperationPrecondition>; actual: Readonly<OperationObservation> }): boolean {
    return sameState(input.expected, input.actual);
  }

  async execute(input: { connection: Readonly<Connection>; command: Readonly<OperationCommand> }) {
    if (input.command.resourceId !== SUBSCRIPTION_RESOURCE) throw new Error('Cancellation command resource mismatch');
    this.remote.cancelSubscription(input.connection, subscriptionState(input.command.expectedResult));
    return { status: 'accepted' as const, evidence: 'Synthetic subscription provider accepted cancellation; no remote API was called.' };
  }

  verify(input: { command: Readonly<OperationCommand>; observation: Readonly<OperationObservation> }) {
    subscriptionState(input.observation.state);
    return {
      status: JSON.stringify(input.command.expectedResult) === JSON.stringify(input.observation.state)
        ? 'satisfied' as const : 'not_satisfied' as const
    };
  }
}
