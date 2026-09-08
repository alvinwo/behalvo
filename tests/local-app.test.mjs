import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { api } from './helpers.mjs';

test('openLocalAgent creates the personal workspace once and reopens the same durable state', async t => {
  const { FakeModelGateway, openLocalAgent } = await api();
  const dir = await mkdtemp(join(tmpdir(), 'behalvo-app-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const dbPath = join(dir, 'agent.db');
  const gateway = new FakeModelGateway([{ provider: 'fake', model: 'one' }], () => ({ text: '{"reply":"ok","workProposals":[],"factProposals":[]}' }));

  const first = openLocalAgent({ dbPath, workspaceId: 'personal', ownerId: 'owner', gateways: [gateway] });
  assert.equal(first.store.state('personal').ownerId, 'owner');
  first.operator.createWork('personal', 'owner', { id: 'persisted', title: 'Persist me', goal: 'survive restart', threadId: 'im' });
  first.close();

  const second = openLocalAgent({ dbPath, workspaceId: 'personal', ownerId: 'owner', gateways: [gateway] });
  assert.equal(second.store.state('personal').works.persisted.title, 'Persist me');
  assert.throws(() => openLocalAgent({ dbPath, workspaceId: 'personal', ownerId: 'different-owner', gateways: [gateway] }), /owner|workspace/i);
  second.close();
});
