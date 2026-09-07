import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.mjs';

class ScriptedIo {
  constructor(lines) { this.lines = [...lines]; this.output = []; }
  async readLine() { return this.lines.shift() ?? null; }
  write(line = '') { this.output.push(String(line)); }
}

test('runRepl supports model selection, durable owner turns, work inspection and a new thread', async t => {
  const f = await fixture(t);
  const { FakeModelGateway, ModelRegistry, AgentService, runRepl } = f;
  let turn = 0;
  const fake = new FakeModelGateway([{ provider: 'fake', model: 'test', label: 'Offline Test' }], req => {
    turn += 1;
    if (turn === 1) return { text: JSON.stringify({
      reply: 'I created a Maui preparation work item.',
      workProposals: [{ id: 'maui', title: 'Prepare for Maui', goal: 'Be ready before departure' }],
      factProposals: [{ id: 'departure', subject: 'maui', predicate: 'departure_date', value: '2026-09-12', validFrom: '2026-09-07T00:00:00.000Z' }]
    }) };
    assert.match(req.prompt, /Prepare for Maui/);
    return { text: JSON.stringify({ reply: 'Your Maui work is still open.', workProposals: [], factProposals: [] }) };
  });
  const registry = new ModelRegistry([fake]);
  const service = new AgentService(f.store, registry, () => f.clock.value);
  const io = new ScriptedIo([
    '/model',
    '/model fake test',
    'I am going to Maui.',
    '/work',
    '/state',
    '/history 5',
    '/context',
    '/new second-thread',
    '/work maui',
    'What about that trip?',
    '/quit'
  ]);

  const result = await runRepl({
    store: f.store,
    registry,
    service,
    io,
    workspaceId: 'personal',
    ownerId: 'owner',
    initialThreadId: 'first-thread'
  });

  assert.equal(result.reason, 'quit');
  assert.match(io.output.join('\n'), /fake\/test/);
  assert.match(io.output.join('\n'), /I created a Maui preparation work item/);
  assert.match(io.output.join('\n'), /maui.*Prepare for Maui/s);
  assert.match(io.output.join('\n'), /second-thread/);
  assert.match(io.output.join('\n'), /Your Maui work is still open/);
  assert.equal(f.store.state('personal').works.maui.phase, 'open');
  assert.ok(f.store.state('personal').works.maui.threadIds.includes('second-thread'));
});

test('runRepl refuses chat until a model is selected and prints help for unknown commands', async t => {
  const f = await fixture(t);
  const { FakeModelGateway, ModelRegistry, AgentService, runRepl } = f;
  const registry = new ModelRegistry([new FakeModelGateway([{ provider: 'fake', model: 'one' }], () => ({ text: 'never' }))]);
  const service = new AgentService(f.store, registry, () => f.clock.value);
  const io = new ScriptedIo(['hello', '/wat', '/quit']);
  await runRepl({ store: f.store, registry, service, io, workspaceId: 'personal', ownerId: 'owner', initialThreadId: 'im' });
  const output = io.output.join('\n');
  assert.match(output, /select.*model|\/model/i);
  assert.match(output, /unknown command|\/help/i);
  assert.equal(f.store.messageCount('personal', 'im'), 0);
});

test('runRepl exposes provider-owned login without recording credentials in the journal', async t => {
  const f = await fixture(t);
  const { FakeModelGateway, ModelRegistry, AgentService, runRepl } = f;
  const registry = new ModelRegistry([new FakeModelGateway([{ provider: 'fake', model: 'one' }], () => ({ text: 'never' }))]);
  const service = new AgentService(f.store, registry, () => f.clock.value);
  const loginCalls = [];
  const authenticator = {
    async login(provider, type, interaction) {
      loginCalls.push({ provider, type });
      interaction.notify({ type: 'auth_url', url: 'https://example.test/oauth', instructions: 'Open it' });
      const method = await interaction.prompt({ type: 'select', message: 'Choose login method', options: [
        { id: 'browser', label: 'Browser' }, { id: 'device', label: 'Device code' }
      ] });
      assert.equal(method, 'browser');
      return { type: 'oauth', access: 'DO-NOT-JOURNAL', refresh: 'DO-NOT-JOURNAL', expires: 999 };
    }
  };
  const io = new ScriptedIo(['/login openai-codex oauth', 'browser', '/quit']);
  await runRepl({ store: f.store, registry, service, authenticator, io, workspaceId: 'personal', ownerId: 'owner', initialThreadId: 'im' });
  assert.deepEqual(loginCalls, [{ provider: 'openai-codex', type: 'oauth' }]);
  assert.match(io.output.join('\n'), /https:\/\/example\.test\/oauth/);
  assert.match(io.output.join('\n'), /Login complete.*openai-codex/i);
  assert.doesNotMatch(JSON.stringify(f.store.journal('personal')), /DO-NOT-JOURNAL/);
});
