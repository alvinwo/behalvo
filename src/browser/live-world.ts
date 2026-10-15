import type { CDPSession, Page } from 'playwright';
import { describeLiveControl, liveVisibleText } from './live-dom.js';
import { BrowserDiagnosticError, parseDispatchReceipt, type WorldDispatchReceipt } from './live-failure.js';

type Description=ReturnType<typeof describeLiveControl>;
export interface WorldControl extends Description { nodeId:number }
export interface WorldAction {nodeId:number;descriptor:Description['descriptor'];kind:'navigate'|'click'|'fill'|'select';value?:string;index?:number;deadline:number}

/** Installed only in Chromium's private isolated world. Never accepts page/model code. */
function installWorld(describe:typeof describeLiveControl,text:typeof liveVisibleText) {
    const nodes=new Map<number,Element>();let next=0;
    const same=(node:Element,expected:WorldAction['descriptor'])=>{
        const actual=describe(node);return actual.visible&&actual.eligible&&JSON.stringify(actual.descriptor)===JSON.stringify(expected);
    };
    return {
        clear(){nodes.clear();},
        capture(){nodes.clear();const candidates=Array.from(document.querySelectorAll('a,button,input,textarea,select,[role="button"]'));
            if(candidates.length>1000)throw new Error('Control budget');
            return {text:text(),controls:candidates.map(node=>{const nodeId=++next;nodes.set(nodeId,node);return{...describe(node),nodeId};})};},
        describe(nodeId:number){const node=nodes.get(nodeId);if(!node)throw new Error('Stale node');return describe(node);},
        prepare(nodeId:number){const node=nodes.get(nodeId);if(!node)throw new Error('Stale node');Element.prototype.scrollIntoView.call(node,{block:'center',inline:'center',behavior:'instant'});},
        dispatch(action:WorldAction):WorldDispatchReceipt{
            const node=nodes.get(action.nodeId);
            if(Date.now()>=action.deadline)return{status:'not_dispatched',code:'deadline_expired'};
            if(!node||!node.isConnected)return{status:'not_dispatched',code:'control_missing'};
            if(!same(node,action.descriptor))return{status:'not_dispatched',code:'control_changed'};
            if(action.kind==='fill'){
                const fields=Array.from(document.querySelectorAll('input,textarea'));
                if(fields.length>1000||fields.filter(field=>same(field,action.descriptor)).length!==1)return{status:'not_dispatched',code:'field_ambiguous'};
            }
            // Final validation and the first effect run in the same JS task. No await,
            // page-world callbacks, focus, scrolling, or locator resolution in between.
            const rect=node.getBoundingClientRect();const x=rect.left+rect.width/2,y=rect.top+rect.height/2;
            const hit=document.elementFromPoint(x,y);
            if(x<0||y<0||x>=innerWidth||y>=innerHeight||!hit||!(node===hit||node.contains(hit)))return{status:'not_dispatched',code:'control_covered'};
            if(action.kind==='fill'){
                const prototype=node.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;
                Object.getOwnPropertyDescriptor(prototype,'value')!.set!.call(node,action.value!);
                node.dispatchEvent(new Event('input',{bubbles:true}));node.dispatchEvent(new Event('change',{bubbles:true}));
            }else if(action.kind==='select'){
                const option=(node as HTMLSelectElement).options[action.index!];
                if(!option||option.disabled||option.parentElement?.hasAttribute('disabled'))return{status:'not_dispatched',code:'option_changed'};
                Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'selectedIndex')!.set!.call(node,action.index!);
                node.dispatchEvent(new Event('input',{bubbles:true}));node.dispatchEvent(new Event('change',{bubbles:true}));
            }else HTMLElement.prototype.click.call(node);
            return {status:'dispatched'};
        }
    };
}

/** Private CDP is confined to this application-owned page; no attach or script API. */
export class LiveWorld {
    #objectId:string|undefined;#frameId:string|undefined;
    constructor(readonly session:CDPSession,private readonly page:Page){}
    reset():void{const objectId=this.#objectId;this.#objectId=undefined;if(objectId)void this.session.send('Runtime.releaseObject',{objectId}).catch(()=>{});}
    async #ready():Promise<string>{
        if(this.#objectId)return this.#objectId;
        const {frameTree}=await this.session.send('Page.getFrameTree');this.#frameId=frameTree.frame.id;
        const {executionContextId}=await this.session.send('Page.createIsolatedWorld',{frameId:this.#frameId,worldName:'behalvo-private-semantic-world'});
        const result=await this.session.send('Runtime.evaluate',{contextId:executionContextId,expression:`(${installWorld.toString()})(${describeLiveControl.toString()},${liveVisibleText.toString()})`});
        if(result.exceptionDetails||!result.result.objectId)throw new Error('Browser helper unavailable');
        return this.#objectId=result.result.objectId;
    }
    async #call<T>(method:'capture'|'describe'|'prepare'|'dispatch'|'clear',argument?:unknown):Promise<T>{
        const objectId=await this.#ready();const result=await this.session.send('Runtime.callFunctionOn',{objectId,functionDeclaration:'function(method, argument) { return this[method](argument); }',arguments:[{value:method},{value:argument}],returnByValue:true});
        if(result.exceptionDetails)throw new Error('Browser helper rejected');return result.result.value as T;
    }
    capture():Promise<{text:string;controls:WorldControl[]}>{return this.#call('capture');}
    describe(nodeId:number):Promise<Description>{return this.#call('describe',nodeId);}
    prepare(nodeId:number):Promise<void>{return this.#call('prepare',nodeId);}
    async clear():Promise<void>{if(this.#objectId)await this.#call('clear').catch(()=>{});}
    async dispatch(action:WorldAction):Promise<WorldDispatchReceipt>{
        let requested=false;let committedResolve!:()=>void;
        let timeout:ReturnType<typeof setTimeout>|undefined;
        const committed=new Promise<void>((resolve,reject)=>{committedResolve=resolve;timeout=setTimeout(()=>reject(new Error('Navigation unsettled')),Math.max(1,action.deadline-Date.now()));});
        void committed.catch(()=>{});
        const onRequest=(event:{frameId:string})=>{if(event.frameId===this.#frameId)requested=true;};
        const onCommit=(frame:import('playwright').Frame)=>{if(frame===this.page.mainFrame())committedResolve();};
        this.session.on('Page.frameRequestedNavigation',onRequest);this.page.on('framenavigated',onCommit);
        try{
            const receipt=parseDispatchReceipt(await this.#call('dispatch',action));
            if(receipt.status==='dispatched'&&requested){
                try{await committed;await this.page.waitForLoadState('domcontentloaded',{timeout:Math.max(1,action.deadline-Date.now())});}
                catch{throw new BrowserDiagnosticError({phase:'navigation',code:'navigation_unsettled'});}
            }
            return receipt;
        }
        finally{clearTimeout(timeout);this.session.off('Page.frameRequestedNavigation',onRequest);this.page.off('framenavigated',onCommit);}
    }
}
