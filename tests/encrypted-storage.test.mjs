import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, existsSync, rmSync, chmodSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SqliteStore } from '../dist/storage/sqlite-store.js';
import { Operator, buildContext, resolveFact, AgentService, OperationRegistry, OperationService } from '../dist/index.js';
import { validateStorage } from '../dist/storage/sqlite-schema.js';
import { artifactContext, projectionContext, summaryContext, summaryThread } from '../dist/storage/sqlite-codec.js';

const owner = 'synthetic-owner-private-canary-0123456789';
const input = { source: 'synthetic-mailbox-private-canary-0123456789', externalId: 'synthetic-delivery-private-canary-0123456789',
    threadId: 'synthetic-thread-private-canary-0123456789', senderId: owner, senderRole: 'owner', text: 'synthetic-message-private-canary-0123456789' };
function fixture(t) {
    const directory = mkdtempSync(join(tmpdir(), 'behalvo-encrypted-'));
    const path = join(directory, 'store.db');
    const key = randomBytes(32);
    const store = new SqliteStore(path, { encryptionKey: key });
    t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
    store.createWorkspace('personal', owner);
    return { path, key, store };
}

test('message counts preserve absent-workspace zero semantics and workspace/thread scoping in both storage formats', async t => {
    for (const encrypted of [false, true]) await t.test(encrypted ? 'encrypted' : 'plaintext', () => {
        const directory = mkdtempSync(join(tmpdir(), `behalvo-message-count-${encrypted ? 'encrypted' : 'plaintext'}-`));
        const path = join(directory, 'store.db');
        const store = new SqliteStore(path, encrypted ? { encryptionKey: randomBytes(32) } : {});
        try {
            store.createWorkspace('personal', 'personal-owner');
            store.createWorkspace('business', 'business-owner');
            const ingest = (workspaceId, ownerId, externalId, threadId) => store.ingest(workspaceId, {
                source: 'synthetic-mailbox', externalId, threadId, senderId: ownerId,
                senderRole: 'owner', text: `synthetic message ${workspaceId} ${externalId}`
            });
            ingest('personal', 'personal-owner', 'personal-target-1', 'target');
            ingest('personal', 'personal-owner', 'personal-target-2', 'target');
            ingest('personal', 'personal-owner', 'personal-other', 'other');
            ingest('business', 'business-owner', 'business-target', 'target');

            assert.equal(store.messageCount('missing', 'target'), 0);
            assert.equal(store.messageCount('personal', 'absent'), 0);
            assert.equal(store.messageCount('personal', 'target'), 2);
            assert.equal(store.messageCount('business', 'target'), 1);
            assert.equal(store.messageCount('business', 'other'), 0);
        } finally {
            store.close();
            rmSync(directory, { recursive: true, force: true });
        }
    });
});

test('encrypted writes keep all private markers out of the live database and WAL', t => {
    const { path, store } = fixture(t);
    const record = store.ingest('personal', input);
    const summaryText = 'synthetic-summary-private-canary-0123456789';
    const factValue = 'synthetic-fact-private-canary-0123456789';
    store.saveSummary('personal', { threadId: input.threadId, sourceIds: [record.id], text: summaryText });
    store.append('personal', store.state('personal').version, [{ type: 'fact.recorded', data: { fact: {
        id: 'fact', subject: owner, predicate: 'preference', value: factValue,
        validFrom: null, validTo: null, sourceRecordId: record.id
    } } }]);
    assert.equal(store.readArtifact('personal', record.event.data.artifactId), input.text);
    for (const file of [path, `${path}-wal`]) if (existsSync(file)) {
        const bytes = readFileSync(file);
        for (const marker of [...Object.values(input), summaryText, factValue]) {
            if (marker === 'owner') continue;
            assert.equal(bytes.includes(Buffer.from(marker)), false, `Private marker leaked: ${marker}`);
        }
        assert.equal(bytes.includes(Buffer.from(JSON.stringify([record.id]))), false, 'Summary source list leaked');
    }
});

