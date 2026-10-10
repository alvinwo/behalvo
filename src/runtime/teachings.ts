import { randomUUID } from 'node:crypto';
import type { DomainEvent } from '../kernel/types.js';
import { required } from '../kernel/types.js';
import { assertOwner } from '../kernel/policy.js';
import { reduce } from '../kernel/reducer.js';
import { boundedText, type TeachingSource } from '../kernel/teachings.js';
import type { SqliteStore } from '../storage/sqlite-store.js';
export interface TeachingBinding { workspaceId: string; ownerId: string; workId: string; ownerRecordId: string; expectedWorkRevision: number }
export type TeachingChange = { kind: 'add'; sourceQuote: string; interpretation: string } |
    { kind: 'replace'; teachingId: string; expectedRevision: number; sourceQuote: string; interpretation: string } |
    { kind: 'retract'; teachingId: string; expectedRevision: number; sourceQuote: string };
export type TeachingResult = { outcome: 'none' } |
    { outcome: 'apply'; changes: TeachingChange[]; resolutions: {clarificationId: string; sourceQuote: string}[] } |
    { outcome: 'clarify'; sourceQuote: string; targets: {teachingId: string; expectedRevision: number}[]; question: string };
function object(value: unknown, keys: string[]): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length || keys.some(k=>!Object.hasOwn(value,k))) throw new Error('Invalid teaching protocol');
    return value as Record<string,unknown>;
}
function array(value: unknown): unknown[] { if (!Array.isArray(value) || value.length > 8) throw new Error('Invalid teaching list'); return value; }
export function parseTeachingResult(value: unknown): TeachingResult {
    const outcome = (value as {outcome?:unknown})?.outcome;
    if (outcome === 'none') object(value,['outcome']);
    else if (outcome === 'apply') {
        const v=object(value,['outcome','changes','resolutions']);
        const changes=array(v.changes), resolutions=array(v.resolutions);
        if (!changes.length && !resolutions.length) throw new Error('Empty teaching changes');
        for (const raw of changes) {
            const kind=(raw as {kind?:unknown})?.kind;
            const keys=kind==='add'?['kind','sourceQuote','interpretation']:kind==='replace'?['kind','teachingId','expectedRevision','sourceQuote','interpretation']:kind==='retract'?['kind','teachingId','expectedRevision','sourceQuote']:[];
            if (!keys.length) throw new Error('Invalid teaching change');
            const x=object(raw,keys); boundedText(x.sourceQuote,4096);
            if (kind!=='retract') boundedText(x.interpretation,2048);
            if (kind!=='add') { boundedText(x.teachingId,128); if (!Number.isSafeInteger(x.expectedRevision) || Number(x.expectedRevision)<1) throw new Error('Invalid teaching revision'); }
        }
        for (const raw of resolutions) {const x=object(raw,['clarificationId','sourceQuote']); boundedText(x.clarificationId,128);boundedText(x.sourceQuote,4096);}
    } else if (outcome === 'clarify') {
        const v=object(value,['outcome','sourceQuote','targets','question']); boundedText(v.sourceQuote,4096);boundedText(v.question,2048);
        for (const raw of array(v.targets)) { const x=object(raw,['teachingId','expectedRevision']);boundedText(x.teachingId,128);if (!Number.isSafeInteger(x.expectedRevision)||Number(x.expectedRevision)<1) throw new Error('Invalid teaching revision'); }
    } else throw new Error('Invalid teaching outcome');
    return structuredClone(value) as TeachingResult;
}
export function prepareTeachingEvents(store: SqliteStore, binding: TeachingBinding, raw: unknown): DomainEvent[] {
    const result=parseTeachingResult(raw); let state=store.state(binding.workspaceId); assertOwner(state,binding.ownerId);
    const work=required(state.works,binding.workId,'Work');
    if (!state.teachingMemory || work.revision!==binding.expectedWorkRevision || ['done','cancelled'].includes(work.phase)) throw new Error('Stale work or teaching projection upgrade required');
    const record=store.record(binding.workspaceId,binding.ownerRecordId);
    if (record.event.type!=='message.received' || record.event.data.senderRole!=='owner' || record.event.data.senderId!==binding.ownerId || !work.threadIds.includes(record.event.data.threadId)) throw new Error('Invalid teaching owner source');
    const text=store.readArtifact(binding.workspaceId,record.event.data.artifactId);
    const source=(quote:string):TeachingSource=>{
        const start=text.indexOf(quote);
        if (start<0||text.lastIndexOf(quote)!==start) throw new Error('Teaching source must be unique and exact');
        return {sourceRecordId:record.id,sourceQuote:quote,sourceStart:start,sourceEnd:start+quote.length};
    };
    const events:DomainEvent[]=[]; const used=new Set<string>();
    const once=(id:string)=>{if(used.has(id))throw new Error('Duplicate teaching target');used.add(id);};
    const add=(event:DomainEvent)=>{state=reduce(state,event,state.version+1);events.push(event);};
    if(result.outcome==='apply') {
        for(const change of result.changes) {
            if(change.kind!=='add')once(change.teachingId);
            const from=source(change.sourceQuote); const expectedWorkRevision=state.works[binding.workId]!.revision;
            if(change.kind==='retract') add({type:'teaching.retracted',data:{id:change.teachingId,workId:work.id,expectedRevision:change.expectedRevision,expectedWorkRevision,source:from}});
            else add({type:'teaching.recorded',data:{expectedWorkRevision,...(change.kind==='replace'?{expectedRevision:change.expectedRevision}:{}),teaching:{id:randomUUID(),workId:work.id,revision:1,status:'active',interpretation:change.interpretation,...from,...(change.kind==='replace'?{supersedes:change.teachingId}:{})}}});
        }
        for(const resolution of result.resolutions) {once(resolution.clarificationId);add({type:'teaching.clarification_resolved',data:{id:resolution.clarificationId,workId:work.id,expectedWorkRevision:state.works[work.id]!.revision,source:source(resolution.sourceQuote)}});}
    } else if(result.outcome==='clarify') {
        for(const target of result.targets) {once(target.teachingId);const old=required(state.teachingMemory!.teachings,target.teachingId,'Teaching');if(old.workId!==work.id||old.status!=='active'||old.revision!==target.expectedRevision)throw new Error('Stale clarification target');}
        add({type:'teaching.clarification_opened',data:{expectedWorkRevision:work.revision,clarification:{id:randomUUID(),workId:work.id,status:'open',question:result.question,...source(result.sourceQuote)}}});
    }
    return events;
}
