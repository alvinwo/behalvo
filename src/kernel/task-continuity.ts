import type { JournalRecord, State } from './types.js';
import { identifier, required } from './types.js';
import { boundedText } from './teachings.js';

export interface OwnerIntakeReceipt {
    ownerRecordId: string; threadId: string; workId: string | null; workRevisionAtIntake: number | null;
    outcome: 'ready' | 'clarify'; question?: string; goalSourceQuote?: string;
}
export interface ProgressReport {
    summary: string; nextStep: string; blocker: string | null;
    references: {kind: 'owner_message' | 'browser_observation' | 'action'; id: string}[];
}
export interface TaskProgress extends ProgressReport {
    revision: number; workRevision: number; ownerRecordId: string; stopReason: string;
}
export interface TaskContinuity {
    focus: Record<string, {workId: string | null; revision: number}>;
    localThreadId?: string;
    intakes: Record<string, OwnerIntakeReceipt>;
    progress: Record<string, TaskProgress>;
}
export type TaskContinuityEvent =
    {type: 'task.focused'; data: {threadId: string; workId: string | null; expectedRevision: number; expectedWorkRevision: number | null; selectLocal: boolean}} |
    {type: 'task.intake_recorded'; data: {receipt: OwnerIntakeReceipt}} |
    {type: 'task.progress_recorded'; data: {workId: string; expectedWorkRevision: number; expectedRevision: number; progress: TaskProgress}};

