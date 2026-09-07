import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { SqliteStore, Operator, buildContext } from './index.js';
import type { EffectDriver } from './ports.js';
/** Synthetic offline integration demo. It opens no ports and calls no real provider. */
const directory = mkdtempSync(join(tmpdir(), 'personal-operator-demo-'));
const path = join(directory, 'agent.db');
let store = new SqliteStore(path);
let now = '2026-09-07T12:00:00.000Z';
let operator = new Operator(store, () => now);
let fakeProviderCalls = 0;
const driver: EffectDriver = { channel: 'mock-email', execute: async (request) => {
        fakeProviderCalls++;
        return { status: 'accepted', evidence: `Fake provider receipt for ${request.actionId}. No message was sent.` };
    } };
try {
    store.createWorkspace('personal', 'owner');
    operator.createWork('personal', 'owner', { id: 'refund-demo', title: 'Synthetic refund follow-up', goal: 'Owner confirms refund resolution', threadId: 'im' });
    operator.linkThread('personal', 'owner', 'refund-demo', 'web');
    operator.linkThread('personal', 'owner', 'refund-demo', 'email');
    const originals = [];
    for (let i = 0; i < 8; i++)
        originals.push(store.ingest('personal', {
            source: 'mock:im', externalId: `history-${i}`, threadId: 'im', senderId: 'owner', senderRole: 'owner',
            text: `Synthetic history ${i}: ` + 'Earlier correspondence; retained verbatim. '.repeat(100)
        }));
    store.saveSummary('personal', { threadId: 'im', sourceIds: originals.map(r => r.id), text: 'A synthetic refund case remains open; old correspondence is available by source ID.' });
    store.ingest('personal', { source: 'mock:im', externalId: 'current-request', threadId: 'im', senderId: 'owner', senderRole: 'owner', text: 'Please follow up with the vendor.' });
    const a = operator.propose('personal', { workId: 'refund-demo', key: 'initial-followup', command: { kind: 'message.send', channel: 'mock-email', to: 'vendor@example.test', body: 'Please confirm the status of this synthetic refund.' } });
    operator.approve('personal', 'owner', a.id, a.digest, '2026-09-07T13:00:00.000Z');
    await operator.runEffect('personal', a.id, driver);
    await operator.runEffect('personal', a.id, driver);
    const interrupted = operator.propose('personal', { workId: 'refund-demo', key: 'interrupted-example', command: { kind: 'message.send', channel: 'mock-email', to: 'vendor@example.test', body: 'This attempt is interrupted before calling the fake provider.' } });
    operator.approve('personal', 'owner', interrupted.id, interrupted.digest, '2026-09-07T13:00:00.000Z');
    operator.startEffect('personal', interrupted.id, 'mock-email');
    operator.schedule('personal', 'owner', { id: 'follow-up-timer', workId: 'refund-demo', dueAt: '2026-09-08T12:00:00.000Z' });
    store.close();
    now = '2026-09-09T12:00:00.000Z';
    store = new SqliteStore(path);
    operator = new Operator(store, () => now);
    const recoveredUnknownActions = operator.recoverInterrupted('personal', true);
    const dueTimersFired = operator.fireDue('personal');
    const secondPollFired = operator.fireDue('personal');
    store.ingest('personal', { source: 'mock:web', externalId: 'web-question', threadId: 'web', senderId: 'owner', senderRole: 'owner', text: 'What is the status of the same refund?' });
    const webContext = buildContext(store, { workspaceId: 'personal', ownerId: 'owner', threadId: 'web', workId: 'refund-demo', windowTokens: 6000, outputReserve: 1000, at: now });
    const compacted = buildContext(store, { workspaceId: 'personal', ownerId: 'owner', threadId: 'im', workId: 'refund-demo', windowTokens: 4500, outputReserve: 1000, at: now });
    const original = originals[0]!;
    if (original.event.type !== 'message.received')
        throw new Error('Unexpected demonstration record');
    const rawHistoryRetained = store.readArtifact('personal', original.event.data.artifactId).startsWith('Synthetic history 0:');
    const before = store.state('personal');
    store.rebuild('personal');
    console.log(JSON.stringify({
        mode: 'offline-fake-provider', realMessagesSent: 0, fakeProviderCalls,
        crossThreadWorkId: webContext.work?.id, workStatus: webContext.work?.phase,
        recoveredUnknownActions, dueTimersFired, secondPollFired, rawHistoryRetained,
        rawMessagesOmittedFromContext: compacted.omittedMessageCount,
        sourceLinkedSummariesLoaded: compacted.includedSummaryIds.length,
        contextEstimatedTokens: compacted.estimatedTokens,
        replayMatches: isDeepStrictEqual(before, store.state('personal')),
        journalRecords: store.journal('personal').length
    }, null, 2));
}
finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
}
