import type { OperationExecutionContext } from '../operations/execution-context.js';
export type { BrowserScope, BrowserControl, BrowserObservation, BrowserCommand, TaskInputBinding } from '../kernel/browser-types.js';
import type { BrowserScope, BrowserObservation, BrowserCommand } from '../kernel/browser-types.js';
export interface BrowserExecution extends BrowserScope {
    execution: OperationExecutionContext;
    /** Trusted synchronous authority check immediately before browser gestures/network dispatch. */
    assertCurrent(): void;
    resolveInput(id: string, origin: string, purpose: string): string;
}
export interface SemanticBrowserPort {
    observe(context: BrowserExecution): Promise<BrowserObservation>;
    interact(context: BrowserExecution, command: BrowserCommand): Promise<BrowserObservation>;
    close(): Promise<{ confirmed: boolean }>;
}
