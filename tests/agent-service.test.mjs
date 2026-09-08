import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.mjs';

class ScriptedGateway {
  constructor(responses) { this.responses = [...responses]; this.requests = []; }
  async listModels() { return [{ provider: 'fake', model: 'fake-1' }]; }
  async complete(request) {
    this.requests.push(structuredClone(request));
    const text = this.responses.shift();
    if (!text) throw new Error('No scripted response');
    return { text };
  }
}

const model = { provider: 'fake', model: 'fake-1' };

test('AgentService persists owner/model turns and recovers work and facts after restart', async (t) => {
  const f = await fixture(t);
  const gateway = new ScriptedGateway([
    JSON.stringify({
      reply: 'I will track your Maui preparation.',
      workProposals: [{ id: 'maui', title: 'Prepare for Maui', goal: 'Ready to depart' }],
      factProposals: [{ id: 'departure', subject: 'owner', predicate: 'trip.maui.departure', value: '2026-09-12', validFrom: '2026-09-07T00:00:00.000Z' }]
    }),
    JSON.stringify({ reply: 'Your Maui work item is still open.', workProposals: [], factProposals: [] })
  ]);
  let service = new f.AgentService(f.store, gateway, () => f.clock.value);
  const first = await service.runOwnerTurn({ workspaceId: 'personal', ownerId: 'owner', threadId: 'im', externalId: 'u1', text: 'I leave for Maui on September 12.', model });
  assert.equal(first.turn.reply, 'I will track your Maui preparation.');
  assert.match(gateway.requests[0].system, /reasoning component of Behalvo/);
  assert.equal(f.store.state('personal').works.maui.phase, 'open');
  assert.equal(f.store.state('personal').facts.departure.value, '2026-09-12');
  assert.equal(f.store.inbox('personal').length, 0);
  assert.equal(f.store.threadMessages('personal', 'im', 20).length, 2);

  f.restart();
  service = new f.AgentService(f.store, gateway, () => f.clock.value);
  const second = await service.runOwnerTurn({ workspaceId: 'personal', ownerId: 'owner', threadId: 'web', externalId: 'u2', text: 'What is the Maui status?', workId: 'maui', model });
  assert.equal(second.turn.reply, 'Your Maui work item is still open.');
  assert.match(gateway.requests[1].prompt, /Prepare for Maui/);
  assert.match(gateway.requests[1].prompt, /trip\.maui\.departure/);
  assert.doesNotMatch(gateway.requests[1].prompt, /I leave for Maui on September 12/);
});

test('AgentService rebinds fact provenance to the current owner message record', async (t) => {
  const f = await fixture(t);
  const gateway = new ScriptedGateway([JSON.stringify({
    reply: 'Saved.',
    workProposals: [],
    factProposals: [{ id: 'city', subject: 'owner', predicate: 'home.city', value: 'Walnut Creek', validFrom: '2026-09-07T00:00:00.000Z' }]
  })]);
  const service = new f.AgentService(f.store, gateway, () => f.clock.value);
  const result = await service.runOwnerTurn({ workspaceId: 'personal', ownerId: 'owner', threadId: 'im', externalId: 'u1', text: 'I live in Walnut Creek now.', model });
  assert.equal(f.store.state('personal').facts.city.sourceRecordId, result.ownerRecordId);
  assert.equal(f.store.record('personal', result.ownerRecordId).event.type, 'message.received');
});

test('invalid model output leaves the durable owner input unhandled and makes no proposal state changes', async (t) => {
  const f = await fixture(t);
  const gateway = new ScriptedGateway([JSON.stringify({ reply: 'x', commands: [{ kind: 'message.send' }] })]);
  const service = new f.AgentService(f.store, gateway, () => f.clock.value);
  await assert.rejects(() => service.runOwnerTurn({ workspaceId: 'personal', ownerId: 'owner', threadId: 'im', externalId: 'u1', text: 'Do something unsafe.', model }), /field|unknown|schema/i);
  assert.equal(f.store.inbox('personal').length, 1);
  assert.equal(Object.keys(f.store.state('personal').works).length, 0);
  assert.equal(Object.keys(f.store.state('personal').facts).length, 0);
});

test('retry pins the original owner input after newer messages and a restart', async (t) => {
  const f = await fixture(t);
  const gateway = new ScriptedGateway(['invalid JSON', JSON.stringify({ reply: 'Recovered.' })]);
  let service = new f.AgentService(f.store, gateway);
  const input = { workspaceId: 'personal', ownerId: 'owner', threadId: 'im', externalId: 'original', text: 'Remember the original request.', model };
  await assert.rejects(() => service.runOwnerTurn(input), /JSON/);
  for (let i = 0; i < 51; i++)
    f.store.ingest('personal', { source: 'owner:local', externalId: `newer-${i}`, threadId: 'im', senderId: 'owner', senderRole: 'owner', text: `Later unrelated request ${i}.` });
  f.restart();
  service = new f.AgentService(f.store, gateway);
  const result = await service.runOwnerTurn({ ...input, windowTokens: 1600, outputReserve: 0 });
  assert.ok(result.context.includedRecordIds.includes(result.ownerRecordId));
  assert.match(gateway.requests.at(-1).prompt, /CURRENT OWNER INPUT[^\n]*\n[^\n]*Remember the original request/);
  assert.ok(!f.store.inbox('personal').some(record => record.id === result.ownerRecordId));
});

test('retry fails closed when the original input cannot fit despite a short newer message', async (t) => {
  const f = await fixture(t);
  const gateway = new ScriptedGateway(['invalid JSON', JSON.stringify({ reply: 'Must not run.' })]);
  const service = new f.AgentService(f.store, gateway);
  const input = { workspaceId: 'personal', ownerId: 'owner', threadId: 'im', externalId: 'original', text: 'x'.repeat(5000), model };
  await assert.rejects(() => service.runOwnerTurn(input), /JSON/);
  const original = f.store.inbox('personal')[0];
  f.store.ingest('personal', { source: 'owner:local', externalId: 'newer', threadId: 'im', senderId: 'owner', senderRole: 'owner', text: 'A short newer input.' });
  await assert.rejects(() => service.runOwnerTurn({ ...input, windowTokens: 1600, outputReserve: 0 }), /budget/i);
  assert.equal(gateway.requests.length, 1);
  assert.ok(f.store.inbox('personal').some(record => record.id === original.id));
});

test('completed redelivery is rejected before another model call or work link', async (t) => {
  const f = await fixture(t);
  const gateway = new ScriptedGateway([JSON.stringify({ reply: 'Done.' }), JSON.stringify({ reply: 'Duplicate.' })]);
  const service = new f.AgentService(f.store, gateway);
  const input = { workspaceId: 'personal', ownerId: 'owner', threadId: 'im', externalId: 'original', text: 'Hello.', model };
  await service.runOwnerTurn(input);
  f.operator.createWork('personal', 'owner', { id: 'other', title: 'Other', goal: 'Other work', threadId: 'other-thread' });
  const before = f.store.state('personal');
  await assert.rejects(() => service.runOwnerTurn({ ...input, workId: 'other' }), /already handled/i);
  assert.equal(gateway.requests.length, 1);
  assert.deepEqual(f.store.state('personal'), before);
});
