import type { BrowserCommand, BrowserControl, BrowserObservation, BrowserScope, TaskInputBinding } from './browser-types.js';
import type { TeachingSource } from './teachings.js';
export function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length || keys.some(k => !Object.hasOwn(value,k))) throw new Error('Invalid browser contract');
    return value as Record<string,unknown>;
}
export function text(value: unknown, max = 256): asserts value is string {
    if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value,'utf8') > max) throw new Error('Invalid browser text');
}
export function sameScope(a: BrowserScope, b: BrowserScope): void {
    for (const key of ['workspaceId','workId','sessionId'] as const) { text(a[key]); if(a[key]!==b[key])throw new Error('Stale browser scope'); }
    for (const key of ['workRevision','generation'] as const) if (!Number.isSafeInteger(a[key]) || a[key]<1 || a[key]!==b[key]) throw new Error('Stale browser revision');
}
export function browserOrigin(value: string): void {
    const url=new URL(value);
    // Shape only. Network and origin authority belong to the selected adapter/controller.
    if(url.origin!==value || url.username || url.password ||
        !(url.protocol==='https:' || (url.protocol==='http:' && url.hostname==='127.0.0.1' && !!url.port)))throw new Error('Invalid browser origin');
}
export function validateObservation(raw: unknown, scope: BrowserScope): BrowserObservation {
    const x=exact(raw,['workspaceId','workId','workRevision','sessionId','generation','id','documentId','origin','location','observedAt','text','controls']);
    if(Buffer.byteLength(JSON.stringify(raw),'utf8')>32768)throw new Error('Browser observation budget exceeded');
    const v=x as unknown as BrowserObservation;sameScope(v,scope);text(v.id);text(v.documentId);text(v.origin,2048);browserOrigin(v.origin);
    text(v.location,2048);if(!v.location.startsWith('/')||v.location.includes('?')||v.location.includes('#')||new URL(v.location,v.origin).origin!==v.origin)throw new Error('Invalid sanitized location');
    text(v.observedAt);if(!Number.isFinite(Date.parse(v.observedAt)))throw new Error('Invalid observation time');
    if(typeof v.text!=='string')throw new Error('Invalid observation text');
    if(!Array.isArray(v.controls)||v.controls.length>100)throw new Error('Invalid browser controls');
    const refs=new Set<string>();const ref=(r:string)=>{text(r);if(refs.has(r))throw new Error('Duplicate browser reference');refs.add(r);};
    for(const c of v.controls){exact(c,['ref','role','name','actions','options']);ref(c.ref);text(c.name,2048);
        const allowed:Record<BrowserControl['role'],string>={link:'navigate',button:'click',textbox:'fill',combobox:'select',login:'request_login'};
        if(!Object.hasOwn(allowed,c.role)||!Array.isArray(c.actions)||c.actions.length!==1||c.actions[0]!==allowed[c.role]||!Array.isArray(c.options)||c.options.length>100)throw new Error('Invalid control shape');
        if(c.role!=='combobox'&&c.options.length)throw new Error('Unexpected options');
        for(const option of c.options){exact(option,['ref','name']);ref(option.ref);text(option.name,2048);}
    }
    return structuredClone(v);
}
export function parseBrowserCommand(raw: unknown): BrowserCommand {
    const kind=(raw as {kind?:unknown})?.kind;
    const keys=['kind','observationId','ref'];
    if(kind==='fill')keys.push('taskInputId');else if(kind==='select')keys.push('optionRef');else if(kind!=='navigate'&&kind!=='click'&&kind!=='request_login')throw new Error('Unsupported browser command');
    const x=exact(raw,keys);for(const key of keys)text(x[key]);return structuredClone(raw) as BrowserCommand;
}
export function resolveControl(observation: BrowserObservation, scope: BrowserScope, raw: unknown): BrowserControl {
    const command=parseBrowserCommand(raw);sameScope(observation,scope);
    const control=observation.controls.find(c=>c.ref===command.ref);
    if(command.observationId!==observation.id||!control||!control.actions.includes(command.kind)||
        (command.kind==='select'&&!control.options.some(o=>o.ref===command.optionRef)))throw new Error('Stale or invalid browser reference');
    return control;
}
export function exactInputSource(sourceRecordId:string, body:string, quote:string):TeachingSource {
    text(sourceRecordId);text(quote,4096);const start=body.indexOf(quote);
    if(start<0||body.lastIndexOf(quote)!==start)throw new Error('Input requires unique exact owner source');
    return {sourceRecordId,sourceQuote:quote,sourceStart:start,sourceEnd:start+quote.length};
}
export function resolveTaskInput(binding:TaskInputBinding,scope:Pick<BrowserScope,'workspaceId'|'workId'|'workRevision'>,origin:string,purpose:string):string {
    browserOrigin(origin);text(purpose);text(binding.sourceQuote,4096);
    if(binding.status!=='active'||binding.workspaceId!==scope.workspaceId||binding.workId!==scope.workId||binding.workRevision!==scope.workRevision||binding.origin!==origin||binding.purpose!==purpose)throw new Error('Task input disclosure not authorized');
    return binding.sourceQuote;
}
