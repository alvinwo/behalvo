import type { JournalRecord, State } from './types.js';
import { identifier, required } from './types.js';

export interface TeachingSource {
    sourceRecordId: string; sourceQuote: string; sourceStart: number; sourceEnd: number;
}
export interface OwnerTeaching extends TeachingSource {
    id: string; workId: string; revision: number; interpretation: string;
    status: 'active' | 'superseded' | 'retracted'; supersedes?: string;
    retractionSource?: TeachingSource;
}
export interface TeachingClarification extends TeachingSource {
    id: string; workId: string; status: 'open' | 'resolved'; question: string;
    resolutionSource?: TeachingSource;
}
export interface TeachingMemory {
    teachings: Record<string, OwnerTeaching>; clarifications: Record<string, TeachingClarification>;
}
export type TeachingEvent =
    | { type: 'teaching.recorded'; data: { teaching: OwnerTeaching; expectedWorkRevision: number; expectedRevision?: number } }
    | { type: 'teaching.retracted'; data: { id: string; workId: string; expectedRevision: number; expectedWorkRevision: number; source: TeachingSource } }
    | { type: 'teaching.clarification_opened'; data: { clarification: TeachingClarification; expectedWorkRevision: number } }
    | { type: 'teaching.clarification_resolved'; data: { id: string; workId: string; expectedWorkRevision: number; source: TeachingSource } };

export function boundedText(value: unknown, maximum: number): asserts value is string {
    if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value, 'utf8') > maximum) throw new Error('Invalid teaching text');
}
export function teachingSource(value: TeachingSource): void {
    identifier(value.sourceRecordId); boundedText(value.sourceQuote, 4096);
    if (!Number.isSafeInteger(value.sourceStart) || value.sourceStart < 0 ||
        !Number.isSafeInteger(value.sourceEnd) || value.sourceEnd !== value.sourceStart + value.sourceQuote.length)
        throw new Error('Invalid teaching source span');
}
export function teachingHold(state: State, workId: string): boolean {
    return Object.values(state.teachingMemory?.clarifications ?? {}).some(x => x.workId === workId && x.status === 'open');
}
export function assertTeachingClear(state: State, workId: string): void {
    if (teachingHold(state, workId)) throw new Error('Task clarification is required before action');
}
export function teachingEventScope(event: TeachingEvent): { workId: string; source: TeachingSource } {
    if (event.type === 'teaching.recorded') return { workId: event.data.teaching.workId, source: event.data.teaching };
    if (event.type === 'teaching.clarification_opened') return { workId: event.data.clarification.workId, source: event.data.clarification };
    return { workId: event.data.workId, source: event.data.source };
}
export function validateTeachingSource(state: State, event: TeachingEvent,
    record: (id: string) => JournalRecord, artifact: (id: string) => string): void {
    const {workId, source} = teachingEventScope(event); teachingSource(source);
    const owner = record(source.sourceRecordId); const message = owner.event;
    if (owner.workspaceId !== state.workspaceId || owner.seq > state.version || message.type !== 'message.received' ||
        message.data.senderRole !== 'owner' || message.data.senderId !== state.ownerId ||
        !required(state.works, workId, 'Work').threadIds.includes(message.data.threadId))
        throw new Error('Invalid teaching owner source');
    const body = artifact(message.data.artifactId);
    if (body.slice(source.sourceStart, source.sourceEnd) !== source.sourceQuote ||
        body.indexOf(source.sourceQuote) !== source.sourceStart || body.lastIndexOf(source.sourceQuote) !== source.sourceStart)
        throw new Error('Teaching source is not a unique exact quote');
}
export function reduceTeaching(state: State, event: TeachingEvent): void {
    const memory = state.teachingMemory;
    if (!memory) throw new Error('Task teachings require projection upgrade');
    const {workId, source} = teachingEventScope(event); teachingSource(source);
    const work = required(state.works, workId, 'Work');
    if (['done','cancelled'].includes(work.phase) || work.revision !== event.data.expectedWorkRevision) throw new Error('Stale teaching work');
    switch (event.type) {
        case 'teaching.recorded': {
            const value = event.data.teaching; identifier(value.id); boundedText(value.interpretation, 2048);
            if (value.revision !== 1 || value.status !== 'active' || value.retractionSource || Object.hasOwn(memory.teachings,value.id)) throw new Error('Invalid new teaching');
            if (value.supersedes) {
                const old = required(memory.teachings,value.supersedes,'Teaching');
                if (old.workId !== workId || old.status !== 'active' || old.revision !== event.data.expectedRevision) throw new Error('Stale teaching target');
                old.status = 'superseded'; old.revision++;
            } else if (event.data.expectedRevision !== undefined) throw new Error('Unexpected teaching revision');
            memory.teachings[value.id] = structuredClone(value); break;
        }
        case 'teaching.retracted': {
            const old = required(memory.teachings,event.data.id,'Teaching');
            if (old.workId !== workId || old.status !== 'active' || old.revision !== event.data.expectedRevision) throw new Error('Stale teaching target');
            old.status = 'retracted'; old.revision++; old.retractionSource = structuredClone(source); break;
        }
        case 'teaching.clarification_opened': {
            const value = event.data.clarification; identifier(value.id); boundedText(value.question,2048);
            if (value.status !== 'open' || value.resolutionSource || Object.hasOwn(memory.clarifications,value.id)) throw new Error('Invalid clarification');
            memory.clarifications[value.id] = structuredClone(value); break;
        }
        case 'teaching.clarification_resolved': {
            const value = required(memory.clarifications,event.data.id,'Clarification');
            if (value.workId !== workId || value.status !== 'open') throw new Error('Invalid clarification resolution');
            value.status = 'resolved'; value.resolutionSource = structuredClone(source); break;
        }
    }
    work.revision++;
}
