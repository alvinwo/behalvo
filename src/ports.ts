import type { Command, MessageInput, OutcomeStatus } from './kernel/types.js';
import type { ContextPacket } from './memory/context.js';
/** Network adapters authenticate and bind principals BEFORE passing input to the store. */
export interface ChannelAdapter {
    readonly id: string;
    readonly capabilities: {
        receive: boolean;
        send: boolean;
        relay: boolean;
        providerIdempotency: boolean;
        readback: boolean;
    };
    start(onVerifiedInput: (workspaceId: string, message: MessageInput) => Promise<void>): Promise<void>;
    stop(): Promise<void>;
}
export interface EffectRequest {
    workspaceId: string;
    actionId: string;
    attemptId: string;
    idempotencyKey: string;
    command: Readonly<Command>;
}
export interface EffectOutcome {
    status: OutcomeStatus;
    evidence: string;
}
export interface EffectDriver {
    readonly channel: string;
    execute(request: EffectRequest): Promise<EffectOutcome>;
}
export interface Proposal {
    workId: string;
    key: string;
    command: Command;
}
/** Proposal-only seam; M0 deliberately has no production model implementation. */
export interface Planner {
    propose(context: Readonly<ContextPacket>): Promise<readonly Proposal[]>;
}
export type TokenCounter = (text: string) => number;
