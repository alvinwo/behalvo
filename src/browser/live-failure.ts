/** Fixed diagnostics only: never include page content, input values or transport errors. */
export const noDispatchCodes = ['control_missing','control_changed','control_covered','field_ambiguous','option_changed','deadline_expired'] as const;
export type NoDispatchCode = typeof noDispatchCodes[number];
export type WorldDispatchReceipt = {status:'dispatched'} | {status:'not_dispatched';code:NoDispatchCode};
export type BrowserActionDiagnostic =
    {phase:'validation';code:NoDispatchCode|'pre_dispatch_stopped'} |
    {phase:'dispatch';code:'dispatch_unconfirmed'} |
    {phase:'navigation';code:'navigation_unsettled'} |
    {phase:'observation';code:'observation_unavailable'};

/** The receipt is read only from the current private-world dispatch RPC. */
export function parseDispatchReceipt(value:unknown):WorldDispatchReceipt {
    if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Invalid dispatch receipt');
    const record=value as Record<string,unknown>,keys=Object.keys(record).sort().join(',');
    if(keys==='status'&&record.status==='dispatched')return {status:'dispatched'};
    if(keys==='code,status'&&record.status==='not_dispatched'&&noDispatchCodes.includes(record.code as NoDispatchCode))return {status:'not_dispatched',code:record.code as NoDispatchCode};
    throw new Error('Invalid dispatch receipt');
}
export class BrowserDiagnosticError extends Error {
    readonly diagnostic:BrowserActionDiagnostic;
    constructor(diagnostic:BrowserActionDiagnostic){super(diagnostic.code);this.diagnostic=Object.freeze({...diagnostic});}
}
export class BrowserNoDispatchError extends BrowserDiagnosticError {
    constructor(receipt:WorldDispatchReceipt){
        const proof=parseDispatchReceipt(receipt);
        if(proof.status!=='not_dispatched')throw new Error('No-dispatch proof required');
        super({phase:'validation',code:proof.code});
    }
}
export interface BrowserStoppedResult {
    actionId:string;status:'unknown'|'failed'|'rejected'|'reject'|'handoff';
    diagnostic?:BrowserActionDiagnostic;disposition?:'not_dispatched';
}
export function recoverableBrowserFailure(result:BrowserStoppedResult):boolean {
    return result.status==='failed'&&result.disposition==='not_dispatched'&&result.diagnostic?.phase==='validation'&&
        noDispatchCodes.some(code=>code!=='deadline_expired'&&code===result.diagnostic?.code);
}
export class BrowserActionStopped extends Error implements BrowserStoppedResult {
    readonly actionId:string;readonly status:BrowserStoppedResult['status'];
    readonly diagnostic?:BrowserActionDiagnostic;readonly disposition?:'not_dispatched';
    constructor(result:BrowserStoppedResult){
        super('Browser action stopped');this.actionId=result.actionId;this.status=result.status;
        if(result.diagnostic)this.diagnostic=Object.freeze({...result.diagnostic});
        if(result.disposition)this.disposition=result.disposition;
    }
}
