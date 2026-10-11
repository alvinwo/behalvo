import { browserOrigin, text } from './semantic-validation.js';
/** Trusted, reviewed request/effect classification. It contains no task goals or preferred answers. */
export interface SemanticFixturePolicy {
    origin: string;
    routes: {path:string;query:Record<string,readonly string[]>}[];
    fields: {path:string;name:string;purpose:string}[];
}
export function requestAllowed(policy:SemanticFixturePolicy,method:string,address:string):boolean {
    try {
        browserOrigin(policy.origin);const url=new URL(address);
        if(method!=='GET'||url.origin!==policy.origin||url.username||url.password||url.hash)return false;
        const route=policy.routes.find(r=>r.path===url.pathname);if(!route)return false;
        const keys=[...url.searchParams.keys()];
        return new Set(keys).size===keys.length&&keys.length===Object.keys(route.query).length&&keys.every(k=>Object.hasOwn(route.query,k)&&route.query[k]!.includes(url.searchParams.get(k)!));
    }catch{return false;}
}
export function fieldPurpose(policy:SemanticFixturePolicy,path:string,name:string):string {
    const entry=policy.fields.find(f=>f.path===path&&f.name===name);if(!entry)throw new Error('Unsupported input field');text(entry.purpose);return entry.purpose;
}