test('encrypted restart requires the exact key and rejects legacy conversion without modification', t => {
    const { path, key, store } = fixture(t);
    const record = store.ingest('personal', input);
    const expected = store.state('personal');
    store.close();
    const before = readFileSync(path);
    assert.throws(() => new SqliteStore(path));
    assert.throws(() => new SqliteStore(path, { encryptionKey: randomBytes(32) }));
    assert.deepEqual(readFileSync(path), before);
    const reopened = new SqliteStore(path, { encryptionKey: key });
    assert.deepEqual(reopened.state('personal'), expected);
    assert.equal(reopened.readArtifact('personal', record.event.data.artifactId), input.text);
    reopened.close();
    const legacyPath = join(path, '..', 'legacy.db');
    new SqliteStore(legacyPath).close();
    chmodSync(legacyPath, 0o600);
    const legacyBefore = readFileSync(legacyPath);
    assert.throws(() => new SqliteStore(legacyPath, { encryptionKey: key }));
    assert.deepEqual(readFileSync(legacyPath), legacyBefore);
});

async function verify(path, key) {
    const module = await import('../dist/storage/sqlite-validation.js').catch(error => {
        if (error.code === 'ERR_MODULE_NOT_FOUND') return {};
        throw error;
    });
    assert.equal(typeof module.verifyEncryptedDatabase, 'function', 'Snapshot validator is missing');
    const db = new DatabaseSync(path, { readOnly: true });
    try { module.verifyEncryptedDatabase(db, validateStorage(db, key)); }
    finally { db.close(); }
}

test('encrypted inbox, thread retrieval, facts, timers and historical replay retain literal behavior', async t => {
    const { path, key, store } = fixture(t);
    const operator = new Operator(store, () => '2026-09-14T12:00:00.000Z');
    operator.createWork('personal', owner, { id: 'work', title: 'Synthetic follow-up', goal: 'Read the outcome', threadId: input.threadId });
    const record = store.ingest('personal', input);
    assert.equal(store.ingest('personal', input).id, record.id);
    assert.throws(() => store.ingest('personal', { ...input, text: 'different' }), /collision/);
    const other = store.ingest('personal', { ...input, source: 'another-source' });
    store.ingest('personal', { ...input, externalId: 'other-thread', threadId: 'other-thread' });
    assert.deepEqual(store.threadMessages('personal', input.threadId, 1).map(record => record.id), [other.id]);
    assert.equal(store.messageCount('personal', input.threadId), 2);
    const summary = store.saveSummary('personal', { threadId: input.threadId, sourceIds: [record.id, other.id], text: 'Synthetic navigation' });
    assert.deepEqual(store.summaries('personal', input.threadId), [summary]);
    assert.deepEqual(store.summaries('personal', 'other-thread'), []);
    assert.throws(() => store.saveSummary('personal', { threadId: 'other-thread', sourceIds: [record.id], text: 'invalid' }), /thread/);
    operator.recordFact('personal', owner, { id: 'fact', subject: owner, predicate: 'drink', value: 'tea', validFrom: null, validTo: null, sourceRecordId: record.id });
    assert.equal(resolveFact(store.state('personal'), owner, 'drink', record.recordedAt).facts[0].value, 'tea');
    assert.equal(store.state('personal').facts.fact.observedAt, record.recordedAt);
    const historical = store.state('personal');
    operator.setWorkPhase('personal', owner, 'work', 'waiting_external');
    assert.equal(store.stateAt('personal', historical.version).works.work.phase, 'open');
    assert.equal(store.state('personal').works.work.phase, 'waiting_external');
    store.append('personal', store.state('personal').version, [{ type: 'timer.scheduled', data: { timer: {
        id: 'timer', workId: 'work', workRevision: store.state('personal').works.work.revision, dueAt: '2026-09-14T12:00:00.000Z', status: 'scheduled'
    } } }]);
    const timer = store.enqueueTimer('personal', store.state('personal').version, 'timer', '2026-09-14T12:01:00.000Z');
    assert.equal(timer.event.type, 'timer.fired');
    assert.equal(store.state('personal').timers.timer.status, 'fired');
    store.completeInbox('personal', timer.id, store.state('personal').version, []);
    store.completeInbox('personal', record.id, store.state('personal').version, []);
    assert.deepEqual(store.inbox('personal').map(record => record.id), [other.id, store.threadMessages('personal', 'other-thread')[0].id]);
    assert.throws(() => store.completeInbox('personal', record.id, store.state('personal').version, []), /handled/);
    store.createWorkspace('business', 'other-owner');
    assert.throws(() => store.readArtifact('business', record.event.data.artifactId), /not found/);
    assert.throws(() => store.record('business', record.id), /not found/);
    assert.throws(() => buildContext(store, { workspaceId: 'personal', ownerId: 'wrong', threadId: input.threadId, windowTokens: 12000, outputReserve: 1000 }), /owner|denied/i);
    const expected = store.state('personal');
    assert.deepEqual(store.rebuild('personal'), expected);
    store.close();
    await verify(path, key);
});

