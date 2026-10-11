import type { JournalRecord, State } from './types.js';
import { required } from './types.js';
import type { BrowserObservation, TaskInputBinding } from './browser-types.js';
import { browserOrigin, exact, text, validateObservation } from './browser-contract.js';
import { assertTeachingClear, validateTeachingSource, type TeachingSource } from './teachings.js';
export interface ObservationSource {
    id:string;workId:string;workRevision:number;origin:string;sessionId:string;documentId:string;
    observedAt:string;artifactId:string;ownerRecordId:string;
}
export interface LearnedNote {id:string;workId:string;origin:string;text:string;sourceIds:string[];status:'candidate'|'invalidated';reason?:string}
export interface BrowserMemory {
    observations:Record<string,ObservationSource>;notes:Record<string,LearnedNote>;inputs:Record<string,TaskInputBinding>;
    checkpoints:Record<string,{sourceIds:string[];reason:string}>;
}
export type BrowserLearningEvent =
    {type:'browser.observed';data:{source:ObservationSource;expectedWorkRevision:number}} |
    {type:'browser.note_recorded';data:{note:LearnedNote;expectedWorkRevision:number}} |
    {type:'browser.note_retired';data:{id:string;workId:string;reason:string;expectedWorkRevision:number}} |
    {type:'browser.input_authorized';data:{binding:TaskInputBinding;expectedWorkRevision:number}} |
    {type:'browser.input_revoked';data:{id:string;workId:string;expectedWorkRevision:number}} |
    {type:'browser.checkpoint';data:{workId:string;sourceIds:string[];reason:string;expectedWorkRevision:number}};
export function browserEventWork(event:BrowserLearningEvent):string {
    if(event.type==='browser.observed')return event.data.source.workId;
    if(event.type==='browser.note_recorded')return event.data.note.workId;
    if(event.type==='browser.input_authorized')return event.data.binding.workId;
    return event.data.workId;
}
export function emptyBrowserMemory():BrowserMemory{return {observations:{},notes:{},inputs:{},checkpoints:{}};}
function sources(memory:BrowserMemory,ids:string[],workId:string,origin?:string):void{
    if(!Array.isArray(ids)||!ids.length||ids.length>8||new Set(ids).size!==ids.length)throw new Error('Invalid browser sources');
    for(const id of ids){text(id);const source=required(memory.observations,id,'Observation');if(source.workId!==workId||origin!==undefined&&source.origin!==origin)throw new Error('Browser source scope mismatch');}
}
export function reduceBrowserLearning(state:State,event:BrowserLearningEvent):void {
    const memory=state.browserMemory;if(!memory)throw new Error('Browser learning requires projection upgrade');
    const workId=browserEventWork(event);const work=required(state.works,workId,'Work');
    if(work.revision!==event.data.expectedWorkRevision||['done','cancelled'].includes(work.phase))throw new Error('Stale browser work');
    switch(event.type){
        case 'browser.observed':{assertTeachingClear(state,workId);exact(event.data,['source','expectedWorkRevision']);const s=event.data.source;exact(s,['id','workId','workRevision','origin','sessionId','documentId','observedAt','artifactId','ownerRecordId']);for(const key of ['id','workId','sessionId','documentId','artifactId','ownerRecordId'] as const)text(s[key]);browserOrigin(s.origin);if(s.workRevision!==work.revision||!Number.isFinite(Date.parse(s.observedAt))||Object.hasOwn(memory.observations,s.id))throw new Error('Invalid observation');memory.observations[s.id]=structuredClone(s);break;}
        case 'browser.note_recorded':{exact(event.data,['note','expectedWorkRevision']);const n=event.data.note;exact(n,['id','workId','origin','text','sourceIds','status']);text(n.id);text(n.text,2048);browserOrigin(n.origin);sources(memory,n.sourceIds,workId,n.origin);if(n.status!=='candidate'||Object.hasOwn(memory.notes,n.id))throw new Error('Invalid learned note');memory.notes[n.id]=structuredClone(n);break;}
        case 'browser.note_retired':{exact(event.data,['id','workId','reason','expectedWorkRevision']);const n=required(memory.notes,event.data.id,'Note');text(event.data.reason,2048);if(n.workId!==workId||n.status!=='candidate')throw new Error('Invalid note retirement');n.status='invalidated';n.reason=event.data.reason;break;}
        case 'browser.input_authorized':{exact(event.data,['binding','expectedWorkRevision']);const b=event.data.binding;exact(b,['id','workspaceId','workId','workRevision','origin','purpose','status','sourceRecordId','sourceQuote','sourceStart','sourceEnd']);text(b.id);text(b.purpose);browserOrigin(b.origin);if(b.status!=='active'||b.workspaceId!==state.workspaceId||b.workRevision!==work.revision||Object.hasOwn(memory.inputs,b.id))throw new Error('Invalid input binding');memory.inputs[b.id]=structuredClone(b);break;}
        case 'browser.input_revoked':{exact(event.data,['id','workId','expectedWorkRevision']);const b=required(memory.inputs,event.data.id,'Input');if(b.workId!==workId||b.status!=='active')throw new Error('Invalid input revocation');b.status='revoked';break;}
        case 'browser.checkpoint':exact(event.data,['workId','sourceIds','reason','expectedWorkRevision']);sources(memory,event.data.sourceIds,workId);text(event.data.reason,256);memory.checkpoints[workId]={sourceIds:[...event.data.sourceIds],reason:event.data.reason};break;
    }
}
export function validateBrowserSources(state:State,event:BrowserLearningEvent,record:(id:string)=>JournalRecord,artifact:(id:string)=>string):void{
    if(event.type==='browser.input_authorized'){
        const b=event.data.binding;const source:TeachingSource={sourceRecordId:b.sourceRecordId,sourceQuote:b.sourceQuote,sourceStart:b.sourceStart,sourceEnd:b.sourceEnd};
        validateTeachingSource(state,{type:'teaching.retracted',data:{id:b.id,workId:b.workId,source,expectedRevision:1,expectedWorkRevision:b.workRevision}},record,artifact);
    }else if(event.type==='browser.observed'){
        const s=event.data.source;const r=record(s.ownerRecordId);const work=required(state.works,s.workId,'Work');
        if(r.workspaceId!==state.workspaceId||r.seq>state.version||r.event.type!=='message.received'||r.event.data.senderRole!=='owner'||r.event.data.senderId!==state.ownerId||!work.threadIds.includes(r.event.data.threadId))throw new Error('Invalid browser owner binding');
        const body=artifact(s.artifactId);if(Buffer.byteLength(body,'utf8')>32768)throw new Error('Observation budget');
        const observation=JSON.parse(body) as BrowserObservation;validateObservation(observation,observation);
        if(observation.workspaceId!==state.workspaceId||observation.id!==s.id||observation.workId!==s.workId||observation.workRevision!==s.workRevision||observation.origin!==s.origin||observation.sessionId!==s.sessionId||observation.documentId!==s.documentId||observation.observedAt!==s.observedAt)throw new Error('Observation evidence mismatch');
    }
}
