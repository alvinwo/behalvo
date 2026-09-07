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
