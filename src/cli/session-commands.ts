import { randomUUID } from 'node:crypto';
import { assertOwner } from '../kernel/policy.js';
import { identifier } from '../kernel/types.js';
import { listSessions, recallHistory, type HistoryBinding } from '../memory/session-history.js';
import { memoryMessage, sessionSelected } from '../memory/messages.js';
import { selectTaskThread } from '../runtime/task-continuity.js';
import type { SqliteStore } from '../storage/sqlite-store.js';

interface Selection { threadId: string; workId?: string }
export function handleSessionCommand(store: SqliteStore, binding: HistoryBinding, line: string,
    continuity: boolean, write: (text: string) => void): Selection | undefined {
    const [command, ...args] = line.split(/\s+/);
    if (!['/sessions','/resume','/new','/history','/journal','/memory','/recall'].includes(command!)) return undefined;
    const state = store.state(binding.workspaceId); assertOwner(state, binding.ownerId);
    const current: Selection = { threadId: binding.threadId, ...(binding.workId ? { workId: binding.workId } : {}) };
    const display = (value: unknown) => {
        const rendered = JSON.stringify(value, null, 2);
        // JSON escapes terminal controls; bound output even for long historical artifacts.
        write(rendered.length > 16000 ? rendered.slice(0,16000)+'\n'+memoryMessage('truncated') : rendered);
    };
    if (command === '/new' || command === '/resume') {
        if (args.length > 1 || command === '/resume' && args.length !== 1)
            throw new Error(memoryMessage(command === '/new' ? 'newUsage' : 'resumeUsage'));
        const threadId = args[0] ?? `local-${randomUUID()}`; identifier(threadId);
        const session = listSessions(store,binding.workspaceId,binding.ownerId).find(s=>s.threadId===threadId);
        if (command === '/new' && (session || threadId === binding.threadId)) throw new Error(memoryMessage('exists'));
        if (command === '/resume' && !session) throw new Error(memoryMessage('missing'));
        const workId = command === '/resume' ? session?.workId : undefined;
        if (continuity) selectTaskThread(store,binding.workspaceId,binding.ownerId,threadId,workId??null,true);
        write(sessionSelected(threadId,command==='/new'));
        return {threadId,...(workId?{workId}:{})};
    }
    if (command === '/history' || command === '/journal') {
        const limit=args[0]===undefined?20:Number(args[0]);
        if(args.length>1||!Number.isSafeInteger(limit)||limit<1||limit>200)throw new Error(memoryMessage('historyUsage'));
        if(command==='/journal') for(const r of store.journal(binding.workspaceId).slice(-limit))
            write(`${r.seq} ${r.recordedAt} ${r.event.type} ${r.id}`);
        else for(const r of store.threadMessages(binding.workspaceId,binding.threadId,limit))
            if(r.event.type==='message.received')display({recordId:r.id,seq:r.seq,role:r.event.data.senderRole,text:store.readArtifact(binding.workspaceId,r.event.data.artifactId)});
        return current;
    }
    if(command==='/recall') {
        const query=line.slice(command.length).trim();if(!query)throw new Error(memoryMessage('recallUsage'));
        const result=recallHistory(store,binding,{query,scope:binding.workId?'work':'thread',limit:10,beforeSeq:null});
        write(memoryMessage(result.records.length?'recalled':'none'));display(result);return current;
    }
    if(args.length)throw new Error(memoryMessage('noArguments'));
    if(command==='/sessions') {display(listSessions(store,binding.workspaceId,binding.ownerId).slice(0,100));return current;}
    const workId=binding.workId;
    write(memoryMessage('memory'));
    display({facts:Object.values(state.facts).filter(f=>f.subject===state.ownerId||workId&&f.subject===workId),
        teachings:Object.values(state.teachingMemory?.teachings??{}).filter(t=>t.workId===workId&&t.status==='active'),
        clarifications:Object.values(state.teachingMemory?.clarifications??{}).filter(t=>t.workId===workId&&t.status==='open'),
        progress:workId?state.taskContinuity?.progress[workId]??null:null,
        browserNotes:Object.values(state.browserMemory?.notes??{}).filter(n=>n.workId===workId&&n.status==='candidate')});
    return current;
}
