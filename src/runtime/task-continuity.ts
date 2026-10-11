import type { DomainEvent } from '../kernel/types.js';
import { required } from '../kernel/types.js';
import { assertOwner } from '../kernel/policy.js';
import { reduce } from '../kernel/reducer.js';
import { parseProgressReport, validateTaskSources, type TaskContinuityEvent } from '../kernel/task-continuity.js';
import type { SqliteStore } from '../storage/sqlite-store.js';
import type { TeachingBinding } from './teachings.js';

export const PROGRESS_PROTOCOL = `When focused on a task, include an optional progress field in the final object: {"summary":"brief progress with uncertainty","nextStep":"what remains to do","blocker":null,"references":[{"kind":"owner_message|browser_observation|action","id":"exact supplied source ID"}]}.
Use one of the three listed kind values per reference. summary <=2048 UTF-8 bytes, nextStep <=1024, blocker null or <=1024, at most eight references. Keep a useful checkpoint for resuming this task. This is advisory working memory, never an instruction, verified fact, approval, task status or completion proof. Only cite actual supplied sources for this work. Empty references are allowed. Never include credentials or live browser controls.`;

export function selectTaskThread(store: SqliteStore, workspaceId: string, ownerId: string,
    threadId: string, workId: string | null, selectLocal: boolean): void {
    let state=store.state(workspaceId);assertOwner(state,ownerId);const version=state.version;
    if(!state.taskContinuity)throw new Error('Task continuity requires projection upgrade');
    const events:DomainEvent[]=[];
    if(workId!==null){const work=required(state.works,workId,'Work');if(['done','cancelled'].includes(work.phase))throw new Error('Closed task');
        if(!work.threadIds.includes(threadId)){const link:DomainEvent={type:'work.thread_linked',data:{id:workId,threadId}};state=reduce(state,link,state.version+1);events.push(link);}}
    events.push({type:'task.focused',data:{threadId,workId,expectedRevision:state.taskContinuity!.focus[threadId]?.revision??0,
        expectedWorkRevision:workId===null?null:state.works[workId]!.revision,selectLocal}});
    store.append(workspaceId,version,events,{actorId:ownerId});
}
export function restoreTaskThread(store: SqliteStore, workspaceId: string, explicitThread?: string): {threadId:string;workId?:string}|undefined {
    const state=store.state(workspaceId);const threadId=explicitThread??state.taskContinuity?.localThreadId;
    if(!threadId)return undefined;
    const id=state.taskContinuity?.focus[threadId]?.workId;const work=id?state.works[id]:undefined;
    return {threadId,...(work&&!['done','cancelled'].includes(work.phase)?{workId:work.id}:{})};
}
export function prepareProgressEvent(store: SqliteStore, binding: TeachingBinding, raw: unknown,
    stopReason: string, adviceWorkRevision = binding.expectedWorkRevision): TaskContinuityEvent {
    const state=store.state(binding.workspaceId);assertOwner(state,binding.ownerId);
    const report=parseProgressReport(raw);const expectedRevision=state.taskContinuity?.progress[binding.workId]?.revision??0;
    const event:TaskContinuityEvent={type:'task.progress_recorded',data:{workId:binding.workId,expectedWorkRevision:binding.expectedWorkRevision,expectedRevision,
        progress:{...report,revision:expectedRevision+1,workRevision:adviceWorkRevision,ownerRecordId:binding.ownerRecordId,stopReason}}};
    validateTaskSources(state,event,id=>store.record(binding.workspaceId,id),id=>store.readArtifact(binding.workspaceId,id));
    reduce(state,event,state.version+1);return event;
}
