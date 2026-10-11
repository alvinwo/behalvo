import { randomUUID } from 'node:crypto';
import type { DomainEvent, State } from '../kernel/types.js';
import { required } from '../kernel/types.js';
import { assertOwner } from '../kernel/policy.js';
import { reduce } from '../kernel/reducer.js';
import type { BrowserObservation, TaskInputBinding } from '../kernel/browser-types.js';
import { exact, text, exactInputSource, resolveTaskInput, validateObservation } from '../kernel/browser-contract.js';
import type { ObservationSource } from '../kernel/browser-learning.js';
import type { TeachingBinding } from './teachings.js';
import type { SqliteStore } from '../storage/sqlite-store.js';
export function assertBrowserWork(store:SqliteStore,b:TeachingBinding):State{
    const state=store.state(b.workspaceId);assertOwner(state,b.ownerId);const work=required(state.works,b.workId,'Work');
    if(!state.browserMemory||work.revision!==b.expectedWorkRevision||['done','cancelled'].includes(work.phase))throw new Error('Stale work or browser projection upgrade required');
    const r=store.record(b.workspaceId,b.ownerRecordId);if(r.event.type!=='message.received'||r.event.data.senderRole!=='owner'||r.event.data.senderId!==b.ownerId||!work.threadIds.includes(r.event.data.threadId))throw new Error('Invalid browser owner binding');return state;
}
export function recordBrowserObservation(store:SqliteStore,b:TeachingBinding,raw:BrowserObservation):ObservationSource{
    const state=assertBrowserWork(store,b);const o=validateObservation(raw,raw);if(o.workspaceId!==b.workspaceId||o.workId!==b.workId||o.workRevision!==b.expectedWorkRevision)throw new Error('Invalid observation scope');
    const source:ObservationSource={id:o.id,workId:o.workId,workRevision:o.workRevision,origin:o.origin,sessionId:o.sessionId,documentId:o.documentId,observedAt:o.observedAt,artifactId:store.putArtifact(b.workspaceId,JSON.stringify(o)),ownerRecordId:b.ownerRecordId};
    store.append(b.workspaceId,state.version,[{type:'browser.observed',data:{source,expectedWorkRevision:b.expectedWorkRevision}}],{actorId:'browser',causationId:b.ownerRecordId});return source;
}
export function prepareBrowserLearningEvents(store:SqliteStore,b:TeachingBinding,raw:unknown,allowedSources?:ReadonlySet<string>):DomainEvent[]{
    let state=assertBrowserWork(store,b);if(!Array.isArray(raw)||raw.length>8)throw new Error('Invalid note proposals');const events:DomainEvent[]=[];
    for(const item of raw){const value=exact(item,['text','sourceIds']);text(value.text,2048);if(!Array.isArray(value.sourceIds)||!value.sourceIds.length||value.sourceIds.some(id=>typeof id!=='string'||allowedSources&&!allowedSources.has(id)))throw new Error('Invalid note sources');
        const source=required(state.browserMemory!.observations,value.sourceIds[0],'Observation');
        const event:DomainEvent={type:'browser.note_recorded',data:{expectedWorkRevision:b.expectedWorkRevision,note:{id:randomUUID(),workId:b.workId,origin:source.origin,text:value.text,sourceIds:value.sourceIds,status:'candidate'}}};state=reduce(state,event,state.version+1);events.push(event);
    }return events;
}
/** Trusted local owner-control API, never registered as a model tool. */
export function authorizeTaskInput(store:SqliteStore,b:TeachingBinding,raw:unknown):TaskInputBinding{
    const state=assertBrowserWork(store,b);const v=exact(raw,['quote','origin','purpose']);text(v.quote,4096);text(v.origin,2048);text(v.purpose);
    const record=store.record(b.workspaceId,b.ownerRecordId);if(record.event.type!=='message.received')throw new Error('Invalid input source');
    const binding:TaskInputBinding={id:randomUUID(),workspaceId:b.workspaceId,workId:b.workId,workRevision:b.expectedWorkRevision,origin:v.origin,purpose:v.purpose,status:'active',...exactInputSource(record.id,store.readArtifact(b.workspaceId,record.event.data.artifactId),v.quote)};
    store.append(b.workspaceId,state.version,[{type:'browser.input_authorized',data:{binding,expectedWorkRevision:b.expectedWorkRevision}}],{actorId:b.ownerId,causationId:b.ownerRecordId});return binding;
}
export function revokeTaskInput(store:SqliteStore,b:TeachingBinding,id:string):void{const state=assertBrowserWork(store,b);store.append(b.workspaceId,state.version,[{type:'browser.input_revoked',data:{id,workId:b.workId,expectedWorkRevision:b.expectedWorkRevision}}],{actorId:b.ownerId,causationId:b.ownerRecordId});}
export function resolveStoredTaskInput(store:SqliteStore,b:TeachingBinding,id:string,origin:string,purpose:string):string{
    const state=assertBrowserWork(store,b);return resolveTaskInput(required(state.browserMemory!.inputs,id,'Input'),{workspaceId:b.workspaceId,workId:b.workId,workRevision:b.expectedWorkRevision},origin,purpose);
}
export function retireBrowserNote(store:SqliteStore,b:TeachingBinding,id:string,reason:string):void{const state=assertBrowserWork(store,b);store.append(b.workspaceId,state.version,[{type:'browser.note_retired',data:{id,workId:b.workId,reason,expectedWorkRevision:b.expectedWorkRevision}}],{actorId:b.ownerId,causationId:b.ownerRecordId});}
