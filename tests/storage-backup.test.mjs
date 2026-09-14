import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Operator, SqliteStore } from '../dist/index.js';

const POSIX = process.platform !== 'win32';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'behalvo-backup-'));
  chmodSync(directory, 0o700);
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, key: randomBytes(32) };
}

function populate(store) {
  const owner = 'synthetic-owner';
  const workspace = 'personal';
  store.createWorkspace(workspace, owner);
  const message = store.ingest(workspace, {
    source: 'synthetic-mailbox', externalId: 'synthetic-delivery', threadId: 'synthetic-thread',
    senderId: owner, senderRole: 'owner', text: 'synthetic encrypted backup payload'
  });
  store.saveSummary(workspace, { threadId: 'synthetic-thread', sourceIds: [message.id], text: 'synthetic backup summary' });
  const operator = new Operator(store, () => '2026-09-14T12:00:00.000Z');
  operator.createWork(workspace, owner, { id: 'work', title: 'Synthetic work', goal: 'Preserve barriers', threadId: 'synthetic-thread' });
  const unknown = operator.propose(workspace, { workId: 'work', key: 'unknown', command: { kind: 'message.send', channel: 'mock-email', to: 'nobody@example.test', body: 'Unknown' } });
  operator.approve(workspace, owner, unknown.id, unknown.digest, '2026-09-14T13:00:00.000Z');
  const running = operator.propose(workspace, { workId: 'work', key: 'running', command: { kind: 'message.send', channel: 'mock-email', to: 'nobody@example.test', body: 'Running' } });
  operator.approve(workspace, owner, running.id, running.digest, '2026-09-14T13:00:00.000Z');
  return { workspace, message, unknown, running, operator };
}

test('encrypted backup includes live WAL state and can be restored with a separately loaded key copy', { skip: !POSIX }, async t => {
  const { directory, key } = await fixture(t);
  const sourcePath = join(directory, 'source.db');
  const backupPath = join(directory, 'backup.db');
  const restoredPath = join(directory, 'restored.db');
  const store = new SqliteStore(sourcePath, { encryptionKey: key });
  const { workspace, message, unknown, running, operator } = populate(store);
  let effectCalls = 0;
  await operator.runEffect(workspace, unknown.id, { channel: 'mock-email', async execute() {
    effectCalls++;
    return { status: 'unknown', evidence: 'synthetic unknown evidence' };
  } });
  operator.startEffect(workspace, running.id, 'mock-email');
  const expectedState = store.state(workspace);
  const expectedJournal = store.journal(workspace);
  const expectedArtifact = store.readArtifact(workspace, message.event.data.artifactId);
  const priorEffectCalls = effectCalls;
  assert.equal(existsSync(`${sourcePath}-wal`), true);

  await store.backup(backupPath);
  assert.equal(existsSync(`${backupPath}-wal`), false);
  assert.equal(existsSync(`${backupPath}-shm`), false);
  store.close();
  const recoveredKey = Uint8Array.from(key);
  const snapshot = new SqliteStore(backupPath, { encryptionKey: recoveredKey, readOnly: true });
  await snapshot.backup(restoredPath);
  snapshot.close();
  assert.equal(existsSync(`${restoredPath}-wal`), false);
  assert.equal(existsSync(`${restoredPath}-shm`), false);
  const restored = new SqliteStore(restoredPath, { encryptionKey: recoveredKey });
  try {
    assert.deepEqual(restored.state(workspace), expectedState);
    assert.deepEqual(restored.journal(workspace), expectedJournal);
    assert.equal(restored.readArtifact(workspace, message.event.data.artifactId), expectedArtifact);
    assert.equal(restored.state(workspace).actions[unknown.id].status, 'unknown');
    assert.equal(restored.state(workspace).actions[running.id].status, 'running');
    assert.equal(effectCalls, priorEffectCalls);
  } finally { restored.close(); }
});

test('backup refuses plaintext stores and preserves existing destinations and sidecars', { skip: !POSIX }, async t => {
  const { directory, key } = await fixture(t);
  const plaintext = new SqliteStore(join(directory, 'plain.db'));
  plaintext.createWorkspace('personal', 'owner');
  await assert.rejects(() => plaintext.backup(join(directory, 'plain-backup.db')), /encrypted/i);
  plaintext.close();

  const source = new SqliteStore(join(directory, 'source.db'), { encryptionKey: key });
  populate(source);
  const sourceBefore = readFileSync(join(directory, 'source.db'));
  await assert.rejects(() => source.backup(join(directory, 'source.db')));
  assert.deepEqual(readFileSync(join(directory, 'source.db')), sourceBefore);
  const collision = join(directory, 'collision.db');
  writeFileSync(collision, 'existing', { mode: 0o600 });
  await assert.rejects(() => source.backup(collision));
  assert.equal(readFileSync(collision, 'utf8'), 'existing');
  const stale = join(directory, 'stale.db');
  writeFileSync(`${stale}-wal`, 'stale wal', { mode: 0o600 });
  await assert.rejects(() => source.backup(stale));
  assert.equal(existsSync(stale), false);
  assert.equal(readFileSync(`${stale}-wal`, 'utf8'), 'stale wal');
  const target = join(directory, 'target.db');
  writeFileSync(target, 'target', { mode: 0o600 });
  const linked = join(directory, 'linked.db');
  symlinkSync(target, linked);
  await assert.rejects(() => source.backup(linked));
  assert.equal(readFileSync(target, 'utf8'), 'target');
  source.close();

  chmodSync(join(directory, 'source.db'), 0o644);
  assert.throws(() => new SqliteStore(join(directory, 'source.db'), { encryptionKey: key, readOnly: true }));
});

test('backup validates the complete snapshot and leaves source and output unchanged on corruption', { skip: !POSIX }, async t => {
  const { directory, key } = await fixture(t);
  for (const [label, mutate] of [
    ['ciphertext', db => db.exec("UPDATE artifacts SET body='corrupt' WHERE rowid=1")],
    ['relational metadata', db => db.exec('DELETE FROM projections')]
  ]) await t.test(label, async () => {
    const sourcePath = join(directory, `${label.replaceAll(' ', '-')}.db`);
    const outputPath = join(directory, `${label.replaceAll(' ', '-')}-backup.db`);
    const writer = new SqliteStore(sourcePath, { encryptionKey: key });
    populate(writer);
    writer.close();
    const db = new DatabaseSync(sourcePath);
    mutate(db);
    db.close();
    chmodSync(sourcePath, 0o600);
    const before = readFileSync(sourcePath);
    const source = new SqliteStore(sourcePath, { encryptionKey: key, readOnly: true });
    await assert.rejects(() => source.backup(outputPath));
    source.close();
    assert.deepEqual(readFileSync(sourcePath), before);
    assert.equal(existsSync(outputPath), false);
  });
});
