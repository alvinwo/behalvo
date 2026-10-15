import { randomUUID } from 'node:crypto';
import { liveMessage } from './live-messages.js';
import { assertOwner } from '../kernel/policy.js';
import { assertNoUnknownBrowserAction } from '../kernel/browser-action.js';
import { assertTeachingClear } from '../kernel/teachings.js';
import type { Action } from '../kernel/types.js';
import { assertExecutionActive, type OperationExecutionContext } from '../operations/execution-context.js';
import { BrowserActionBroker, type BrowserReview } from '../runtime/browser-actions.js';
import type { BrowserExplorationOptions } from '../runtime/browser-exploration.js';
import { assertBrowserWork, authorizeTaskInput, recordBrowserObservation, resolveStoredTaskInput } from '../runtime/browser-learning.js';
import type { TeachingBinding } from '../runtime/teachings.js';
import type { SqliteStore } from '../storage/sqlite-store.js';
import { LivePlaywright, type LivePlaywrightOptions, type LiveReviewDetail } from './live-playwright.js';
import { PublicNetworkGate, publicHttpsUrl } from './public-network.js';
import type { BrowserExecution, SemanticBrowserPort } from './semantic-types.js';

export interface ManagedBrowserScope {workspaceId:string;ownerId:string;threadId:string;workId:string}
export type ManagedBrowserBinding=ManagedBrowserScope&TeachingBinding;
export interface ManagedBrowserDependencies {
    clock?:()=>number;
    network?:(assertActive:()=>void)=>PublicNetworkGate;
    browser?:(options:LivePlaywrightOptions)=>LivePlaywright;
}
type SessionState='starting'|'idle'|'leased'|'human'|'closing'|'closed'|'faulted';
interface Session {
    key:string;id:string;scope:ManagedBrowserScope;revision:number;generation:number;expiresAt:number;state:SessionState;
    network:PublicNetworkGate;browser:LivePlaywright|undefined;binding:ManagedBrowserBinding|undefined;lease:BrowserExecution|undefined;
    closing?:Promise<{confirmed:boolean}>;
}
export type ManagedReview=(action:Action,detail:LiveReviewDetail,signal?:AbortSignal)=>Promise<BrowserReview>;