test('read-only encrypted stores reject every write path and never initialize absent or empty files', t => {
    const { path, key, store } = fixture(t);
    const record = store.ingest('personal', input);
    store.close();
    const before = readFileSync(path);
    const reader = new SqliteStore(path, { encryptionKey: key, readOnly: true });
    try {
        assert.equal(reader.readArtifact('personal', record.event.data.artifactId), input.text);
        for (const write of [
            () => reader.createWorkspace('new', owner), () => reader.append('personal', 2, []),
            () => reader.rebuild('personal'), () => reader.bindLocalMode('ordinary'),
            () => reader.putArtifact('personal', 'body'), () => reader.ingest('personal', input),
            () => reader.saveSummary('personal', { threadId: input.threadId, sourceIds: [record.id], text: 'summary' }),
            () => reader.completeInbox('personal', record.id, 2, []),
            () => reader.enqueueTimer('personal', 2, 'timer', '2026-09-14T12:00:00.000Z'),
            () => reader.finishActionAttempt('personal', 'action', 'attempt', 'unknown', 'evidence')
        ]) assert.throws(write, /read.only/i);
    } finally { reader.close(); }
    assert.deepEqual(readFileSync(path), before);
    const absent = join(path, '..', 'absent.db');
    assert.throws(() => new SqliteStore(absent, { encryptionKey: key, readOnly: true }));
    assert.equal(existsSync(absent), false);
    writeFileSync(absent, '', { mode: 0o600 });
    assert.throws(() => new SqliteStore(absent, { encryptionKey: key, readOnly: true }));
    assert.equal(readFileSync(absent).length, 0);
    for (const options of [{ readOnly: 'false' }, { readOnly: 1 }, { encryptionKey: null }, { encryptionKey: new Uint8Array(31) }, null])
        assert.throws(() => new SqliteStore(absent, options));
    assert.equal(readFileSync(absent).length, 0);
});

