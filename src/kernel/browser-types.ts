import type { TeachingSource } from './teachings.js';
export interface BrowserScope {
    workspaceId: string; workId: string; workRevision: number; sessionId: string; generation: number;
}
export interface BrowserControl {
    ref: string; role: 'link' | 'button' | 'textbox' | 'combobox' | 'login'; name: string;
    actions: ('navigate' | 'click' | 'fill' | 'select' | 'request_login')[];
    options: { ref: string; name: string }[];
}
export interface BrowserObservation extends BrowserScope {
    id: string; documentId: string; origin: string; location: string; observedAt: string;
    text: string; controls: BrowserControl[];
}
export type BrowserCommand = { kind: 'navigate' | 'click'; observationId: string; ref: string } |
    { kind: 'request_login'; observationId: string; ref: string } |
    { kind: 'fill'; observationId: string; ref: string; taskInputId: string } |
    { kind: 'select'; observationId: string; ref: string; optionRef: string };
export interface TaskInputBinding extends TeachingSource {
    id: string; workspaceId: string; workId: string; workRevision: number; origin: string;
    purpose: string; status: 'active' | 'revoked';
}
