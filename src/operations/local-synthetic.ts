import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import type { SqliteStore } from '../storage/sqlite-store.js';
import { CONTACT_RESOURCE, SUBSCRIPTION_RESOURCE, contactState, subscriptionState,
    SyntheticContactUpdateHandler, SyntheticSubscriptionCancellationHandler,
    type ContactProfile, type Subscription, type SyntheticAccountProvider } from './demo-handlers.js';
import type { Connection, HandlerObservation, JsonValue } from './types.js';
import type { OperationRegistry } from './registry.js';
import type { OperationService } from './service.js';

const PROVIDER = 'synthetic-accounts';
const SUBJECT = 'synthetic-person';
const CONNECTION = { id: 'synthetic-account', provider: PROVIDER, subject: SUBJECT,
    label: 'SYNTHETIC ONLY — simulated account, no real effects' };

/** Independent provider truth: replaying the domain journal never applies these mutations. */
export class PersistentSyntheticOperationsProvider implements SyntheticAccountProvider {
    readonly #db: DatabaseSync;
    #closed = false;
    constructor(path: string, private readonly workspaceId: string, private readonly clock: () => string = () => new Date().toISOString()) {
        this.#db = new DatabaseSync(path);
        try {
            this.#db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000');
            const version = Number(this.#db.prepare('PRAGMA user_version').get()!.user_version);
            if (version !== 0 && version !== 1) throw new Error('Unsupported synthetic provider state version');
            if (version === 0) this.#db.exec(`BEGIN IMMEDIATE;
                CREATE TABLE resources (workspace_id TEXT NOT NULL, provider TEXT NOT NULL, subject TEXT NOT NULL,
                    resource_id TEXT NOT NULL, state_json TEXT NOT NULL, version INTEGER NOT NULL CHECK(version>0),
                    PRIMARY KEY(workspace_id,provider,subject,resource_id));
                PRAGMA user_version=1;
                COMMIT;`);
        } catch (error) { this.#db.close(); throw error; }
    }
    close(): void { if (!this.#closed) { this.#db.close(); this.#closed = true; } }

    initialize(allowSeed: boolean): void {
        this.#db.exec('BEGIN IMMEDIATE');
        try {
            for (const [resource, state] of [
                [CONTACT_RESOURCE, { kind: 'contact-profile', email: 'synthetic@example.test', locale: 'en-US' }],
                [SUBSCRIPTION_RESOURCE, { kind: 'subscription', plan: 'Synthetic demo plan', status: 'active', cancellationReason: null }]
            ] as const) {
                const row = this.row(SUBJECT, resource);
                if (row) this.validate(resource, JSON.parse(String(row.state_json)), row.version);
                else {
                    if (!allowSeed) throw new Error('Prior synthetic provider resource state is unavailable; refusing to reseed');
                    this.#db.prepare('INSERT INTO resources VALUES (?,?,?,?,?,1)')
                        .run(this.workspaceId, PROVIDER, SUBJECT, resource, JSON.stringify(state));
                }
            }
            this.#db.exec('COMMIT');
        } catch (error) { this.#db.exec('ROLLBACK'); throw error; }
    }

    identify(connection: Readonly<Connection>): string {
        if (connection.provider !== PROVIDER || connection.subject !== SUBJECT || connection.id !== CONNECTION.id)
            throw new Error('Synthetic provider connection binding mismatch');
        return connection.subject;
    }
    observeContact(connection: Readonly<Connection>, resourceId: string): HandlerObservation {
        if (resourceId !== CONTACT_RESOURCE) throw new Error('Synthetic contact resource mismatch');
        return this.observe(connection, resourceId, 'contact');
    }
    observeSubscription(connection: Readonly<Connection>, resourceId: string): HandlerObservation {
        if (resourceId !== SUBSCRIPTION_RESOURCE) throw new Error('Synthetic subscription resource mismatch');
        return this.observe(connection, resourceId, 'subscription');
    }
    updateContact(connection: Readonly<Connection>, expected: ContactProfile): void {
        this.write(connection, CONTACT_RESOURCE, contactState(expected));
    }
    cancelSubscription(connection: Readonly<Connection>, expected: Subscription): void {
        this.write(connection, SUBSCRIPTION_RESOURCE, subscriptionState(expected));
    }
    private row(subject: string, resource: string) {
        return this.#db.prepare('SELECT state_json,version FROM resources WHERE workspace_id=? AND provider=? AND subject=? AND resource_id=?')
            .get(this.workspaceId, PROVIDER, subject, resource);
    }
    private validate(resource: string, value: JsonValue, version: unknown): JsonValue {
        if (!Number.isSafeInteger(version) || Number(version) < 1) throw new Error('Invalid synthetic resource version');
        return resource === CONTACT_RESOURCE ? contactState(value) : subscriptionState(value);
    }
    private observe(connection: Readonly<Connection>, resource: string, prefix: string): HandlerObservation {
        const row = this.row(this.identify(connection), resource);
        if (!row) throw new Error('Synthetic resource state unavailable');
        const state = this.validate(resource, JSON.parse(String(row.state_json)), row.version);
        return { state, providerVersion: `${prefix}:${row.version}`, resourceId: resource,
            source: `synthetic-${prefix}-readback`, observedAt: this.clock() };
    }
    private write(connection: Readonly<Connection>, resource: string, state: JsonValue): void {
        const subject = this.identify(connection);
        this.#db.exec('BEGIN IMMEDIATE');
        try {
            const row = this.row(subject, resource);
            if (!row) throw new Error('Synthetic resource state unavailable');
            this.validate(resource, JSON.parse(String(row.state_json)), row.version);
            const version = Number(row.version) + 1;
            this.validate(resource, state, version);
            this.#db.prepare('UPDATE resources SET state_json=?, version=? WHERE workspace_id=? AND provider=? AND subject=? AND resource_id=?')
                .run(JSON.stringify(state), version, this.workspaceId, PROVIDER, subject, resource);
            this.#db.exec('COMMIT'); // Persist the simulated effect before acknowledging acceptance.
        } catch (error) { this.#db.exec('ROLLBACK'); throw error; }
    }
}

export function openSyntheticOperations(store: SqliteStore, registry: OperationRegistry, service: OperationService,
    input: { dbPath: string; workspaceId: string; ownerId: string }): PersistentSyntheticOperationsProvider {
    const state = store.state(input.workspaceId);
    const existing = state.connections[CONNECTION.id];
    if (existing && (existing.provider !== PROVIDER || existing.subject !== SUBJECT))
        throw new Error('Existing synthetic connection binding changed; refusing to rebind');
    const prior = Boolean(existing) || Object.keys(state.actions).length > 0;
    const path = input.dbPath === ':memory:' ? ':memory:' : `${input.dbPath}.synthetic.sqlite`;
    if (prior && path !== ':memory:' && !existsSync(path)) throw new Error('Prior synthetic provider state is unavailable; refusing to reseed');
    const provider = new PersistentSyntheticOperationsProvider(path, input.workspaceId);
    try {
        provider.initialize(!prior);
        registry.register(new SyntheticContactUpdateHandler(provider));
        registry.register(new SyntheticSubscriptionCancellationHandler(provider));
        if (!existing) service.registerConnection({ workspaceId: input.workspaceId, ownerId: input.ownerId, connection: CONNECTION });
        // Revoked connections stay revoked; matching active generations are reused unchanged.
        return provider;
    } catch (error) { provider.close(); throw error; }
}