test('snapshot validation authenticates unused artifacts and checks relational consistency without repairs', async t => {
    const mutations = {
        'missing projection': db => db.exec('DELETE FROM projections'),
        'missing artifact': db => db.exec('DELETE FROM artifacts WHERE rowid=1'),
        'unused corrupt artifact': db => db.exec("UPDATE artifacts SET body='invalid' WHERE rowid=2"),
        'wrong inbox reference': db => db.exec("UPDATE inbox SET record_id=(SELECT id FROM journal WHERE seq=1)"),
        'handled without event': db => db.exec('UPDATE inbox SET handled=1'),
        'missing inbox': db => db.exec('DELETE FROM inbox'),
        'wrong source token': db => db.exec("UPDATE inbox SET source='wrong'"),
        'wrong fingerprint': db => db.exec("UPDATE inbox SET fingerprint='wrong'"),
        'orphan artifact': db => db.exec("UPDATE artifacts SET workspace_id='orphan' WHERE rowid=2"),
        'swapped artifact body': db => db.exec('UPDATE artifacts SET body=(SELECT body FROM artifacts WHERE rowid=1) WHERE rowid=2'),
        'corrupt summary sources': db => db.exec("UPDATE summaries SET source_ids='invalid'"),
        'corrupt unused summary': db => db.exec("UPDATE summaries SET body='invalid'"),
        'wrong summary thread': db => db.exec("UPDATE summaries SET thread_id='wrong'"),
        'wrong projection version': db => db.exec('UPDATE projections SET version=99'),
        'swapped journal events': db => db.exec("DROP TRIGGER journal_no_update; UPDATE journal SET event_json=(SELECT event_json FROM journal WHERE seq=1) WHERE seq=2; CREATE TRIGGER journal_no_update BEFORE UPDATE ON journal BEGIN SELECT RAISE(ABORT,'journal is append-only'); END"),
        'swapped actor fields': db => db.exec("DROP TRIGGER journal_no_update; UPDATE journal SET actor_id=(SELECT actor_id FROM journal WHERE seq=1) WHERE seq=2; CREATE TRIGGER journal_no_update BEFORE UPDATE ON journal BEGIN SELECT RAISE(ABORT,'journal is append-only'); END"),
        'wrong artifact identity': db => db.exec("UPDATE artifacts SET id='changed' WHERE rowid=2")
    };
    for (const [label, mutate] of Object.entries(mutations)) await t.test(label, async t => {
        const { path, key, store } = fixture(t);
        const record = store.ingest('personal', input);
        store.putArtifact('personal', 'unused but authenticated');
        store.saveSummary('personal', { threadId: input.threadId, sourceIds: [record.id], text: 'unused navigation' });
        store.close();
        await verify(path, key);
        const db = new DatabaseSync(path);
        mutate(db);
        db.close();
        const before = readFileSync(path);
        await assert.rejects(verify(path, key), /snapshot|payload|storage/i);
        assert.deepEqual(readFileSync(path), before);
    });
});

test('storage guards reject unsupported schema and metadata before changing the database', async t => {
    const mutations = {
        'missing protection': db => db.exec('DROP TABLE storage_protection'),
        'empty protection': db => db.exec('DELETE FROM storage_protection'),
        'wrong format': db => db.exec('UPDATE storage_protection SET format=2'),
        'wrong database id': db => db.exec("UPDATE storage_protection SET database_id='not-a-uuid'"),
        'wrong verification': db => db.exec("UPDATE storage_protection SET verification='invalid'"),
        'v1 with protection': db => db.exec('PRAGMA user_version=1'),
        'nonempty v0': db => db.exec('PRAGMA user_version=0'),
        'future version': db => db.exec('PRAGMA user_version=3'),
        'missing table': db => db.exec('DROP TABLE summaries'),
        'extra column': db => db.exec('ALTER TABLE artifacts ADD COLUMN extra TEXT'),
        'missing trigger': db => db.exec('DROP TRIGGER journal_no_delete'),
        'replacement trigger': db => db.exec('DROP TRIGGER journal_no_update; CREATE TRIGGER journal_no_update BEFORE UPDATE ON journal BEGIN SELECT 1; END'),
        'extra trigger': db => db.exec('CREATE TRIGGER artifact_rewrite AFTER INSERT ON artifacts BEGIN DELETE FROM artifacts; END'),
        'extra sqlite-like trigger': db => db.exec('CREATE TRIGGER sqliteX_hook AFTER INSERT ON artifacts BEGIN DELETE FROM artifacts; END'),
        'bad local mode shape': db => db.exec('CREATE TABLE local_mode (id INTEGER PRIMARY KEY, mode TEXT)'),
        'bad local mode value': db => db.exec("CREATE TABLE local_mode (id INTEGER PRIMARY KEY CHECK(id=1), mode TEXT NOT NULL); INSERT INTO local_mode VALUES(1,'other')")
    };
    for (const [label, mutate] of Object.entries(mutations)) await t.test(label, t => {
        const { path, key, store } = fixture(t);
        store.close();
        const db = new DatabaseSync(path); mutate(db); db.close();
        const before = readFileSync(path);
        assert.throws(() => new SqliteStore(path, { encryptionKey: key }));
        assert.deepEqual(readFileSync(path), before);
    });
});