export function emptyTaskContinuity(): TaskContinuity { return {focus:{},intakes:{},progress:{}}; }
export function taskObject(value: unknown, keys: string[], optional: string[] = []): asserts value is Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        keys.some(k=>!Object.hasOwn(value,k)) || Object.keys(value).some(k=>!keys.includes(k)&&!optional.includes(k)))
        throw new Error('Invalid task continuity fields');
}
function revision(value: unknown, minimum = 0): asserts value is number {
    if (!Number.isSafeInteger(value) || Number(value)<minimum) throw new Error('Invalid task revision');
}
export function parseProgressReport(value: unknown): ProgressReport {
    taskObject(value,['summary','nextStep','blocker','references']);
    boundedText(value.summary,2048); boundedText(value.nextStep,1024);
    if (value.blocker!==null) boundedText(value.blocker,1024);
    if (!Array.isArray(value.references)||value.references.length>8) throw new Error('Invalid progress references');
    const used=new Set<string>();
    for (const ref of value.references) {
        taskObject(ref,['kind','id']); identifier(ref.id);
        if (!['owner_message','browser_observation','action'].includes(String(ref.kind)) || used.has(`${ref.kind}:${ref.id}`)) throw new Error('Invalid progress reference');
        used.add(`${ref.kind}:${ref.id}`);
    }
    return structuredClone(value) as unknown as ProgressReport;
}
function activeWork(state: State, id: string, expected: number) {
    const work=required(state.works,id,'Work'); revision(expected,1);
    if (['done','cancelled'].includes(work.phase)||work.revision!==expected) throw new Error('Stale or closed task');
    return work;
}
export function reduceTaskContinuity(state: State, event: TaskContinuityEvent): void {
    const memory=state.taskContinuity;
    if (!memory) throw new Error('Task continuity requires projection upgrade');
    switch (event.type) {
        case 'task.focused': {
            const d=event.data;taskObject(d,['threadId','workId','expectedRevision','expectedWorkRevision','selectLocal']);
            identifier(d.threadId);revision(d.expectedRevision);
            if(typeof d.selectLocal!=='boolean'||(memory.focus[d.threadId]?.revision??0)!==d.expectedRevision) throw new Error('Stale focus revision');
            if(d.workId!==null) {const work=activeWork(state,d.workId,d.expectedWorkRevision!);if(!work.threadIds.includes(d.threadId))throw new Error('Task thread scope mismatch');}
            else if(d.expectedWorkRevision!==null)throw new Error('Unexpected task revision');
            memory.focus[d.threadId]={workId:d.workId,revision:d.expectedRevision+1};
            if(d.selectLocal)memory.localThreadId=d.threadId;
            break;
        }
        case 'task.intake_recorded': {
            taskObject(event.data,['receipt']);const r=event.data.receipt;
            taskObject(r,['ownerRecordId','threadId','workId','workRevisionAtIntake','outcome'],['question','goalSourceQuote']);
            identifier(r.ownerRecordId);identifier(r.threadId);
            if(Object.hasOwn(memory.intakes,r.ownerRecordId))throw new Error('Duplicate task intake');
            if(r.workId!==null){const work=activeWork(state,r.workId,r.workRevisionAtIntake!);if(!work.threadIds.includes(r.threadId))throw new Error('Task thread scope mismatch');}
            else if(r.workRevisionAtIntake!==null||r.goalSourceQuote!==undefined)throw new Error('Unexpected intake task');
            if(!['ready','clarify'].includes(r.outcome))throw new Error('Invalid intake outcome');
            if(r.outcome==='clarify')boundedText(r.question,2048);else if(r.question!==undefined)throw new Error('Unexpected intake question');
            if(r.goalSourceQuote!==undefined)boundedText(r.goalSourceQuote,4096);
            memory.intakes[r.ownerRecordId]=structuredClone(r);break;
        }
        case 'task.progress_recorded': {
            const d=event.data;taskObject(d,['workId','expectedWorkRevision','expectedRevision','progress']);
            activeWork(state,d.workId,d.expectedWorkRevision);revision(d.expectedRevision);
            const p=d.progress;taskObject(p,['summary','nextStep','blocker','references','revision','workRevision','ownerRecordId','stopReason']);
            parseProgressReport({summary:p.summary,nextStep:p.nextStep,blocker:p.blocker,references:p.references});
            revision(p.workRevision,1);identifier(p.ownerRecordId);boundedText(p.stopReason,256);
            if((memory.progress[d.workId]?.revision??0)!==d.expectedRevision||p.revision!==d.expectedRevision+1||p.workRevision>d.expectedWorkRevision)throw new Error('Stale progress revision');
            memory.progress[d.workId]=structuredClone(p);break;
        }
    }
}
export function validateTaskSources(state: State, event: TaskContinuityEvent,
    record: (id: string)=>JournalRecord, artifact: (id: string)=>string): void {
    const ownerSource=(id:string,workId?:string|null,threadId?:string)=>{
        identifier(id);const r=record(id);const e=r.event;
        if(r.workspaceId!==state.workspaceId||r.seq>state.version||e.type!=='message.received'||e.data.senderRole!=='owner'||e.data.senderId!==state.ownerId||
            (threadId!==undefined&&e.data.threadId!==threadId)||(workId!=null&&!required(state.works,workId,'Work').threadIds.includes(e.data.threadId)))throw new Error('Invalid task owner source');
        return e.data;
    };
    if(event.type==='task.intake_recorded') {
        const r=event.data.receipt;const source=ownerSource(r.ownerRecordId,r.workId,r.threadId);
        if(r.goalSourceQuote!==undefined){const body=artifact(source.artifactId);const index=body.indexOf(r.goalSourceQuote);if(index<0||body.lastIndexOf(r.goalSourceQuote)!==index)throw new Error('Invalid task goal source quote');}
    } else if(event.type==='task.progress_recorded') {
        const {workId,progress}=event.data;ownerSource(progress.ownerRecordId,workId);
        for(const ref of progress.references) {
            if(ref.kind==='owner_message')ownerSource(ref.id,workId);
            else if(ref.kind==='action') {if(required(state.actions,ref.id,'Action').workId!==workId)throw new Error('Progress action scope mismatch');}
            else if(ref.kind==='browser_observation') {if(!state.browserMemory||required(state.browserMemory.observations,ref.id,'Observation').workId!==workId)throw new Error('Progress observation scope mismatch');}
            else throw new Error('Invalid progress reference');
        }
    }
}
