import { randomUUID } from 'node:crypto';
import type { Browser, Page, ElementHandle } from 'playwright';
import { PlaywrightProcessOwner, type PlaywrightOwnerDependencies } from './playwright-process-owner.js';
import { assertExecutionActive, withinExecution } from '../operations/execution-context.js';
import { fieldPurpose, requestAllowed, type SemanticFixturePolicy } from './semantic-fixture-policy.js';
import { parseBrowserCommand, resolveControl, sameScope, validateObservation } from './semantic-validation.js';
import type { BrowserCommand, BrowserControl, BrowserExecution, BrowserObservation, BrowserScope, SemanticBrowserPort } from './semantic-types.js';
interface Entry { handle:ElementHandle; fingerprint:string; options:Map<string,string> }
/** Disposable synthetic browser. All request policy and DOM handles remain application-private. */
export class SemanticPlaywright implements SemanticBrowserPort {
    readonly #owner:PlaywrightProcessOwner;
    readonly #policy:SemanticFixturePolicy;
    #page:Page|undefined; #scope:BrowserScope|undefined; #observation:BrowserObservation|undefined;
    #entries=new Map<string,Entry>(); #current:BrowserExecution|undefined;
    #permit:string|undefined; #dispatchCheck:(()=>void)|undefined; #documentGuard:(()=>void)|undefined; #busy=false; #closed=false; #documentId=randomUUID();
    readonly #values=new Map<string,{id:string;value:string;purpose:string}>();
    constructor(policy:SemanticFixturePolicy,signal:AbortSignal,dependencies:PlaywrightOwnerDependencies={}) {
        this.#policy=structuredClone(policy);this.#owner=new PlaywrightProcessOwner({signal},dependencies);
    }
    get receiptPath():string{return this.#owner.receiptPath;}
    #assert():void { if(this.#closed||!this.#current)throw new Error('Browser unavailable');assertExecutionActive(this.#current.execution);this.#current.assertCurrent();this.#documentGuard?.();if(this.#scope)sameScope(this.#scope,this.#current); }
    async #run(context:BrowserExecution,operation:()=>Promise<BrowserObservation>):Promise<BrowserObservation>{
        if(this.#busy||this.#closed)throw new Error('Browser unavailable');this.#busy=true;this.#current=context;
        try{this.#assert();return await withinExecution(operation,context.execution);}catch(error){if(context.execution.signal?.aborted||Date.now()>=context.execution.deadline){this.#closed=true;void this.#owner.close();}throw error;}finally{this.#current=undefined;this.#permit=undefined;this.#dispatchCheck=undefined;this.#documentGuard=undefined;this.#busy=false;}
    }
    async #start(browser:Browser):Promise<Page>{
        const context=await browser.newContext({javaScriptEnabled:false,serviceWorkers:'block',acceptDownloads:false});this.#assert();
        let page:Page|undefined;
        context.on('page',candidate=>{if(page&&candidate!==page){this.#closed=true;void candidate.close().catch(()=>{});}});
        await context.route('**/*',async route=>{
            const request=route.request();try{
                this.#assert();if(!page||request.frame()!==page.mainFrame()||request.resourceType()!=='document'||this.#permit!==request.url()||!requestAllowed(this.#policy,request.method(),request.url()))throw new Error('Request denied');
                this.#permit=undefined;this.#assert();this.#dispatchCheck?.();
                const response=await route.fetch({maxRedirects:0,maxRetries:0,timeout:Math.max(1,Math.min(10000,this.#current!.execution.deadline-Date.now()))});
                try{this.#assert();const headers=response.headers();if(response.status()!==200||response.url()!==request.url()||headers['content-disposition']||!headers['content-type']?.startsWith('text/html'))throw new Error('Response denied');
                    const body=await response.body();this.#assert();if(body.length>262144)throw new Error('Response budget');
                    this.#assert();this.#documentGuard=undefined;
                    await route.fulfill({status:200,headers:{'content-type':'text/html; charset=utf-8','content-security-policy':"default-src 'none'; form-action 'self'; frame-src 'none'"},body});
                }finally{await response.dispose();}
            }catch{await route.abort('blockedbyclient').catch(()=>{});}
        });
        await context.routeWebSocket('**/*',socket=>{void socket.close().catch(()=>{});});this.#assert();
        page=await context.newPage();this.#assert();
        page.on('framenavigated',frame=>{if(frame===page!.mainFrame()){this.#documentId=randomUUID();this.#entries.clear();this.#values.clear();}});
        page.on('frameattached',()=>{this.#closed=true;});page.on('download',download=>{void download.cancel().catch(()=>{});});
        this.#permit=this.#policy.origin+'/';await page.goto(this.#permit,{waitUntil:'domcontentloaded',timeout:Math.max(1,this.#current!.execution.deadline-Date.now())});this.#assert();return page;
    }
    async observe(context:BrowserExecution):Promise<BrowserObservation>{return this.#run(context,async()=>{
        if(!this.#page){this.#scope={workspaceId:context.workspaceId,workId:context.workId,workRevision:context.workRevision,sessionId:context.sessionId,generation:context.generation};const ready=await this.#owner.start(browser=>this.#start(browser));this.#assert();this.#page=ready.value;}
        return this.#observe();
    });}
    async #observe():Promise<BrowserObservation>{
        this.#assert();const documentId=this.#documentId;this.#documentGuard=()=>{if(this.#documentId!==documentId)throw new Error('Document changed during observation');};const page=this.#page!;const url=new URL(page.url());if(url.origin!==this.#policy.origin)throw new Error('Browser left fixture');
        const visibleText=await page.locator('body').innerText();this.#assert();
        const handles=await page.$$('a,button,input,select');this.#assert();const entries=new Map<string,Entry>();const controls:BrowserControl[]=[];
        for(const handle of handles){
            const data=await handle.evaluate(node=>{
                const e=node as HTMLElement;const input=node as HTMLInputElement;
                const style=getComputedStyle(e);const rect=e.getBoundingClientRect();
                const visible=e.isConnected&&rect.width>0&&rect.height>0&&style.visibility!=='hidden'&&style.display!=='none'&&!e.closest('[hidden],[inert]');
                return {visible,disabled:input.disabled===true,tag:e.tagName,type:input.type,name:input.name,
                    label:e.getAttribute('aria-label')||Array.from(input.labels??[]).map(x=>x.textContent).join(' ')||e.textContent||'',fingerprint:e.outerHTML,
                    options:e.tagName==='SELECT'?Array.from((node as HTMLSelectElement).options).filter(o=>!o.disabled).map(o=>({value:o.value,name:o.text})):[]};
            });this.#assert();
            if(!data.visible||data.disabled)continue;
            let role:BrowserControl['role'];let action:BrowserControl['actions'][number];
            if(data.tag==='A'){role='link';action='navigate';}
            else if(data.tag==='BUTTON'){role='button';action='click';}
            else if(data.tag==='INPUT'&&['text','search'].includes(data.type)){try{fieldPurpose(this.#policy,url.pathname,data.name);}catch{continue;}role='textbox';action='fill';}
            else if(data.tag==='SELECT'){try{fieldPurpose(this.#policy,url.pathname,data.name);}catch{continue;}role='combobox';action='select';}else continue;
            const ref=randomUUID();const options=new Map<string,string>();const exposed=data.options.map(o=>{const ref=randomUUID();options.set(ref,o.value);return {ref,name:o.name};});
            if(!data.label.trim())continue;controls.push({ref,role,name:data.label.trim(),actions:[action],options:exposed});entries.set(ref,{handle,fingerprint:data.fingerprint,options});
        }
        const result=validateObservation({...this.#scope,id:randomUUID(),documentId:this.#documentId,origin:url.origin,location:url.pathname,observedAt:new Date().toISOString(),text:visibleText,controls},this.#scope!);
        for(const entry of this.#entries.values())void entry.handle.dispose().catch(()=>{});this.#entries=entries;this.#observation=result;this.#documentGuard=undefined;return result;
    }
    async interact(context:BrowserExecution,raw:BrowserCommand):Promise<BrowserObservation>{return this.#run(context,async()=>{
        if(!this.#page||!this.#observation)throw new Error('Observe first');const command=parseBrowserCommand(raw);resolveControl(this.#observation,context,command);
        const documentId=this.#observation.documentId;const observationId=this.#observation.id;
        this.#documentGuard=()=>{if(this.#documentId!==documentId||this.#observation?.id!==observationId)throw new Error('Stale browser document');};
        const entry=this.#entries.get(command.ref)!;this.#assert();
        const current=await entry.handle.evaluate(node=>({connected:node.isConnected,fingerprint:(node as HTMLElement).outerHTML,disabled:(node as HTMLInputElement).disabled===true}));this.#assert();
        if(!current.connected||current.disabled||current.fingerprint!==entry.fingerprint||!await entry.handle.isVisible())throw new Error('Stale control');this.#assert();
        if(command.kind==='fill'||command.kind==='select'){
            const name=await entry.handle.getAttribute('name');this.#assert();const purpose=fieldPurpose(this.#policy,new URL(this.#page.url()).pathname,name??'');
            if(command.kind==='fill'){const value=context.resolveInput(command.taskInputId,this.#policy.origin,purpose);this.#assert();await entry.handle.fill(value);this.#assert();this.#values.set(name!,{id:command.taskInputId,value,purpose});}
            else {const value=entry.options.get(command.optionRef);if(value===undefined)throw new Error('Invalid option');this.#assert();await entry.handle.selectOption(value);}
        }else{
            const target=await entry.handle.evaluate(node=>{
                if(node instanceof HTMLAnchorElement){if(node.target||node.download)return null;return {url:node.href,fields:[]};}
                if(!(node instanceof HTMLButtonElement)||node.type!=='submit'||!node.form||node.form.method.toLowerCase()!=='get'||node.form.target||node.formAction!==node.form.action&&node.hasAttribute('formaction'))return null;
                const url=new URL(node.form.action);const fields:Array<{name:string;value:string;input:boolean}>=[];
                for(const e of Array.from(node.form.elements)){
                    if(e instanceof HTMLButtonElement)continue;
                    if(!(e instanceof HTMLInputElement||e instanceof HTMLSelectElement)||e.disabled||!e.name)return null;
                    if(e instanceof HTMLInputElement&&!['text','search'].includes(e.type))return null;
                    fields.push({name:e.name,value:e.value,input:e instanceof HTMLInputElement});url.searchParams.append(e.name,e.value);
                }return {url:url.href,fields};
            });this.#assert();
            if(!target||!requestAllowed(this.#policy,'GET',target.url))throw new Error('Interaction not permitted');
            const sourcePath=new URL(this.#page.url()).pathname;
            const checkInputs=()=>{for(const field of target.fields){const purpose=fieldPurpose(this.#policy,sourcePath,field.name);if(field.input){const value=this.#values.get(field.name);if(!value||value.purpose!==purpose||value.value!==field.value||context.resolveInput(value.id,this.#policy.origin,purpose)!==field.value)throw new Error('Input not authorized');}}};
            checkInputs();this.#dispatchCheck=checkInputs;
            this.#assert();this.#permit=target.url;
            // Navigate only to the resolved, policy-classified target. Never evaluate model code or selectors.
            await this.#page.goto(target.url,{waitUntil:'domcontentloaded',timeout:Math.max(1,context.execution.deadline-Date.now())});this.#assert();if(this.#page.url()!==target.url)throw new Error('Navigation changed');
        }
        return this.#observe();
    });}
    async close():Promise<{confirmed:boolean}>{this.#closed=true;const result=await this.#owner.close();this.#owner.finishReceipt(result.confirmed,null,result.confirmed);return result;}
}