/** Process-local operational custody. Durable task/action authority remains in the journal. */
export class ManagedBrowserController {
    readonly #sessions=new Map<string,Session>();readonly #broker:BrowserActionBroker;readonly #clock:()=>number;
    readonly #timer:ReturnType<typeof setInterval>;#stopped=false;
    constructor(private readonly store:SqliteStore,private readonly review:ManagedReview,private readonly dependencies:ManagedBrowserDependencies={}) {
        this.#broker=new BrowserActionBroker(store);this.#clock=dependencies.clock??Date.now;
        this.#timer=setInterval(()=>{for(const session of this.#sessions.values()){try{this.#checkSession(session);}catch{/* Closure is initiated by the guard. */}}},1000);this.#timer.unref();
    }
    #key(scope:ManagedBrowserScope):string{return JSON.stringify([scope.workspaceId,scope.ownerId,scope.threadId,scope.workId]);}
    #checkScope(scope:ManagedBrowserScope):number{
        const state=this.store.state(scope.workspaceId);assertOwner(state,scope.ownerId);const work=state.works[scope.workId];
        if(!work||!work.threadIds.includes(scope.threadId)||['done','cancelled'].includes(work.phase))throw new Error('Browser task is unavailable');
        return work.revision;
    }
    #checkSession(session:Session):void{
        if(this.#stopped||['closing','closed','faulted'].includes(session.state))throw new Error('Browser session is closed');
        try{
            if(this.#clock()>=session.expiresAt)throw new Error('Browser session expired');
            const revision=this.#checkScope(session.scope);
            if(revision!==session.revision){session.revision=revision;session.browser?.invalidateInputs();}
        }catch(error){void this.#close(session);throw error;}
    }
    #get(scope:ManagedBrowserScope):Session{
        this.#checkScope(scope);const session=this.#sessions.get(this.#key(scope));if(!session)throw new Error('Open a browser for this task first');this.#checkSession(session);return session;
    }
    #touch(session:Session):void{session.expiresAt=this.#clock()+600000;}
    #binding(binding:ManagedBrowserBinding):void{
        const state=assertBrowserWork(this.store,binding);assertTeachingClear(state,binding.workId);
        const record=this.store.record(binding.workspaceId,binding.ownerRecordId);
        if(record.event.type!=='message.received'||record.event.data.threadId!==binding.threadId)throw new Error('Browser source thread mismatch');
    }
    available(scope:ManagedBrowserScope):boolean{try{const session=this.#get(scope);return session.state==='idle';}catch{return false;}}
    beforeTurn(scope:{workspaceId:string;ownerId:string;threadId:string}):void{
        for(const session of this.#sessions.values())if(session.scope.workspaceId===scope.workspaceId&&session.scope.ownerId===scope.ownerId&&session.scope.threadId===scope.threadId){
            try{this.#checkSession(session);}catch{continue;}
            if(session.state==='human'||session.browser?.human)throw new Error(liveMessage('manualBlocked'));
            if(session.state==='leased'||session.state==='starting')throw new Error('Browser is busy');
        }
    }
    sessionState(scope:ManagedBrowserScope):'absent'|'connected'{
        this.#checkScope(scope);const session=this.#sessions.get(this.#key(scope));
        if(!session)return 'absent';this.#checkSession(session);return session.browser?'connected':'absent';
    }
    exploration():BrowserExplorationOptions{return {mode:'live',available:scope=>this.available(scope),sessionState:scope=>this.sessionState(scope),beforeTurn:scope=>this.beforeTurn(scope),open:async(context,binding)=>{
        if(!binding)throw new Error('Browser binding missing');const record=this.store.record(binding.workspaceId,binding.ownerRecordId);
        if(record.event.type!=='message.received')throw new Error('Browser source missing');return this.#lazyPort(context,{...binding,threadId:record.event.data.threadId});
    }};}
    #reserve(binding:ManagedBrowserBinding):Session{
        if(this.#stopped)throw new Error('Browser controller stopped');this.#binding(binding);
        assertNoUnknownBrowserAction(this.store.state(binding.workspaceId),binding.workId);const key=this.#key(binding);
        if(this.#sessions.has(key))throw new Error('Close the existing browser before opening another');
        if(this.#sessions.size>=2)throw new Error('Browser session capacity reached');
        let session:Session;
        const network=(this.dependencies.network??(guard=>new PublicNetworkGate(guard)))(()=>this.#checkSession(session));
        session={key,id:randomUUID(),scope:{workspaceId:binding.workspaceId,ownerId:binding.ownerId,threadId:binding.threadId,workId:binding.workId},revision:binding.expectedWorkRevision,generation:0,expiresAt:this.#clock()+600000,state:'starting',network,browser:undefined,binding:undefined,lease:undefined};
        this.#sessions.set(key,session);return session;
    }
    async #prepare(session:Session,ownerOpen?:{sourceId:string;url:string}):Promise<void>{
        await session.network.start();this.#checkSession(session);
        session.browser=(this.dependencies.browser??(options=>new LivePlaywright(options)))({sessionId:session.id,threadId:session.scope.threadId,network:session.network,assertSession:()=>this.#checkSession(session),
            perform:async(context,command,detail,gesture)=>{
                if(session.lease!==context||!session.binding)throw new Error('Browser lease mismatch');
                const authority=command.operation==='open'?'owner_open':command.operation==='visit'||(command.operation==='interact'&&command.gesture.kind==='navigate')?'navigation_policy_v1':'owner_review';
                const result=await this.#broker.perform(session.binding,{...command,version:2,authority},context.execution,{...gesture,
                    review:(action,signal)=>{
                        if(authority==='navigation_policy_v1')return Promise.resolve('approve');
                        if(command.operation!=='open')return this.review(action,detail,signal);
                        if(!ownerOpen||ownerOpen.sourceId!==session.binding?.ownerRecordId||ownerOpen.url!==command.url)throw new Error('Owner opening authority unavailable');
                        ownerOpen=undefined;return Promise.resolve('approve');
                    }});
                if(result.status==='unknown'||result.status==='failed')void this.#close(session);
                return result;
            }});
        session.state='idle';
    }
    /** Own partial allocation before awaiting it, so cancellation can always close it. */
    #lazyPort(context:BrowserExecution,binding:ManagedBrowserBinding):SemanticBrowserPort{
        let retired=false,session:Session|undefined,borrowed:SemanticBrowserPort|undefined,acquiring:Promise<SemanticBrowserPort>|undefined;
        const check=()=>{
            if(retired||this.#stopped)throw new Error('Browser lease retired');
            assertExecutionActive(context.execution);context.assertCurrent();this.#binding(binding);
            if(context.workspaceId!==binding.workspaceId||context.workId!==binding.workId||context.workRevision!==binding.expectedWorkRevision)throw new Error('Browser lease scope mismatch');
        };check();
        const guarded={...context,assertCurrent:check};
        const stopped=()=>{if(session)void this.#close(session);};context.execution.signal?.addEventListener('abort',stopped,{once:true});
        const detach=()=>context.execution.signal?.removeEventListener('abort',stopped);
        const acquire=(create:boolean):Promise<SemanticBrowserPort>=>{
            check();if(acquiring)return acquiring;
            const existing=this.#sessions.get(this.#key(binding));
            if(existing){this.#checkSession(existing);if(existing.state!=='idle'||!existing.browser)throw new Error('Browser is unavailable or in manual mode');session=existing;}
            else{if(!create)throw new Error('Browser has no page');session=this.#reserve(binding);}
            const owned=session;
            acquiring=(async()=>{
                if(!existing)await this.#prepare(owned);check();
                const value=await this.borrow(guarded,binding);
                if(retired){await value.close();throw new Error('Browser lease retired');}
                borrowed=value;check();return value;
            })();return acquiring;
        };
        const supplied=(value:BrowserExecution)=>{if(value!==context)throw new Error('Browser lease mismatch');check();};
        return {
            visit:async(value,url)=>{supplied(value);const target=publicHttpsUrl(url);const port=await acquire(true);check();return port.visit!(guarded,target.href);},
            observe:async value=>{supplied(value);const port=await acquire(false);check();return port.observe(guarded);},
            interact:async(value,command)=>{supplied(value);const port=await acquire(false);check();return port.interact(guarded,command);},
            handoff:async()=>{const port=await acquire(false);check();await port.handoff!();},
            retire:async healthy=>{
                if(retired)throw new Error('Browser lease already retired');detach();
                if(borrowed){const result=borrowed.retire!(healthy);retired=true;return result;}
                retired=true;const result=session?await this.#close(session):{confirmed:true};
                return{leaseRetired:result.confirmed,sessionDisposition:'closed',cleanupConfirmed:result.confirmed};
            },
            close:async()=>{retired=true;detach();return borrowed?borrowed.close():session?this.#close(session):{confirmed:true};}
        };
    }
    async open(binding:ManagedBrowserBinding,url:string,execution:OperationExecutionContext):Promise<void>{
        if(this.#stopped)throw new Error('Browser controller stopped');this.#binding(binding);assertExecutionActive(execution);
        if(!this.store.inbox(binding.workspaceId).some(record=>record.id===binding.ownerRecordId))throw new Error('Browser opening instruction already handled');
        const target=publicHttpsUrl(url),session=this.#reserve(binding);
        try{
            await this.#prepare(session,{sourceId:binding.ownerRecordId,url:target.href});
            const context:BrowserExecution={workspaceId:binding.workspaceId,workId:binding.workId,workRevision:binding.expectedWorkRevision,sessionId:session.id,generation:1,execution,assertCurrent:()=>this.#binding(binding),resolveInput:(id,origin,purpose)=>resolveStoredTaskInput(this.store,binding,id,origin,purpose)};
            const port=await this.borrow(context,binding);
            const observation=await session.browser!.open(session.lease!,target.href);context.assertCurrent();
            recordBrowserObservation(this.store,binding,observation,()=>this.#binding(binding));
            const retired=await port.retire!(true);if(!retired.leaseRetired||retired.sessionDisposition!=='retained')throw new Error('Browser opening did not retain a session');
            this.store.completeInbox(binding.workspaceId,binding.ownerRecordId,this.store.state(binding.workspaceId).version,[]);
        }catch(error){await this.#close(session);throw error;}
    }
    async borrow(context:BrowserExecution,binding:ManagedBrowserBinding):Promise<SemanticBrowserPort>{
        this.#binding(binding);const session=this.#get(binding);if(session.state!=='idle'||!session.browser)throw new Error('Browser is unavailable or in manual mode');
        if(context.workspaceId!==binding.workspaceId||context.workId!==binding.workId||context.workRevision!==binding.expectedWorkRevision)throw new Error('Browser lease scope mismatch');
        assertExecutionActive(context.execution);this.#touch(session);session.state='leased';session.generation++;
        let retired=false;const generation=session.generation;const originalGuard=context.assertCurrent;
        const check=()=>{if(retired||session.state!=='leased'||session.generation!==generation)throw new Error('Browser lease retired');this.#checkSession(session);assertExecutionActive(context.execution);originalGuard();this.#binding(binding);};
        const lease:BrowserExecution={...context,sessionId:session.id,generation,assertCurrent:check};
        session.binding=binding;session.lease=lease;
        const stopped=()=>{void this.#close(session);};context.execution.signal?.addEventListener('abort',stopped,{once:true});
        const close=async()=>{retired=true;context.execution.signal?.removeEventListener('abort',stopped);return this.#close(session);};
        return {
            visit:async(supplied,url)=>{if(supplied!==context)throw new Error('Browser lease mismatch');check();return session.browser!.visit(lease,url);},
            observe:async supplied=>{if(supplied!==context)throw new Error('Browser lease mismatch');check();return session.browser!.observe(lease);},
            interact:async(supplied,command)=>{if(supplied!==context)throw new Error('Browser lease mismatch');check();return session.browser!.interact(lease,command);},
            handoff:async()=>{check();await session.browser!.handoff();session.state='human';},
            retire:async healthy=>{
                if(retired)throw new Error('Browser lease already retired');
                let valid=true;try{if(!session.browser!.human)check();else{this.#checkSession(session);assertExecutionActive(context.execution);}}catch{valid=false;}
                retired=true;context.execution.signal?.removeEventListener('abort',stopped);session.generation++;session.lease=undefined;session.binding=undefined;
                if(!valid||!healthy&&!session.browser!.human){const result=await this.#close(session);return{leaseRetired:result.confirmed,sessionDisposition:'closed',cleanupConfirmed:result.confirmed};}
                try{await session.browser!.retire();session.state=session.browser!.human?'human':'idle';return{leaseRetired:true,sessionDisposition:session.state==='human'?'human':'retained'};}
                catch{const result=await this.#close(session);return{leaseRetired:result.confirmed,sessionDisposition:'closed',cleanupConfirmed:result.confirmed};}
            },close
        };
    }
    status(scope:ManagedBrowserScope){const session=this.#get(scope);this.#touch(session);return{sessionId:session.id,state:session.state,scope:session.scope,location:session.state==='human'?undefined:session.browser?.location,networkPolicy:'public_https' as const,expiresAt:new Date(session.expiresAt).toISOString(),inputs:session.browser?.inputs()??[],unresolvedActions:Object.values(this.store.state(scope.workspaceId).actions).filter(a=>a.workId===scope.workId&&a.command.kind==='browser.gesture'&&['unknown','running'].includes(a.status)).map(a=>({id:a.id,status:a.status}))};}
    input(binding:ManagedBrowserBinding,ref:string,value:string):string{this.#binding(binding);const session=this.#get(binding);if(session.state!=='idle'||!session.browser)throw new Error('Browser must be idle');const item=session.browser.inputs().find(item=>item.ref===ref);if(!item)throw new Error('Input reference is stale');
        const result=authorizeTaskInput(this.store,binding,{quote:value,origin:item.origin,purpose:session.browser.inputPurpose(ref)},true);this.#touch(session);return result.id;}
    async handoff(scope:ManagedBrowserScope):Promise<void>{const session=this.#get(scope);if(session.state!=='idle'||!session.browser)throw new Error('Browser must be idle');await session.browser.handoff();session.state='human';this.#touch(session);}
    async resume(scope:ManagedBrowserScope):Promise<void>{const session=this.#get(scope);if(session.state!=='human'||!session.browser)throw new Error('Browser is not in manual mode');await session.browser.resume();session.state='idle';session.generation++;this.#touch(session);}
    async close(scope:ManagedBrowserScope):Promise<{confirmed:boolean}>{const session=this.#sessions.get(this.#key(scope));if(!session)return{confirmed:true};assertOwner(this.store.state(scope.workspaceId),scope.ownerId);return this.#close(session);}
    #close(session:Session):Promise<{confirmed:boolean}>{return session.closing??=(async()=>{
        session.state='closing';session.generation++;session.lease=undefined;session.binding=undefined;
        let confirmed=false;try{confirmed=(await(session.browser?session.browser.close():session.network.close())).confirmed;}catch{/* Preserve unconfirmed custody. */}
        session.state=confirmed?'closed':'faulted';if(confirmed)this.#sessions.delete(session.key);return{confirmed};
    })();}
    async shutdown():Promise<{confirmed:boolean}>{this.#stopped=true;clearInterval(this.#timer);const results=await Promise.all([...this.#sessions.values()].map(session=>this.#close(session)));return{confirmed:results.every(r=>r.confirmed)};}
}
