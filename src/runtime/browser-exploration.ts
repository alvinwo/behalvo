import { parseProgressReport } from '../kernel/task-continuity.js';
import { unresolvedBrowserActions } from '../kernel/browser-action.js';
import { publicHttpsUrl } from '../browser/public-network.js';
import { browserStopMessage, liveMessage, unresolvedBrowserMessage, type BrowserStopCode } from '../browser/live-messages.js';
import { BrowserActionStopped, recoverableBrowserFailure } from '../browser/live-failure.js';
import { invokeRecall } from './recall-tool.js';
import { browserInputReferences, packBrowserRequest, browserRequestBytes, browserRequestLimit, type BrowserTranscriptEntry } from './browser-context.js';
import { randomUUID } from 'node:crypto';
import type { DomainEvent } from '../kernel/types.js';
import { assertTeachingClear } from '../kernel/teachings.js';
import { exact, parseBrowserCommand, resolveControl, text } from '../kernel/browser-contract.js';
import type { BrowserExecution, SemanticBrowserPort, BrowserLoginOutcome, BrowserObservation } from '../browser/semantic-types.js';
import type { LoginChallenge, LoginExecution, LoginUseResult } from '../vault/login-broker.js';
import type { LoginBytes } from '../vault/types.js';
import type { ModelGateway, ModelRequest } from '../model/types.js';
import { assertExecutionActive, assertExecutionCurrent, executionDeadlineReached, withinExecution, type OperationExecutionContext } from '../operations/execution-context.js';
import type { SqliteStore } from '../storage/sqlite-store.js';
import { assertBrowserWork, prepareBrowserLearningEvents, recordBrowserObservation, resolveStoredTaskInput } from './browser-learning.js';
import type { TeachingBinding } from './teachings.js';
import type { OperationLoopResult } from './operation-loop.js';
import { browserMessage } from './browser-messages.js';
export interface BrowserExplorationOptions {
    mode?:'synthetic'|'live';
    sessionState?(scope:{workspaceId:string;ownerId:string;threadId:string;workId:string}):'absent'|'connected';
    available?(scope:{workspaceId:string;ownerId:string;threadId:string;workId:string}):boolean;
    beforeTurn?(scope:{workspaceId:string;ownerId:string;threadId:string;workId?:string}):void;
    open(context:BrowserExecution,binding?:TeachingBinding):Promise<SemanticBrowserPort>;
    login?(binding:TeachingBinding,challenge:LoginChallenge,execution:LoginExecution,
      use:(login:LoginBytes,assertCurrent:()=>void)=>Promise<BrowserLoginOutcome>):Promise<LoginUseResult<BrowserLoginOutcome>>;
}
export interface BrowserExplorationResult extends OperationLoopResult {events:DomainEvent[];cleanupConfirmed?:boolean;leaseRetired?:boolean;sessionDisposition?:'retained'|'human'|'closed';diagnostic?:BrowserStopCode;closeSession?:()=>Promise<{confirmed:boolean}>}
class BrowserAuthorityStop extends Error {
    constructor(readonly code:BrowserStopCode){super(code);}
}
export async function runBrowserExploration(store:SqliteStore,gateway:ModelGateway,request:ModelRequest,binding:TeachingBinding,
    execution:OperationExecutionContext,options:BrowserExplorationOptions|undefined,maximum:number,inputBudget:number,historicalSourceIds:readonly string[]):Promise<BrowserExplorationResult>{
    const events:DomainEvent[]=[];const transcript:BrowserTranscriptEntry[]=[];const observed:string[]=[];const allowed=new Set(historicalSourceIds);
    let port:SemanticBrowserPort|undefined;let cleanupConfirmed:boolean|undefined=true;let leaseRetired:boolean|undefined;let sessionDisposition:'retained'|'human'|'closed'|undefined;let loginAttempted=false;let faulted=false;
    let stage:BrowserStopCode='lifecycle/authority_unavailable',localStop=false,diagnostic:BrowserStopCode='budget/completion_limit',cleanupDiagnostic:BrowserStopCode|undefined,handoffCompleted=false;
    let latestObservation:BrowserObservation|undefined;
    const boundary=(code:BrowserStopCode,local=false)=>{stage=code;localStop=local;};
    const stopped=()=>options?.mode==='live'?liveMessage('stopped'):browserMessage('stopped');
    let failure:BrowserActionStopped|undefined;
    let result:OperationLoopResult={turn:{reply:stopped(),workProposals:[],factProposals:[]},applicationAuthored:true,deadline:execution.deadline,stopReason:'invalid_model_result'};
    const check=()=>{
        try{assertExecutionActive(execution);}catch(error){throw new BrowserAuthorityStop(executionDeadlineReached(execution,error)?'lifecycle/deadline':'lifecycle/cancelled');}
        try{const state=assertBrowserWork(store,binding);assertTeachingClear(state,binding.workId);}catch{throw new BrowserAuthorityStop('lifecycle/authority_unavailable');}
    };
    const authorityCode=(error:unknown):BrowserStopCode=>error instanceof BrowserAuthorityStop?error.code:
        executionDeadlineReached(execution,error)?'lifecycle/deadline':execution.signal?.aborted?'lifecycle/cancelled':'lifecycle/authority_unavailable';
    const context:BrowserExecution={workspaceId:binding.workspaceId,workId:binding.workId,workRevision:binding.expectedWorkRevision,sessionId:randomUUID(),generation:1,execution,assertCurrent:check,
        resolveInput:(id,origin,purpose)=>resolveStoredTaskInput(store,binding,id,origin,purpose)};
    if(options?.login)context.login=(challenge,use,assertBrowserCurrent)=>{
        for(const key of ['workspaceId','workId','workRevision','sessionId','generation'] as const)
            if(challenge[key]!==context[key])throw new Error('Invalid login scope');
        const assertCurrent=()=>{check();assertBrowserCurrent();};assertCurrent();
        return options.login!(binding,{...challenge,ownerId:binding.ownerId},
            {deadline:execution.deadline,...(execution.signal?{signal:execution.signal}:{}),assertCurrent},use);
    };
    try{
        check();if(!Number.isSafeInteger(maximum)||maximum<1||maximum>8)throw new Error('Invalid browser budget');
        if(options?.mode==='live'){
            const unresolved=unresolvedBrowserActions(store.state(binding.workspaceId),binding.workId);
            if(unresolved.length)return {...result,turn:{...result.turn,reply:unresolvedBrowserMessage(unresolved)},events,cleanupConfirmed:true};
        }
        const record=store.record(binding.workspaceId,binding.ownerRecordId);
        if(record.event.type!=='message.received')throw new Error('Browser source missing');
        const scope={workspaceId:binding.workspaceId,ownerId:binding.ownerId,threadId:record.event.data.threadId,workId:binding.workId};
        let connected=options?.mode!=='live'||(options.sessionState?options.sessionState(scope)==='connected':options.available?.(scope)??true);
        const acquire=async()=>{
            if(port)return;
            boundary('browser/acquisition_failed');
            let abandoned=false;const opening=Promise.resolve().then(()=>options!.open(context,binding));
            void opening.then(async value=>{if(abandoned)await value.close();}).catch(()=>{});
            try{port=await withinExecution(()=>opening,execution);check();}catch(error){abandoned=true;cleanupConfirmed=false;throw error;}
        };
        const inputs=browserInputReferences(store.state(binding.workspaceId),binding.workId,binding.expectedWorkRevision);
        for(let i=0;i<maximum;i++){
            check();
            boundary('budget/input_limit',true);
            const next=packBrowserRequest({...request,...(execution.signal?{signal:execution.signal}:{})},
                {mode:options?.mode,enabled:!!options,connected,inputs},transcript,inputBudget);
            if(browserRequestBytes(next)>browserRequestLimit(inputBudget))throw new Error('Browser request budget exceeded');
            boundary('model/invocation_failed',true);
            const response=await withinExecution(()=>gateway.complete(next),execution);check();
            boundary('budget/response_limit',true);
            if(Buffer.byteLength(response.text,'utf8')>65536||(response.diagnosticText&&Buffer.byteLength(response.diagnosticText,'utf8')>65536))throw new Error('Browser response budget exceeded');
            boundary('response/invalid_json',true);
            const value=JSON.parse(response.text);
            boundary('response/invalid_envelope',true);
            if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Invalid browser response');
            if(Object.hasOwn(value,'tool')){
                if(loginAttempted)throw new Error('Login attempt is terminal');
                exact(value,['tool']);const tool=exact(value.tool,['name','arguments']);text(tool.name);
                boundary('tool/invalid_arguments',true);
                if(tool.name==='recall') {
                    const record=store.record(binding.workspaceId,binding.ownerRecordId);
                    if(record.event.type!=='message.received')throw new Error('Recall source missing');
                    transcript.push({tool:{name:tool.name,arguments:tool.arguments},result:invokeRecall(store,{workspaceId:binding.workspaceId,ownerId:binding.ownerId,threadId:record.event.data.threadId,workId:binding.workId},tool.arguments)});
                    continue;
                }
                if(!options)throw new Error('Browser absent');
                if(options.mode==='live'&&tool.name==='handoff'){
                    exact(tool.arguments,[]);if(!connected){transcript.push({tool:{name:tool.name,arguments:tool.arguments},result:{error:'browser_page_absent',message:liveMessage('noPage')}});continue;}
                    await acquire();boundary('browser/handoff_failed');if(!port!.handoff)throw new Error('Handoff unavailable');await withinExecution(()=>port!.handoff!(),execution);check();handoffCompleted=true;
                    result={turn:{reply:liveMessage('manual'),workProposals:[],factProposals:[]},applicationAuthored:true,deadline:execution.deadline,stopReason:'completed'};break;
                }
                boundary('tool/unsupported_tool',true);
                if(options.mode==='live'&&tool.name==='request_login')throw new Error('Use manual handoff');
                if(tool.name!=='observe'&&!(options.mode==='live'&&tool.name==='visit')&&!['navigate','click','fill','select','request_login'].includes(tool.name))throw new Error('Unsupported browser tool');
                boundary('tool/invalid_arguments',true);
                if(tool.name==='observe')exact(tool.arguments,[]);
                // Validate complete model arguments before opening a browser.
                if(tool.arguments&&typeof tool.arguments==='object'&&Object.hasOwn(tool.arguments,'kind'))throw new Error('Invalid tool arguments');
                let destination:string|undefined;
                if(tool.name==='visit'){const args=exact(tool.arguments,['url']);text(args.url);destination=publicHttpsUrl(args.url).href;}
                const command=tool.name==='observe'||destination?undefined:parseBrowserCommand({...(tool.arguments as object),kind:tool.name});
                if(options.mode==='live'&&command){
                    boundary('tool/reference_rejected',true);
                    if(!latestObservation)throw new Error('No current observation');
                    // This only rejects model references. The adapter still checks the live DOM and lease.
                    resolveControl(latestObservation,latestObservation,command);
                }
                if(options.mode==='live'&&!connected&&tool.name==='observe'){
                    transcript.push({tool:{name:tool.name,arguments:tool.arguments},result:{error:'browser_page_absent',message:liveMessage('noPage')}});continue;
                }
                await acquire();
                if(command?.kind==='request_login')loginAttempted=true;
                let observation:BrowserObservation,recovery:BrowserActionStopped|undefined;
                boundary(tool.name==='observe'?'browser/observation_failed':'browser/operation_failed');
                try{observation=await withinExecution(()=>destination?port!.visit!(context,destination):command?port!.interact(context,command):port!.observe(context),execution);}
                catch(error){
                    if(options.mode!=='live'||!(error instanceof BrowserActionStopped)||!recoverableBrowserFailure(error))throw error;
                    check();recovery=error;
                    boundary('browser/observation_failed');
                    observation=await withinExecution(()=>port!.observe(context),execution);
                }
                check();connected=true;
                boundary('browser/observation_failed');
                const source=recordBrowserObservation(store,binding,observation,check);observed.push(source.id);allowed.add(source.id);
                latestObservation=observation;
                transcript.push({tool:{name:tool.name,arguments:tool.arguments},observation,...(recovery?{result:{actionId:recovery.actionId,status:'failed',disposition:'not_dispatched',diagnostic:recovery.diagnostic}}:{})});
            }else{
                const final=exact(value,['reply','notes',...(Object.hasOwn(value,'progress')?['progress']:[])]);text(final.reply,16384);
                boundary('final/invalid_notes',true);
                events.push(...prepareBrowserLearningEvents(store,binding,final.notes,allowed));
                boundary('final/invalid_progress',true);
                const progress=Object.hasOwn(final,'progress')?parseProgressReport(final.progress):undefined;
                result={turn:{reply:final.reply,workProposals:[],factProposals:[],...(progress?{progress}:{})},applicationAuthored:false,deadline:execution.deadline,stopReason:'completed'};break;
            }
        }
    }catch(error){events.length=0;diagnostic=error instanceof BrowserAuthorityStop?error.code:stage;faulted=error instanceof BrowserAuthorityStop||!localStop;
        if(error instanceof BrowserActionStopped)failure=error;
        if(error instanceof BrowserActionStopped&&error.status==='handoff'){handoffCompleted=true;faulted=false;}
    }
    finally{
        try{await assertExecutionCurrent(execution);check();}catch(error){diagnostic=authorityCode(error);faulted=true;handoffCompleted=false;}
        if(options?.mode==='live'&&unresolvedBrowserActions(store.state(binding.workspaceId),binding.workId).length)faulted=true;
        if(port){try{
            if(port.retire){const retired=await port.retire(!faulted);cleanupConfirmed=retired.cleanupConfirmed;leaseRetired=retired.leaseRetired;sessionDisposition=retired.sessionDisposition;
                if(!faulted&&sessionDisposition==='closed')cleanupDiagnostic='cleanup/retirement_failed';
                if(faulted&&sessionDisposition==='human'){cleanupConfirmed=(await port.close()).confirmed;leaseRetired=cleanupConfirmed;sessionDisposition=cleanupConfirmed?'closed':undefined;}
            }else{cleanupConfirmed=(await port.close()).confirmed;sessionDisposition=cleanupConfirmed?'closed':undefined;}
        }catch{cleanupConfirmed=false;leaseRetired=false;cleanupDiagnostic='cleanup/retirement_failed';}}
    }
    try{await assertExecutionCurrent(execution);check();}catch(error){diagnostic=authorityCode(error);faulted=true;handoffCompleted=false;
        if(port&&sessionDisposition!=='closed'){try{cleanupConfirmed=(await port.close()).confirmed;}catch{cleanupConfirmed=false;}leaseRetired=cleanupConfirmed;sessionDisposition=cleanupConfirmed?'closed':undefined;}
    }
    if(faulted){events.length=0;result={turn:{reply:stopped(),workProposals:[],factProposals:[]},applicationAuthored:true,deadline:execution.deadline,stopReason:'invalid_model_result'};}
    const retiredSafely=leaseRetired===true||cleanupConfirmed===true;
    if(sessionDisposition==='human'&&handoffCompleted&&!faulted)result={turn:{reply:liveMessage('manual'),workProposals:[],factProposals:[]},applicationAuthored:true,deadline:execution.deadline,stopReason:'completed'};
    if(!retiredSafely){if(result.stopReason==='completed')diagnostic='cleanup/retirement_failed';cleanupDiagnostic='cleanup/cleanup_unconfirmed';events.length=0;result={turn:{reply:stopped(),workProposals:[],factProposals:[]},applicationAuthored:true,deadline:execution.deadline,stopReason:'invalid_model_result'};}
    if(options?.mode==='live'&&result.applicationAuthored&&result.stopReason!=='completed'){
        result={...result,turn:{...result.turn,reply:browserStopMessage(diagnostic,sessionDisposition,cleanupDiagnostic)},
            stopReason:diagnostic==='model/invocation_failed'?'model_unavailable':diagnostic==='lifecycle/deadline'?'deadline':diagnostic==='lifecycle/cancelled'?'cancelled':'invalid_model_result'};
    }
    if(options?.mode==='live'){
        const unresolved=unresolvedBrowserActions(store.state(binding.workspaceId),binding.workId);
        if(unresolved.length){events.length=0;result={turn:{reply:unresolvedBrowserMessage(unresolved,failure?.diagnostic)+(!retiredSafely?' '+liveMessage('cleanupPending'):''),workProposals:[],factProposals:[]},applicationAuthored:true,deadline:execution.deadline,stopReason:'invalid_model_result'};}
    }
    if(retiredSafely&&result.applicationAuthored&&observed.length){try{check();events.push({type:'browser.checkpoint',data:{workId:binding.workId,expectedWorkRevision:binding.expectedWorkRevision,sourceIds:observed.slice(-8),reason:'exploration_stopped'}});}catch{/* No stale/cancelled checkpoint. */}}
    return {...result,events,...(result.applicationAuthored&&result.stopReason!=='completed'?{diagnostic}:{}),...(port?{closeSession:()=>port!.close()}:{}),...(cleanupConfirmed===undefined?{}:{cleanupConfirmed}),...(leaseRetired===undefined?{}:{leaseRetired}),...(sessionDisposition?{sessionDisposition}:{})};
}
