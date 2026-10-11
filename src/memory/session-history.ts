import type { JournalRecord, State } from '../kernel/types.js';
import { identifier } from '../kernel/types.js';
import { assertOwner } from '../kernel/policy.js';
import { exact, text } from '../kernel/browser-contract.js';
import type { SqliteStore } from '../storage/sqlite-store.js';

export interface HistoryBinding {
    workspaceId: string;
    ownerId: string;
    threadId: string;
    workId?: string;
    audience?: 'owner' | 'external';
}
export interface HistoryScope { threadId: string; workId?: string; scope: 'thread' | 'work' }

/** Attribution is evidence, never inferred from temporal proximity or the latest focus. */
export function messageInScope(state: State, record: JournalRecord, scope: HistoryScope): boolean {
    if (record.workspaceId !== state.workspaceId || record.event.type !== 'message.received') return false;
    const message = record.event.data;
    if (scope.scope === 'thread' && message.threadId !== scope.threadId) return false;
    if (scope.workId && !state.works[scope.workId]?.threadIds.includes(message.threadId)) return false;
    const source = message.senderRole === 'owner' && message.senderId === state.ownerId ? record.id :
        message.senderRole === 'agent' ? record.causationId : null;
    const receipt = source ? state.taskContinuity?.intakes[source] : undefined;
    return !!receipt && receipt.threadId === message.threadId && receipt.workId === (scope.workId ?? null);
}

function checkBinding(store: SqliteStore, binding: HistoryBinding): State {
    const state = store.state(binding.workspaceId);
    assertOwner(state, binding.ownerId);
    if (binding.audience && binding.audience !== 'owner') throw new Error('External history audience denied');
    identifier(binding.threadId);
    if (binding.workId && !state.works[binding.workId]?.threadIds.includes(binding.threadId))
        throw new Error('History task must be linked to this thread');
    return state;
}

export interface RecallRecord {
    recordId: string; threadId: string; seq: number; senderRole: string; recordedAt: string; text: string;
}
export interface RecallResult { records: RecallRecord[]; nextBeforeSeq: number | null }
export function recallHistory(store: SqliteStore, binding: HistoryBinding, raw: unknown): RecallResult {
    const state = checkBinding(store, binding);
    const args = exact(raw, ['query', 'scope', 'limit', 'beforeSeq']);
    text(args.query, 256);
    if (args.scope !== 'thread' && args.scope !== 'work') throw new Error('Invalid recall scope');
    if (!Number.isSafeInteger(args.limit) || (args.limit as number) < 1 || (args.limit as number) > 20 ||
        args.beforeSeq !== null && (!Number.isSafeInteger(args.beforeSeq) || (args.beforeSeq as number) < 1))
        throw new Error('Invalid recall page');
    if (args.scope === 'work' && !binding.workId) throw new Error('Focus work before task recall');
    const scope: HistoryScope = { ...binding, scope: args.scope };
    const literal = new RegExp(args.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'iu');
    const result: RecallResult = { records: [], nextBeforeSeq: null };
    for (const record of store.journal(binding.workspaceId).reverse()) {
        if (args.beforeSeq !== null && record.seq >= (args.beforeSeq as number) || !messageInScope(state, record, scope)) continue;
        if (record.event.type !== 'message.received') continue;
        const body = store.readArtifact(binding.workspaceId, record.event.data.artifactId);
        const match = literal.exec(body);
        if (!match) continue;
        if (result.records.length >= (args.limit as number)) {
            result.nextBeforeSeq = result.records.at(-1)!.seq;
            break;
        }
        // Character boundaries preserve Unicode; keep the actual match even in a long message.
        const prefix = Array.from(body.slice(0, match.index));
        const suffix = Array.from(body.slice(match.index + match[0].length));
        const excerpt = (prefix.length > 160 ? '…' : '') + prefix.slice(-160).join('') + match[0] +
            suffix.slice(0, 160).join('') + (suffix.length > 160 ? '…' : '');
        result.records.push({ recordId: record.id, threadId: record.event.data.threadId, seq: record.seq,
            senderRole: record.event.data.senderRole, recordedAt: record.recordedAt, text: excerpt });
        result.nextBeforeSeq = record.seq;
        if (Buffer.byteLength(JSON.stringify(result), 'utf8') > 16384) {
            result.records.pop();
            result.nextBeforeSeq = result.records.at(-1)?.seq ?? null;
            break;
        }
        result.nextBeforeSeq = null;
    }
    return result;
}

export interface SessionView { threadId: string; updatedAt: string | null; preview: string; workId?: string }
export function listSessions(store: SqliteStore, workspaceId: string, ownerId: string): SessionView[] {
    const state = store.state(workspaceId); assertOwner(state, ownerId);
    const sessions = new Map<string, SessionView>();
    for (const threadId of Object.keys(state.taskContinuity?.focus ?? {}))
        sessions.set(threadId, { threadId, updatedAt: null, preview: '' });
    for (const record of store.journal(workspaceId)) {
        if (record.event.type !== 'message.received') continue;
        const data = record.event.data;
        const session = sessions.get(data.threadId) ?? { threadId: data.threadId, updatedAt: null, preview: '' };
        session.updatedAt = record.recordedAt;
        if (data.senderRole === 'owner' && data.senderId === ownerId)
            session.preview = Array.from(store.readArtifact(workspaceId, data.artifactId)).slice(0, 160).join('');
        sessions.set(data.threadId, session);
    }
    for (const session of sessions.values()) {
        const id = state.taskContinuity?.focus[session.threadId]?.workId;
        if (id && !['done', 'cancelled'].includes(state.works[id]!.phase)) session.workId = id;
    }
    return [...sessions.values()].sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '') || a.threadId.localeCompare(b.threadId));
}