test('actual AgentService replies need no separate receipt and all ingested roles retain theirs', async t => {
    const { path, key, store } = fixture(t);
    let calls = 0;
    const service = new AgentService(store, { async complete() {
        calls++;
        return { text: JSON.stringify({ reply: 'Synthetic assistant reply', workProposals: [], factProposals: [] }) };
    } });
    const result = await service.runOwnerTurn({ workspaceId: 'personal', ownerId: owner, threadId: input.threadId,
        externalId: 'agent-turn', text: 'Synthetic owner question', model: { provider: 'fake', model: 'fake' } });
    assert.equal(store.readArtifact('personal', store.record('personal', result.assistantRecordId).event.data.artifactId), 'Synthetic assistant reply');
    assert.equal(store.inbox('personal').length, 0);
    for (const senderRole of ['owner', 'external', 'agent']) {
        store.ingest('personal', { ...input, externalId: `ingested-${senderRole}`, senderRole });
    }
    assert.equal(store.inbox('personal').length, 3);
    store.close();
    await verify(path, key);
    assert.equal(calls, 1);
});

test('encrypted prepared operations preserve approval, execution and unknown barriers across restart', async t => {
    const { path, key, store } = fixture(t);
    const now = '2026-09-14T12:00:00.000Z';
    const operator = new Operator(store, () => now);
    operator.createWork('personal', owner, { id: 'work', title: 'Synthetic profile edit', goal: 'Confirm outcome', threadId: input.threadId });
    const registry = new OperationRegistry();
    let executions = 0;
    let city = 'synthetic-original-city-canary-0123456789';
    let outcome = 'accepted';
    registry.register({ provider: 'synthetic-provider', id: 'profile.update', version: '1',
        validateArguments(value) { assert.equal(typeof value.city, 'string'); return { city: value.city }; },
        async identify({ connection }) { return connection.subject; },
        async observe() { return { source: 'synthetic-api', observedAt: now, state: { city }, providerVersion: city }; },
        prepare({ arguments: args, observation }) { return { arguments: args, affectedResourceIds: [observation.resourceId], expectedResult: args }; },
        comparePrecondition({ expected, actual }) { return expected.providerVersion === actual.providerVersion; },
        async execute({ command }) { executions++; city = command.arguments.city; return { status: outcome, evidence: 'synthetic-operation-evidence-canary-0123456789' }; },
        verify({ command, observation }) { return { status: command.expectedResult.city === observation.state.city ? 'satisfied' : 'not_satisfied' }; }
    });
    const service = new OperationService(store, registry, () => now);
    service.registerConnection({ workspaceId: 'personal', ownerId: owner, connection: {
        id: 'connection', provider: 'synthetic-provider', subject: 'synthetic-private-subject-canary-0123456789', label: 'Synthetic profile'
    } });
    const prepare = (service, key, value) => service.prepare({ workspaceId: 'personal', ownerId: owner, workId: 'work', key,
        connectionId: 'connection', operationId: 'profile.update', operationVersion: '1', resourceId: 'profile', arguments: { city: value } });
    const action = await prepare(service, 'first', 'synthetic-action-arguments-canary-0123456789');
    await assert.rejects(service.execute({ workspaceId: 'personal', ownerId: owner, actionId: action.id }), /approval|approved/i);
    assert.equal(executions, 0);
    const approve = action => service.approveBatch({ workspaceId: 'personal', ownerId: owner, expiresAt: '2026-09-14T13:00:00.000Z', approvals: [{ actionId: action.id, digest: action.digest }] });
    approve(action);
    assert.equal((await service.execute({ workspaceId: 'personal', ownerId: owner, actionId: action.id })).status, 'accepted');
    assert.equal((await service.verify({ workspaceId: 'personal', ownerId: owner, actionId: action.id })).verification.status, 'satisfied');
    assert.equal(store.state('personal').works.work.phase, 'open');
    outcome = 'unknown';
    const unknown = await prepare(service, 'second', 'synthetic-second-city');
    approve(unknown);
    assert.equal((await service.execute({ workspaceId: 'personal', ownerId: owner, actionId: unknown.id })).status, 'unknown');
    assert.equal(executions, 2);
    service.registerConnection({ workspaceId: 'personal', ownerId: owner, connection: {
        id: 'other-connection', provider: 'synthetic-provider', subject: 'other-subject', label: 'Other synthetic profile'
    } });
    const running = await service.prepare({ workspaceId: 'personal', ownerId: owner, workId: 'work', key: 'running',
        connectionId: 'other-connection', operationId: 'profile.update', operationVersion: '1', resourceId: 'profile', arguments: { city: 'future-city' } });
    approve(running);
    store.append('personal', store.state('personal').version, [{ type: 'action.started', data: { id: running.id, attemptId: 'interrupted-attempt' } }]);
    assert.equal(store.state('personal').actions[running.id].status, 'running');
    const expected = store.state('personal');
    assert.deepEqual(store.rebuild('personal'), expected);
    for (const file of [path, `${path}-wal`]) if (existsSync(file)) {
        for (const marker of ['synthetic-action-arguments-canary-0123456789', 'synthetic-operation-evidence-canary-0123456789', 'synthetic-private-subject-canary-0123456789'])
            assert.equal(readFileSync(file).includes(Buffer.from(marker)), false);
    }
    store.close();
    await verify(path, key);
    const restarted = new SqliteStore(path, { encryptionKey: key });
    try {
        assert.deepEqual(restarted.state('personal'), expected);
        const resumed = new OperationService(restarted, registry, () => now);
        assert.equal((await resumed.execute({ workspaceId: 'personal', ownerId: owner, actionId: unknown.id })).status, 'unknown');
        assert.equal((await resumed.execute({ workspaceId: 'personal', ownerId: owner, actionId: running.id })).status, 'running');
        await assert.rejects(prepare(resumed, 'third', 'another-city'), /barrier|unknown|scope/i);
        assert.equal(executions, 2);
    } finally { restarted.close(); }
});

