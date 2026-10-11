import { exact, text, parseBrowserCommand } from './browser-contract.js';
import type { State } from './types.js';

/** Audit-only description. Persisted refs never reconnect a browser or authorize a new lease. */
export type LiveBrowserGesture =
    {kind:'navigate'|'click';observationId:string;ref:string} |
    {kind:'fill';observationId:string;ref:string;taskInputId:string} |
    {kind:'select';observationId:string;ref:string;optionRef:string};
export type BrowserActionCommand = {
    kind: 'browser.gesture'; version: 1;
    threadId: string; sessionId: string; generation: number; grantRevision: number; origin: string;
} & ({operation:'open'|'visit';url:string} | {operation:'interact';documentId:string;controlFingerprint:string;gesture:LiveBrowserGesture});
export function isBrowserActionCommand(value: unknown): value is BrowserActionCommand {
    return !!value && typeof value==='object' && (value as {kind?:unknown}).kind==='browser.gesture';
}
export function validateBrowserActionCommand(value: unknown): asserts value is BrowserActionCommand {
    const operation=(value as {operation?:unknown})?.operation;
    if(operation!=='open'&&operation!=='visit'&&operation!=='interact')throw new Error('Invalid browser operation');
    const c=exact(value,['kind','version','threadId','sessionId','generation','grantRevision','origin','operation',
        ...(operation!=='interact'?['url']:['documentId','controlFingerprint','gesture'])]);
    if(c.kind!=='browser.gesture'||c.version!==1)throw new Error('Invalid browser command version');
    for(const key of ['threadId','sessionId'])text(c[key]);
    text(c.origin,2048);
    for(const key of ['generation','grantRevision'])if(!Number.isSafeInteger(c[key])||(c[key] as number)<1)throw new Error('Invalid browser generation');
    const origin=new URL(c.origin);
    if(origin.origin!==c.origin||origin.protocol!=='https:'||origin.username||origin.password)throw new Error('Browser action requires an exact HTTPS origin');
    if(operation!=='interact') {
        text(c.url,4096);const url=new URL(c.url);
        if(url.origin!==c.origin||url.username||url.password)throw new Error('Opening origin mismatch');
    } else {
        text(c.documentId);text(c.controlFingerprint);
        if(!/^[a-f0-9]{64}$/.test(c.controlFingerprint))throw new Error('Invalid browser descriptor digest');
        const gesture=parseBrowserCommand(c.gesture);
        if(gesture.kind==='request_login')throw new Error('Live browser credentials require handoff');
    }
}
export function assertNoUnknownBrowserAction(state: State, workId: string): void {
    if(Object.values(state.actions).some(a=>a.workId===workId&&isBrowserActionCommand(a.command)&&['running','unknown'].includes(a.status)))
        throw new Error('Unresolved or unknown browser gesture blocks further dispatch for this work');
}
