import type { DatabaseSync } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';
import { emptyState, reduce } from '../kernel/reducer.js';
import type { JournalRecord } from '../kernel/types.js';
import { identifier, instant, nonempty } from '../kernel/types.js';
import type { PayloadCipher } from './payload-cipher.js';
import { artifactContext, decodeProjection, decodeRecord, decodeSummary, messageTokens, open, summaryThread, timerTokens } from './sqlite-codec.js';
import { validateEncryptedSchema } from './sqlite-schema.js';

function requireValid(condition: unknown): asserts condition {
    if (!condition) throw new Error('Invalid encrypted database snapshot.');
}

/** Validate a stable, read-only snapshot. No repair, model, effect, or domain writes. */
export function verifyEncryptedDatabase(db: DatabaseSync, cipher: PayloadCipher): void {
    try {
        requireValid(db.prepare('PRAGMA user_version').get()!.user_version === 2);
        validateEncryptedSchema(db);
        const protection = db.prepare('SELECT * FROM storage_protection').all();
        requireValid(protection.length === 1 && protection[0]!.id === 1 && protection[0]!.format === 1);
        requireValid(cipher.open(String(protection[0]!.verification), ['metadata', 'verification']) === 'behalvo/storage/v1/verified');
        const integrity = db.prepare('PRAGMA integrity_check').all();
        requireValid(integrity.length === 1 && integrity[0]!.integrity_check === 'ok');
        requireValid(db.prepare('PRAGMA foreign_key_check').all().length === 0);

        // The union catches orphan workspaces even if their journal/projection was removed.
        const workspaces = db.prepare(`SELECT workspace_id FROM journal UNION SELECT workspace_id FROM projections
            UNION SELECT workspace_id FROM artifacts UNION SELECT workspace_id FROM inbox UNION SELECT workspace_id FROM summaries`).all();
        for (const workspace of workspaces) {
            const workspaceId = workspace.workspace_id;
            identifier(workspaceId, 'workspaceId');
            const records = db.prepare('SELECT * FROM journal WHERE workspace_id=? ORDER BY seq').all(workspaceId).map(row => decodeRecord(row, cipher));
            const projections = db.prepare('SELECT * FROM projections WHERE workspace_id=?').all(workspaceId);
            requireValid(records.length > 0 && records[0]!.event.type === 'workspace.created' && projections.length === 1);
            const artifacts = new Map<string, string>();
            for (const row of db.prepare('SELECT * FROM artifacts WHERE workspace_id=?').all(workspaceId)) {
                identifier(row.id, 'artifactId');
                const body = open(row.body, artifactContext(workspaceId, row.id), cipher);
                nonempty(body, 'artifact');
                requireValid(Buffer.byteLength(body, 'utf8') <= 262144);
                artifacts.set(row.id, body);
            }
            const requireArtifact = (id: string): string => {
                const body = artifacts.get(id);
                requireValid(body !== undefined);
                return body;
            };
            const prior = new Map<string, JournalRecord>();
            const handled = new Set<string>();
            let state = emptyState(workspaceId);
            for (const record of records) {
                identifier(record.id, 'recordId');
                instant(record.recordedAt);
                requireValid(Number.isSafeInteger(record.seq) && record.workspaceId === workspaceId);
                if (record.causationId !== null) requireValid(prior.has(record.causationId));
                const event = record.event;
                let observedAt: string | undefined;
                if (event.type === 'fact.recorded') {
                    const source = prior.get(event.data.fact.sourceRecordId);
                    requireValid(source);
                    observedAt = source.recordedAt;
                }
                if (event.type === 'message.received') requireArtifact(event.data.artifactId);
                if (event.type === 'work.phase_changed' && event.data.evidenceRef !== undefined) requireArtifact(event.data.evidenceRef);
                if (event.type === 'action.finished' || event.type === 'action.reconciled') requireArtifact(event.data.evidenceRef);
                if (event.type === 'action.verification_recorded' && event.data.verification.status === 'owner_attested')
                    requireArtifact(event.data.verification.evidenceRef);
                if (event.type === 'inbox.handled') {
                    const source = prior.get(event.data.recordId);
                    requireValid(source && (source.event.type === 'message.received' || source.event.type === 'timer.fired'));
                    requireValid(record.causationId === source.id && !handled.has(source.id));
                    handled.add(source.id);
                }
                state = reduce(state, event, record.seq, observedAt);
                prior.set(record.id, record);
            }
            const projection = projections[0]!;
            requireValid(projection.version === state.version && isDeepStrictEqual(decodeProjection(projection, cipher), state));

            const receipts = new Set<string>();
            for (const row of db.prepare('SELECT * FROM inbox WHERE workspace_id=?').all(workspaceId)) {
                const source = prior.get(String(row.record_id));
                requireValid(source && !receipts.has(source.id));
                const event = source.event;
                requireValid(event.type === 'message.received' || event.type === 'timer.fired');
                const tokens = event.type === 'message.received'
                    ? messageTokens(workspaceId, { ...event.data, text: requireArtifact(event.data.artifactId) }, cipher)
                    : timerTokens(workspaceId, event.data.id, cipher);
                requireValid(row.source === tokens.source && row.external_id === tokens.externalId && row.fingerprint === tokens.fingerprint);
                requireValid(row.handled === (handled.has(source.id) ? 1 : 0));
                receipts.add(source.id);
            }
            for (const record of records) {
                const event = record.event;
                // AgentService appends its reply inside completeInbox, without a new delivery receipt.
                const assistantReply = event.type === 'message.received' && event.data.senderRole === 'agent' &&
                    ['agent:model', 'agent:application'].includes(event.data.source) && record.causationId !== null && handled.has(record.causationId);
                if (event.type === 'timer.fired' || (event.type === 'message.received' && !assistantReply) || handled.has(record.id))
                    requireValid(receipts.has(record.id));
            }

            for (const row of db.prepare('SELECT * FROM summaries WHERE workspace_id=?').all(workspaceId)) {
                // The actual thread is recovered from authenticated message provenance, never a guessed token.
                const summary = decodeSummary(row, '', cipher);
                identifier(summary.id, 'summaryId');
                instant(summary.createdAt);
                nonempty(summary.text, 'summary');
                requireValid(Buffer.byteLength(summary.text, 'utf8') <= 65536 && Array.isArray(summary.sourceIds) &&
                    summary.sourceIds.length > 0 && summary.sourceIds.length <= 1000 && new Set(summary.sourceIds).size === summary.sourceIds.length);
                let threadId: string | undefined;
                for (const id of summary.sourceIds) {
                    requireValid(typeof id === 'string');
                    const source = prior.get(id);
                    requireValid(source && source.event.type === 'message.received');
                    threadId ??= source.event.data.threadId;
                    requireValid(source.event.data.threadId === threadId);
                }
                requireValid(row.thread_id === summaryThread(workspaceId, threadId!, cipher));
            }
        }
    } catch {
        // Database/parser/reducer errors can contain private payloads. Never expose those through validation.
        throw new Error('Invalid encrypted database snapshot.');
    }
}