test('encrypted in-memory initialization, private file modes and optional local modes remain supported', async t => {
    const memory = new SqliteStore(':memory:', { encryptionKey: randomBytes(32) });
    memory.createWorkspace('personal', owner);
    const record = memory.ingest('personal', input);
    assert.equal(memory.readArtifact('personal', record.event.data.artifactId), input.text);
    memory.close();
    for (const mode of ['ordinary', 'synthetic']) await t.test(mode, async t => {
        const directory = mkdtempSync(join(tmpdir(), 'behalvo-mode-'));
        t.after(() => rmSync(directory, { recursive: true, force: true }));
        const path = join(directory, 'store.db');
        const key = randomBytes(32);
        const store = new SqliteStore(path, { encryptionKey: key });
        store.bindLocalMode(mode);
        store.createWorkspace('personal', owner);
        store.ingest('personal', input);
        store.createWorkspace('business', owner);
        store.ingest('business', input);
        for (const file of [path, `${path}-wal`, `${path}-shm`]) if (existsSync(file)) assert.equal(statSync(file).mode & 0o777, 0o600);
        const db = new DatabaseSync(path, { readOnly: true });
        const receipts = db.prepare('SELECT source, external_id, fingerprint FROM inbox ORDER BY workspace_id').all();
        assert.notDeepEqual(receipts[0], receipts[1], 'Workspace lookup tokens must differ');
        const plaintextFingerprint = createHash('sha256').update(JSON.stringify([input.source, input.externalId, input.threadId, input.senderId, input.senderRole, input.text])).digest('hex');
        assert.notEqual(receipts[0].fingerprint, plaintextFingerprint);
        db.close();
        store.close();
        await verify(path, key);
        const restarted = new SqliteStore(path, { encryptionKey: key });
        restarted.bindLocalMode(mode);
        restarted.close();
    });
});

