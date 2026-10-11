import type { OperationExecutionContext } from '../operations/execution-context.js';
export type { BrowserScope, BrowserControl, BrowserObservation, BrowserCommand, TaskInputBinding } from '../kernel/browser-types.js';
import type { BrowserScope, BrowserObservation, BrowserCommand } from '../kernel/browser-types.js';
import type { LoginChallenge, LoginUseResult } from '../vault/login-broker.js';
import type { LoginBytes } from '../vault/types.js';
export type BrowserLoginOutcome = 'signed_in' | 'rejected' | 'unknown';
export interface BrowserExecution extends BrowserScope {
    execution: OperationExecutionContext;
    /** Trusted synchronous authority check immediately before browser gestures/network dispatch. */
    assertCurrent(): void;
    resolveInput(id: string, origin: string, purpose: string): string;
    login?(challenge: Omit<LoginChallenge, 'ownerId'>,
      use: (login: LoginBytes, assertCurrent: () => void) => Promise<BrowserLoginOutcome>,
      assertBrowserCurrent: () => void): Promise<LoginUseResult<BrowserLoginOutcome>>;
}
export interface SemanticBrowserPort {
    observe(context: BrowserExecution): Promise<BrowserObservation>;
    interact(context: BrowserExecution, command: BrowserCommand): Promise<BrowserObservation>;
    close(): Promise<{ confirmed: boolean }>;
    /** Retaining a browser is distinct from proving process/profile cleanup. */
    retire?(healthy:boolean):Promise<{leaseRetired:boolean;sessionDisposition:'retained'|'human'|'closed';cleanupConfirmed?:boolean}>;
    handoff?():Promise<void>;
}
