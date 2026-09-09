import { identifier } from '../kernel/types.js';
import type { OperationHandler, OperationMetadata } from './types.js';

export class OperationRegistry {
    readonly #handlers = new Map<string, OperationHandler>();

    register(handler: OperationHandler): void {
        if (!handler || typeof handler !== 'object') throw new Error('Invalid operation handler');
        identifier(handler.provider, 'provider');
        identifier(handler.id, 'operationId');
        identifier(handler.version, 'operationVersion');
        for (const method of ['validateArguments', 'identify', 'observe', 'prepare', 'comparePrecondition', 'execute', 'verify'] as const)
            if (typeof handler[method] !== 'function') throw new Error(`Invalid operation handler method: ${method}`);
        const key = this.#key(handler.provider, handler.id, handler.version);
        if (this.#handlers.has(key)) throw new Error('Duplicate operation handler registration');
        this.#handlers.set(key, Object.freeze({
            provider: handler.provider, id: handler.id, version: handler.version,
            validateArguments: handler.validateArguments.bind(handler),
            identify: handler.identify.bind(handler), observe: handler.observe.bind(handler),
            prepare: handler.prepare.bind(handler), comparePrecondition: handler.comparePrecondition.bind(handler),
            execute: handler.execute.bind(handler), verify: handler.verify.bind(handler)
        }));
    }

    resolve(provider: string, id: string, version: string): OperationHandler {
        identifier(provider, 'provider'); identifier(id, 'operationId'); identifier(version, 'operationVersion');
        const handler = this.#handlers.get(this.#key(provider, id, version));
        if (!handler) throw new Error(`Operation handler not registered: ${provider}/${id}@${version}`);
        return handler;
    }

    list(filter: { provider?: string } = {}): OperationMetadata[] {
        if (Object.keys(filter).some(key => key !== 'provider')) throw new Error('Unknown operation list filter');
        if (filter.provider !== undefined) identifier(filter.provider, 'provider');
        return [...this.#handlers.values()]
            .filter(handler => filter.provider === undefined || handler.provider === filter.provider)
            .map(({ provider, id, version }) => ({ provider, id, version }))
            .sort((a, b) => `${a.provider}/${a.id}@${a.version}`.localeCompare(`${b.provider}/${b.id}@${b.version}`));
    }

    #key(provider: string, id: string, version: string): string { return `${provider}\u0000${id}\u0000${version}`; }
}