test('authenticated but inconsistent snapshot relationships fail validation', async t => {
    const mutations = {
        'projection differs from replay': (db, cipher, record, storeState) => {
            storeState.ownerId = 'changed-owner';
            db.prepare('UPDATE projections SET state_json=?').run(cipher.seal(JSON.stringify(storeState), projectionContext('personal', storeState.version, 1)));
        },
        'summary wrong-thread source': (db, cipher, record) => {
            const row = db.prepare('SELECT * FROM summaries').get();
            const thread = summaryThread('personal', 'wrong-thread', cipher);
            db.prepare('UPDATE summaries SET thread_id=?, source_ids=?, body=?').run(thread,
                cipher.seal(JSON.stringify([record.id]), summaryContext('personal', row.id, thread, row.created_at, 'source_ids')),
                cipher.seal('summary', summaryContext('personal', row.id, thread, row.created_at, 'body')));
        },
        'summary missing source': (db, cipher) => {
            const row = db.prepare('SELECT * FROM summaries').get();
            db.prepare('UPDATE summaries SET source_ids=?').run(cipher.seal('["missing"]', summaryContext('personal', row.id, row.thread_id, row.created_at, 'source_ids')));
        },
        'summary duplicate source': (db, cipher, record) => {
            const row = db.prepare('SELECT * FROM summaries').get();
            db.prepare('UPDATE summaries SET source_ids=?').run(cipher.seal(JSON.stringify([record.id, record.id]), summaryContext('personal', row.id, row.thread_id, row.created_at, 'source_ids')));
        },
        'artifact content no longer matches inbox fingerprint': (db, cipher, record) => {
            db.prepare('UPDATE artifacts SET body=? WHERE id=?').run(cipher.seal('changed delivery body', artifactContext('personal', record.event.data.artifactId)), record.event.data.artifactId);
        },
        'projection without journal': db => {
            db.exec('DROP TRIGGER journal_no_delete; DELETE FROM journal; CREATE TRIGGER journal_no_delete BEFORE DELETE ON journal BEGIN SELECT RAISE(ABORT,\'journal is append-only\'); END');
        }
    };
    for (const [label, mutate] of Object.entries(mutations)) await t.test(label, async t => {
        const { path, key, store } = fixture(t);
        const record = store.ingest('personal', input);
        store.saveSummary('personal', { threadId: input.threadId, sourceIds: [record.id], text: 'summary' });
        const state = store.state('personal');
        store.close();
        const db = new DatabaseSync(path); const cipher = validateStorage(db, key);
        mutate(db, cipher, record, state); db.close();
        const before = readFileSync(path);
        await assert.rejects(verify(path, key), /snapshot/);
        assert.deepEqual(readFileSync(path), before);
    });
});

test('authentication failure during encrypted mutation commits no partial journal, inbox or artifact', t => {
    const { path, store } = fixture(t);
    store.ingest('personal', input);
    const db = new DatabaseSync(path);
    const state = db.prepare('SELECT state_json FROM projections').get().state_json;
    db.exec("UPDATE projections SET state_json='corrupt'");
    const counts = () => ['journal', 'artifacts', 'inbox'].map(table => db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n);
    const before = counts();
    assert.throws(() => store.ingest('personal', { ...input, externalId: 'new-delivery' }), /payload/);
    assert.throws(() => store.append('personal', 2, []), /payload/);
    assert.deepEqual(counts(), before);
    db.prepare('UPDATE projections SET state_json=?').run(state);
    assert.equal(store.state('personal').version, 2);
    db.close();
});

test('malformed UTF-16 ingestion rolls back and a subsequent valid delivery verifies', async t => {
    for (const [name, text] of [['high surrogate', 'synthetic-\uD800'], ['low surrogate', 'synthetic-\uDC00']]) await t.test(name, async t => {
        const { path, key, store } = fixture(t);
        const db = new DatabaseSync(path, { readOnly: true });
        try {
            const before = store.state('personal');
            assert.throws(() => store.ingest('personal', { ...input, text }), { message: 'Unable to seal encrypted payload.' });
            assert.equal(db.prepare('SELECT count(*) AS n FROM journal').get().n, 1);
            assert.equal(db.prepare('SELECT count(*) AS n FROM artifacts').get().n, 0);
            assert.equal(db.prepare('SELECT count(*) AS n FROM inbox').get().n, 0);
            assert.deepEqual(store.state('personal'), before);
            const validText = '\uFEFFsynthetic-你好-\uD83D\uDE80';
            const valid = store.ingest('personal', { ...input, text: validText });
            assert.equal(store.readArtifact('personal', valid.event.data.artifactId), validText);
            assert.equal(store.ingest('personal', { ...input, text: validText }).id, valid.id);
            assert.equal(store.state('personal').version, 2);
        } finally { db.close(); }
        store.close();
        await verify(path, key);
    });
});
