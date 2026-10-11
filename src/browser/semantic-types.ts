import type { OperationExecutionContext } from '../operations/execution-context.js';
import type { TeachingSource } from '../kernel/teachings.js';
export interface BrowserScope {
    workspaceId: string; workId: string; workRevision: number; sessionId: string; generation: number;
}
export interface BrowserControl {
    ref: string; role: 'link' | 'button' | 'textbox' | 'combobox'; name: string;
    actions: ('navigate' | 'click' | 'fill' | 'select')[];
    options: { ref: string; name: string }[];
}
export interface BrowserObservation extends BrowserScope {
    id: string; documentId: string; origin: string; location: string; observedAt: string;
    text: string; controls: BrowserControl[];
}
export type BrowserCommand = { kind: 'navigate' | 'click'; observationId: string; ref: string } |
    { kind: 'fill'; observationId: string; ref: string; taskInputId: string } |
    { kind: 'select'; observationId: string; ref: string; optionRef: string };
export interface TaskInputBinding extends TeachingSource {
    id: string; workspaceId: string; workId: string; workRevision: number; origin: string;
    purpose: string; status: 'active' | 'revoked';
}
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
