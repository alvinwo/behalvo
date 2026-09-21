import type { ServiceJobClaim } from '../storage/service-jobs.js';

/** An application-owned stop reason; no raw provider error text is used for classification. */
export class OperationStoppedError extends Error {
    constructor() { super('Operation run stopped at cancellation or deadline'); }
}

/** Trusted abort provenance used to distinguish elapsed deadlines from operator cancellation. */
export class OperationDeadlineError extends OperationStoppedError {
    constructor() { super(); this.name = 'OperationDeadlineError'; }
}

export interface TrustedExecutionFence {
    readonly serviceGeneration: string;
    readonly deadline: number;
    readonly signal: AbortSignal;
    assertCurrent(): Promise<void>;
    /** Allows only a fixed application stop receipt after cancellation/deadline. */
    assertSettlementCurrent?(): void;
}

/** Trusted runtime control, deliberately separate from model-derived input objects. */
export interface OperationExecutionContext {
    signal?: AbortSignal;
    /** Absolute wall-clock deadline in milliseconds. */
    deadline: number;
    /** Rechecks lifecycle generations owned outside this operation module. */
    assertCurrent?: () => Promise<void>;
    /** Present only for the durable service worker that owns this exact action execution or readback. */
    serviceClaim?: ServiceJobClaim;
}

export function assertExecutionActive(context?: OperationExecutionContext): void {
    if (!context) return;
    if (context.signal?.reason instanceof OperationDeadlineError) throw context.signal.reason;
    if (Date.now() >= context.deadline) throw new OperationDeadlineError();
    if (context.signal?.aborted) throw new OperationStoppedError();
}

export function executionDeadlineReached(context: Pick<OperationExecutionContext, 'signal' | 'deadline'>,
    error?: unknown): boolean {
    return error instanceof OperationDeadlineError || Date.now() >= context.deadline ||
        context.signal?.reason instanceof OperationDeadlineError;
}

export async function assertExecutionCurrent(context?: OperationExecutionContext): Promise<void> {
    assertExecutionActive(context);
    await context?.assertCurrent?.();
    assertExecutionActive(context);
}

/** Consumes late fulfillment/rejection without allowing a continuation to mutate the journal. */
export async function withinExecution<T>(callback: () => T | Promise<T>, context?: OperationExecutionContext): Promise<T> {
    await assertExecutionCurrent(context);
    if (!context) return callback();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: (() => void) | undefined;
    let deadline: (() => void) | undefined;
    const stopped = new Promise<never>((_, reject) => {
        abort = () => reject(new OperationStoppedError());
        context.signal?.addEventListener('abort', abort, { once: true });
        deadline = () => reject(new OperationDeadlineError());
        timer = setTimeout(deadline, Math.max(0, context.deadline - Date.now()));
    });
    try {
        const result = await Promise.race([Promise.resolve().then(() => {
            assertExecutionActive(context);
            return callback();
        }), stopped]);
        await assertExecutionCurrent(context);
        return result;
    } finally {
        clearTimeout(timer);
        if (abort) context.signal?.removeEventListener('abort', abort);
    }
}
