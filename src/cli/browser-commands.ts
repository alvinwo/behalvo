import { randomUUID } from 'node:crypto';
import { liveMessage } from '../browser/live-messages.js';
import type { ManagedBrowserController, ManagedBrowserScope } from '../browser/managed-session.js';
import type { LiveReviewDetail } from '../browser/live-playwright.js';
import { isBrowserActionCommand } from '../kernel/browser-action.js';
import { assertOwner } from '../kernel/policy.js';
import type { Action } from '../kernel/types.js';
import type { BrowserReview } from '../runtime/browser-actions.js';
import { Operator } from '../runtime/operator.js';
import type { SqliteStore } from '../storage/sqlite-store.js';
import type { ReplIo } from './repl.js';

export async function reviewBrowserGesture(io:ReplIo,action:Action,detail:LiveReviewDetail,signal?:AbortSignal):Promise<BrowserReview>{
    if(io.interactive!==true||!io.discardSensitiveInput||signal?.aborted)return 'reject';
    io.discardSensitiveInput();
    try{
        io.write(JSON.stringify({actionId:action.id,workId:action.workId,workRevision:action.workRevision,digest:action.digest,...detail}));
        const answer=(await io.readLine(liveMessage('review'),signal))?.trim();
        if(signal?.aborted)return 'reject';return answer==='approve'||answer==='handoff'?answer:'reject';
    }catch{return 'reject';}finally{io.discardSensitiveInput();}
}

export function displayBrowserActions(store:SqliteStore,scope:Omit<ManagedBrowserScope,'workId'>&{workId?:string},write:(line:string)=>void):void{
    const state=store.state(scope.workspaceId);assertOwner(state,scope.ownerId);if(!scope.workId)throw new Error(liveMessage('focus'));
    for(const action of Object.values(state.actions))if(action.workId===scope.workId&&isBrowserActionCommand(action.command))
        write(JSON.stringify({actionId:action.id,workId:action.workId,status:action.status,digest:action.digest,command:action.command,evidenceRef:action.evidenceRef??null}));
}

export async function handleBrowserCommand(raw:string,options:{store:SqliteStore;controller?:ManagedBrowserController;scope:Omit<ManagedBrowserScope,'workId'>&{workId?:string};io:ReplIo}):Promise<boolean>{
    if(!/^\s*\/browser(?:\s|$)/.test(raw))return false;
    const {store,controller,io}=options;const words=raw.trim().split(/\s+/),command=words[1]??'status';
    if(/[\r\n]/.test(raw)||!['open','allow','status','input','handoff','resume','close','resolve'].includes(command)){io.write(liveMessage('usage'));return true;}
    if(!controller){io.write(liveMessage('unavailable'));return true;}
    if(io.interactive!==true){io.write(liveMessage('interactive'));return true;}
    if(!options.scope.workId){io.write(liveMessage('focus'));return true;}
    const scope:ManagedBrowserScope={...options.scope,workId:options.scope.workId};
    try{
        const state=store.state(scope.workspaceId);assertOwner(state,scope.ownerId);const work=state.works[scope.workId];
        if(!work||!work.threadIds.includes(scope.threadId))throw new Error('Scope mismatch');
        const fixed=['status','handoff','resume','close'].includes(command);
        if(fixed&&words.length!==(words.length===1?1:2)||['open','allow'].includes(command)&&words.length!==3||command==='input'&&words.length<4||command==='resolve'&&words.length<5){io.write(liveMessage('usage'));return true;}
        if(command==='status'){io.write(JSON.stringify(controller.status(scope)));return true;}
        if(command==='close'){io.write(liveMessage((await controller.close(scope)).confirmed?'closed':'cleanupPending'));return true;}
        if(command==='allow'){controller.allow(scope,words[2]!);io.write(liveMessage('allowed'));return true;}
        if(command==='handoff'){await controller.handoff(scope);io.write(liveMessage('manual'));return true;}
        if(command==='resume'){
            if(!io.discardSensitiveInput)throw new Error('Fresh prompt unavailable');io.discardSensitiveInput();
            let answer:string|null;try{answer=await io.readLine(liveMessage('resume'));}finally{io.discardSensitiveInput();}
            if(answer?.trim()!=='resume'){io.write(liveMessage('cancelled'));return true;}
            await controller.resume(scope);io.write(liveMessage('resumed'));return true;
        }
        if(command==='resolve'){
            const action=state.actions[words[2]!];const status=words[3];const note=raw.trim().split(/\s+/).slice(4).join(' ');
            if(!action||action.workId!==scope.workId||!isBrowserActionCommand(action.command)||action.command.threadId!==scope.threadId||action.status!=='unknown'||!['accepted','failed'].includes(status!)||Buffer.byteLength(note)>2048)throw new Error('Invalid reconciliation');
            new Operator(store).reconcile(scope.workspaceId,scope.ownerId,action.id,status as 'accepted'|'failed',note);io.write(liveMessage('resolved'));return true;
        }
        const value=command==='input'?raw.trim().replace(/^\/browser\s+input\s+\S+\s+/,''):undefined;
        if(value!==undefined&&(!value.trim()||Buffer.byteLength(value)>4096))throw new Error('Invalid input');
        // Store the exact non-secret input as its own owner source; command syntax is not source text.
        const source=store.ingest(scope.workspaceId,{source:'owner:managed-browser',externalId:randomUUID(),threadId:scope.threadId,senderId:scope.ownerId,senderRole:'owner',text:value??raw.trim()});
        const binding={...scope,ownerRecordId:source.id,expectedWorkRevision:work.revision};
        if(command==='input')io.write(liveMessage('inputSaved')+controller.input(binding,words[2]!,value!));
        else{
            const signal=AbortSignal.timeout(120000);await controller.open(binding,words[2]!,{deadline:Date.now()+120000,signal});io.write(liveMessage('opened'));
        }
    }catch{io.write(liveMessage('failed'));}
    return true;
}
