import type { Action, OutcomeStatus } from '../kernel/types.js';

export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface Connection {
    id: string;
    provider: string;
    subject: string;
    label: string;
    generation: number;
    status: 'active' | 'revoked';
}

export interface OperationPrecondition {
    state: JsonValue;
    providerVersion?: string;
    source: string;
    observedAt: string;
}

export interface OperationObservation extends OperationPrecondition {
    connectionId: string;
    provider: string;
    subject: string;
    connectionGeneration: number;
    resourceId: string;
    source: string;
    observedAt: string;
}

export interface OperationCommand {
    kind: 'operation.execute';
    operationId: string;
    operationVersion: string;
    connectionId: string;
    provider: string;
    subject: string;
    connectionGeneration: number;
    resourceId: string;
    arguments: JsonValue;
    affectedResourceIds: string[];
    precondition: OperationPrecondition;
    expectedResult: JsonValue;
    subjectRevision: number;
    requestFingerprint: string;
}

export type HandlerObservation = {
    source: string;
    observedAt: string;
    state: JsonValue;
    providerVersion?: string;
    resourceId?: string;
};

export interface OperationPreparation {
    arguments: JsonValue;
    affectedResourceIds: string[];
    expectedResult: JsonValue;
}

export interface OperationExecutionOutcome {
    status: OutcomeStatus;
    evidence: string;
}

export type HandlerVerificationVerdict = {
    status: 'satisfied' | 'not_satisfied' | 'unknown';
};

export type VerificationState = {
    status: 'satisfied' | 'not_satisfied' | 'unknown';
    observation: OperationObservation;
    recordedAt: string;
} | {
    status: 'owner_attested';
    resolution: 'accepted' | 'failed';
    evidenceRef: string;
    recordedAt: string;
};

export interface OperationHandler {
    readonly provider: string;
    readonly id: string;
    readonly version: string;
    validateArguments(value: unknown): JsonValue;
    identify(input: { connection: Readonly<Connection> }): Promise<string>;
    observe(input: { connection: Readonly<Connection>; resourceId: string }): Promise<HandlerObservation>;
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

export interface OperationMetadata { provider: string; id: string; version: string; }

export interface RegisterConnectionInput {
    workspaceId: string;
    ownerId: string;
    connection: { id: string; provider: string; subject: string; label: string };
}
export interface RevokeConnectionInput { workspaceId: string; ownerId: string; connectionId: string; }
export interface PrepareOperationInput {
    workspaceId: string;
    ownerId: string;
    workId: string;
    key: string;
    connectionId: string;
    operationId: string;
    operationVersion: string;
    resourceId: string;
    arguments: unknown;
}
export interface ApproveOperationBatchInput {
    workspaceId: string;
    ownerId: string;
    expiresAt: string;
    approvals: { actionId: string; digest: string }[];
}
export interface ExecuteOperationInput { workspaceId: string; ownerId: string; actionId: string; }
export interface VerifyOperationInput { workspaceId: string; ownerId: string; actionId: string; }
export interface ReconcileOperationInput {
    workspaceId: string;
    ownerId: string;
    actionId: string;
    status: 'accepted' | 'failed';
    evidence: string;
}
export interface RecoverOperationsInput { workspaceId: string; exclusiveMaintenance: boolean; }

export type OperationAction = Action & { command: OperationCommand };
