import { createHash, randomUUID } from 'node:crypto';
import type { Browser, ElementHandle, Page } from 'playwright';
import type { BrowserActionCommand } from '../kernel/browser-action.js';
import { parseBrowserCommand, resolveControl, sameScope, validateObservation } from '../kernel/browser-contract.js';
import type { BrowserGestureExecution, BrowserGestureResult } from '../runtime/browser-actions.js';
import { assertExecutionActive, withinExecution } from '../operations/execution-context.js';
import { PlaywrightProcessOwner, type PlaywrightOwnerDependencies } from './playwright-process-owner.js';
import { PublicNetworkGate, publicHttpsUrl } from './public-network.js';
import { describeLiveControl, liveVisibleText } from './live-dom.js';
import type { BrowserCommand, BrowserControl, BrowserExecution, BrowserObservation, BrowserScope } from './semantic-types.js';

export interface LiveReviewDetail { operation:string; origin:string; name:string; value?:string }
export interface LivePlaywrightOptions {
    sessionId:string;threadId:string;network:PublicNetworkGate;assertSession():void;
    perform<T>(context:BrowserExecution,command:BrowserActionCommand,detail:LiveReviewDetail,gesture:Omit<BrowserGestureExecution<T>,'review'>):Promise<BrowserGestureResult<T>>;
}
export interface LivePlaywrightDependencies extends PlaywrightOwnerDependencies {
    /** Trusted synthetic TLS fixture seam; never exposed by product configuration. */
    ignoreHTTPSErrors?:boolean;
}
interface Entry {handle:ElementHandle;fingerprint:string;options:Map<string,number>;purpose:string}
interface InputDescriptor {ref:string;name:string;origin:string;purpose:string;fingerprint:string}
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** A session-owned page; executable handles exist only inside the current lease. */
export class LivePlaywright {
    readonly #owner:PlaywrightProcessOwner;readonly #abort=new AbortController();
    #page:Page|undefined;#current:BrowserExecution|undefined;#scope:BrowserScope|undefined;#observation:BrowserObservation|undefined;
    #entries=new Map<string,Entry>();#catalog=new Map<string,InputDescriptor>();#inputEpoch=1;#documentId=randomUUID();
    #busy=false;#human=false;#closed=false;#closePromise:Promise<{confirmed:boolean}>|undefined;
    constructor(private readonly options:LivePlaywrightOptions,private readonly dependencies:LivePlaywrightDependencies={}) {
        this.#owner=new PlaywrightProcessOwner({signal:this.#abort.signal},{...dependencies,networkProxy:options.network.proxyUrl});
    }
    get receiptPath():string{return this.#owner.receiptPath;}
    get human():boolean{return this.#human;}
    get location():string|undefined{if(!this.#page)return;try{const u=publicHttpsUrl(this.#page.url());return u.origin+u.pathname;}catch{return;}}
    #assertSession():void{if(this.#closed)throw new Error('Browser closed');this.options.assertSession();}
    #assert():void{this.#assertSession();if(this.#human||!this.#current)throw new Error('Browser lease absent');assertExecutionActive(this.#current.execution);this.#current.assertCurrent();if(this.#scope)sameScope(this.#scope,this.#current);}
    async #clearRefs():Promise<void>{const entries=[...this.#entries.values()];this.#entries.clear();this.#observation=undefined;await Promise.all(entries.map(e=>e.handle.dispose().catch(()=>{})));}
    #invalidateInputs():void{this.#catalog.clear();this.#inputEpoch++;}
    invalidateInputs():void{this.#invalidateInputs();}
    async #run<T>(context:BrowserExecution,operation:()=>Promise<T>):Promise<T>{
        if(this.#busy||this.#human||this.#closed||context.sessionId!==this.options.sessionId)throw new Error('Browser unavailable');
        if(this.#scope)sameScope(this.#scope,context);else this.#scope={workspaceId:context.workspaceId,workId:context.workId,workRevision:context.workRevision,sessionId:context.sessionId,generation:context.generation};
        this.#busy=true;this.#current=context;
        try{this.#assert();return await withinExecution(operation,context.execution);}finally{this.#current=undefined;this.#busy=false;}
    }
    async #start(browser:Browser):Promise<Page>{
        const context=await browser.newContext({serviceWorkers:'block',acceptDownloads:false,ignoreHTTPSErrors:this.dependencies.ignoreHTTPSErrors===true});
        let page:Page|undefined;
        context.on('page',candidate=>{if(page&&candidate!==page)void candidate.close().catch(()=>{});});
        await context.clearPermissions();
        await context.route('**/*',async route=>{
            let response;
            try{
                this.#assertSession();const request=route.request();
                if(!page||request.frame().page()!==page)throw new Error('Popup denied');
                this.options.network.assertAllowed(request.url());
                // Fulfill one hop at a time: continue() silently follows redirects past routing guards.
                response=await route.fetch({maxRedirects:0,maxRetries:0,timeout:10000});
                this.#assertSession();if(!this.options.network.allows(request.url()))throw new Error('Origin revoked');
                if(/attachment/i.test(response.headers()['content-disposition']??''))throw new Error('Download denied');
                await route.fulfill({response});
            }catch{await route.abort('blockedbyclient').catch(()=>{});}finally{await response?.dispose().catch(()=>{});}
        });
        await context.routeWebSocket('**/*',socket=>{void socket.close().catch(()=>{});});
        page=await context.newPage();
        page.on('framenavigated',frame=>{if(frame===page!.mainFrame()){this.#documentId=randomUUID();this.#invalidateInputs();void this.#clearRefs();}});
        page.on('download',download=>{void download.cancel().catch(()=>{});});
        page.on('filechooser',()=>{/* Interception leaves uploads without files. */});
        page.on('dialog',dialog=>{void dialog.dismiss().catch(()=>{});});
        return page;
    }
    async open(context:BrowserExecution,url:string):Promise<BrowserObservation>{return this.#run(context,async()=>{
        if(this.#page)throw new Error('Browser already opened');const target=publicHttpsUrl(url);this.options.network.assertAllowed(target.href);
        const ready=await this.#owner.start(browser=>this.#start(browser));this.#page=ready.value;this.#assert();
        const revision=this.options.network.revision;
        const check=()=>{this.#assert();if(this.options.network.revision!==revision||!this.options.network.allows(target.href))throw new Error('Origin changed');};
        const result=await this.options.perform(context,{kind:'browser.gesture',version:1,operation:'open',threadId:this.options.threadId,sessionId:context.sessionId,generation:context.generation,grantRevision:revision,origin:target.origin,url:target.href},
            {operation:'open',origin:target.origin,name:target.href},{validate:async()=>check(),assertCurrent:check,dispatch:async mark=>{check();mark();await this.#page!.goto(target.href,{waitUntil:'domcontentloaded',timeout:Math.max(1,context.execution.deadline-Date.now())});return this.#capture();}});
        if(result.status!=='accepted')throw new Error('Browser opening stopped');return result.observation;
    });}
    async observe(context:BrowserExecution):Promise<BrowserObservation>{return this.#run(context,()=>this.#capture());}
    #purpose(origin:string,fingerprint:string):string{return 'live-field:v1:'+hash({sessionId:this.options.sessionId,documentId:this.#documentId,origin,epoch:this.#inputEpoch,fingerprint});}
    async #capture():Promise<BrowserObservation>{
        this.#assert();if(!this.#page)throw new Error('Browser absent');const documentId=this.#documentId;const page=this.#page;
        const url=publicHttpsUrl(page.url());if(!this.options.network.allows(url.href))throw new Error('Origin denied');
        const check=()=>{this.#assert();if(this.#documentId!==documentId)throw new Error('Document changed');};
        const text=await page.evaluate(liveVisibleText);check();
        const handles=await page.$$('a,button,input,textarea,select,[role="button"]');check();
        const entries=new Map<string,Entry>(),controls:BrowserControl[]=[];const fields=new Map<string,{name:string;count:number}>();
        const candidate:BrowserObservation={...this.#scope!,id:randomUUID(),documentId,origin:url.origin,location:url.pathname,observedAt:new Date().toISOString(),text,controls};
        while(Buffer.byteLength(JSON.stringify(candidate))>16000)candidate.text=candidate.text.slice(0,Math.floor(candidate.text.length*.8));
        try{if(handles.length>1000)throw new Error('Page control budget exceeded');for(const handle of handles){
            const data=await handle.evaluate(describeLiveControl);check();
            if(!data.visible||!data.eligible||!data.role)continue;
            const fingerprint=hash(data.descriptor);const purpose=this.#purpose(url.origin,fingerprint);
            if(data.role==='textbox'){const old=fields.get(fingerprint);fields.set(fingerprint,{name:data.name,count:(old?.count??0)+1});}
            if(controls.length>=100)continue;
            const ref=randomUUID();const options=new Map<string,number>();const exposed=data.options.map(o=>{const ref=randomUUID();options.set(ref,o.index);return{ref,name:o.name};});
            const action={link:'navigate',button:'click',textbox:'fill',combobox:'select'} as const;
            controls.push({ref,role:data.role,name:data.name,actions:[action[data.role]],options:exposed});
            if(Buffer.byteLength(JSON.stringify(candidate))>32768){controls.pop();continue;}
            entries.set(ref,{handle,fingerprint,options,purpose});
        }
        check();const result=validateObservation(candidate,this.#scope!);await this.#clearRefs();check();
        this.#entries=entries;this.#observation=result;
        for(const [ref,item] of this.#catalog)if(fields.get(item.fingerprint)?.count!==1)this.#catalog.delete(ref);
        for(const [fingerprint,data] of fields)if(data.count===1&&[...entries.values()].some(e=>e.fingerprint===fingerprint)&&![...this.#catalog.values()].some(c=>c.fingerprint===fingerprint)){
            const ref=randomUUID();this.#catalog.set(ref,{ref,name:data.name,origin:url.origin,fingerprint,purpose:this.#purpose(url.origin,fingerprint)});
        }
        return result;
        }finally{const retained=new Set([...this.#entries.values()].map(e=>e.handle));await Promise.all(handles.filter(h=>!retained.has(h)).map(h=>h.dispose().catch(()=>{})));}
    }
    inputs():Array<{ref:string;name:string;origin:string}>{this.#assertSession();if(this.#human)return [];return [...this.#catalog.values()].map(({ref,name,origin})=>({ref,name,origin}));}
    inputPurpose(ref:string):string{this.#assertSession();if(this.#human)throw new Error('Manual browser');const item=this.#catalog.get(ref);if(!item)throw new Error('Stale field');return item.purpose;}
    async interact(context:BrowserExecution,raw:BrowserCommand):Promise<BrowserObservation>{return this.#run(context,async()=>{
        this.#assert();if(!this.#observation)throw new Error('Observe first');const command=parseBrowserCommand(raw);
        if(command.kind==='request_login')throw new Error('Use manual handoff');
        const control=resolveControl(this.#observation,context,command),entry=this.#entries.get(command.ref)!;
        const observationId=this.#observation.id,documentId=this.#documentId,origin=this.#observation.origin,revision=this.options.network.revision;
        const check=()=>{this.#assert();if(this.#documentId!==documentId||this.#observation?.id!==observationId||this.options.network.revision!==revision||!this.options.network.allows(origin))throw new Error('Stale browser action');};
        let value:string|undefined;
        const validate=async()=>{check();const now=await entry.handle.evaluate(describeLiveControl);check();if(!now.visible||!now.eligible||hash(now.descriptor)!==entry.fingerprint)throw new Error('Stale control');
            if(command.kind==='navigate'){const target=publicHttpsUrl(now.descriptor.href);if(!this.options.network.allows(target.href))throw new Error('Origin not granted');}
            if(command.kind==='fill'){
                if(![...this.#catalog.values()].some(c=>c.fingerprint===entry.fingerprint&&c.purpose===entry.purpose))throw new Error('Ambiguous input');
                const fields=await this.#page!.$$('input,textarea');let matches=0;
                try{if(fields.length>1000)throw new Error('Page control budget exceeded');for(const field of fields){const data=await field.evaluate(describeLiveControl);check();if(data.visible&&data.eligible&&hash(data.descriptor)===entry.fingerprint)matches++;}}
                finally{await Promise.all(fields.map(field=>field.dispose().catch(()=>{})));}
                check();if(matches!==1)throw new Error('Ambiguous input');
                const resolved=context.resolveInput(command.taskInputId,origin,entry.purpose);if(value!==undefined&&value!==resolved)throw new Error('Input changed');value=resolved;
            }
        };
        await validate();
        const result=await this.options.perform(context,{kind:'browser.gesture',version:1,operation:'interact',threadId:this.options.threadId,sessionId:context.sessionId,generation:context.generation,grantRevision:revision,origin,documentId,controlFingerprint:entry.fingerprint,gesture:command},
            {operation:command.kind,origin,name:control.name,...(value===undefined?{}:{value})},{validate,assertCurrent:check,dispatch:async mark=>{
                await validate();check();mark();const timeout=Math.max(1,context.execution.deadline-Date.now());
                if(command.kind==='fill')await entry.handle.fill(value!,{timeout});
                else if(command.kind==='select')await entry.handle.selectOption({index:entry.options.get(command.optionRef)!},{timeout});
                else await entry.handle.click({timeout});
                return this.#capture();
            }});
        if(result.status==='handoff'){this.#human=true;this.#invalidateInputs();await this.#clearRefs();}
        if(result.status!=='accepted')throw new Error(`Browser gesture ${result.status}`);return result.observation;
    });}
    async retire():Promise<void>{if(this.#busy)throw new Error('Browser busy');await this.#clearRefs();this.#scope=undefined;}
    async handoff():Promise<void>{if(this.#busy)throw new Error('Browser busy');this.#human=true;this.#invalidateInputs();await this.retire();}
    async resume():Promise<void>{this.#assertSession();if(this.#busy||!this.#human||!this.#page||!this.options.network.allows(this.#page.url()))throw new Error('Cannot resume browser');this.#human=false;await this.retire();}
    close():Promise<{confirmed:boolean}>{return this.#closePromise??=(async()=>{
        this.#closed=true;this.#invalidateInputs();this.#abort.abort();await this.#clearRefs();
        const browser=await this.#owner.close(),network=await this.options.network.close();const confirmed=browser.confirmed&&network.confirmed;
        this.#owner.finishReceipt(confirmed,null,confirmed);return{confirmed};
    })();}
}
