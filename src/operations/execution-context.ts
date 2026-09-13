/** An application-owned stop reason; no raw provider error text is used for classification. */
export class OperationStoppedError extends Error {
    constructor() { super('Operation run stopped at cancellation or deadline'); }
}

/** Trusted runtime control, deliberately separate from model-derived input objects. */
export interface OperationExecutionContext {
    signal?: AbortSignal;
    /** Absolute wall-clock deadline in milliseconds. */
    deadline: number;
}

export function assertExecutionActive(context?: OperationExecutionContext): void {
    if (context && (context.signal?.aborted || Date.now() >= context.deadline))
        throw new OperationStoppedError();
}

/** Consumes late fulfillment/rejection without allowing a continuation to mutate the journal. */
export async function withinExecution<T>(callback: () => T | Promise<T>, context?: OperationExecutionContext): Promise<T> {
    assertExecutionActive(context);
    if (!context) return callback();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: (() => void) | undefined;
    const stopped = new Promise<never>((_, reject) => {
        abort = () => reject(new OperationStoppedError());
        context.signal?.addEventListener('abort', abort, { once: true });
        timer = setTimeout(abort, Math.max(0, context.deadline - Date.now()));
    });
    try {
        const result = await Promise.race([Promise.resolve().then(() => {
            assertExecutionActive(context);
            return callback();
        }), stopped]);
        assertExecutionActive(context);
        return result;
    } finally {
        clearTimeout(timer);
        if (abort) context.signal?.removeEventListener('abort', abort);
    }
}
