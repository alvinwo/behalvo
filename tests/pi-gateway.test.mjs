import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { api } from './helpers.mjs';

function fakePiRuntime() {
  const calls = [];
  const models = [
    { provider: 'openai-codex', id: 'gpt-test', name: 'GPT Test', contextWindow: 128000 },
    { provider: 'anthropic', id: 'claude-test', name: 'Claude Test', contextWindow: 200000 }
  ];
  return {
    calls,
    getModels(provider) {
      return provider ? models.filter(model => model.provider === provider) : models;
    },
    getModel(provider, id) {
      return models.find(model => model.provider === provider && model.id === id);
    },
    async completeSimple(model, context, options) {
      calls.push({ model, context, options });
      return {
        content: [
          { type: 'thinking', thinking: 'private' },
          { type: 'text', text: '{"reply":"hello",' },
          { type: 'text', text: '"workProposals":[],"factProposals":[]}' }
        ],
        responseId: 'resp-123',
        stopReason: 'stop'
      };
    }
  };
}

test('concurrent first logins share one runtime and preserve both provider credentials', async (t) => {
  const { PiModelGateway, createPiRuntimeLoader } = await api();
  const dir = await mkdtemp(join(tmpdir(), 'behalvo-pi-login-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'auth.json');
  let loads = 0;
  const gateway = new PiModelGateway(createPiRuntimeLoader(path, async () => {
    loads++;
    return { builtinModels({ credentials }) {
      return {
        ...fakePiRuntime(),
        login(provider, type) {
          return credentials.modify(provider, async () => ({ type, key: `synthetic-${provider}` }));
        }
      };
    } };
  }));
  const interaction = { prompt: async () => '', notify() {} };
  await Promise.all([
    gateway.login('openai', 'api_key', interaction),
    gateway.login('anthropic', 'api_key', interaction)
  ]);
  assert.equal(loads, 1, 'one gateway must share the credential-store serialization queue');
  const saved = JSON.parse(await readFile(path, 'utf8'));
  assert.deepEqual(Object.keys(saved).sort(), ['anthropic', 'openai']);
  assert.equal(saved.openai.key, 'synthetic-openai');
  assert.equal(saved.anthropic.key, 'synthetic-anthropic');
});

test('a shared initialization failure is retryable on the next gateway call', async () => {
  const { PiModelGateway } = await api();
  let loads = 0;
  const gateway = new PiModelGateway(async () => {
    if (++loads === 1) throw new Error('temporary loader failure');
    return fakePiRuntime();
  });
  const results = await Promise.allSettled([gateway.listModels(), gateway.listModels()]);
  assert.deepEqual(results.map(result => result.status), ['rejected', 'rejected']);
  assert.equal(loads, 1);
  assert.equal((await gateway.listModels()).length, 2);
  assert.equal(loads, 2);
});

test('PiModelGateway maps the Pi catalog and completion without making Pi session state authoritative', async () => {
  const { PiModelGateway } = await api();
  const runtime = fakePiRuntime();
  const gateway = PiModelGateway.fromRuntime(runtime);

  assert.deepEqual(await gateway.listModels(), [
    { provider: 'openai-codex', model: 'gpt-test', label: 'GPT Test', contextWindow: 128000 },
    { provider: 'anthropic', model: 'claude-test', label: 'Claude Test', contextWindow: 200000 }
  ]);

  const response = await gateway.complete({
    model: { provider: 'openai-codex', model: 'gpt-test' },
    system: 'SYSTEM',
    prompt: 'PROMPT',
    sessionHint: 'cache-only-hint'
  });

  assert.equal(response.text, '{"reply":"hello","workProposals":[],"factProposals":[]}');
  assert.equal(response.providerResponseId, 'resp-123');
  assert.equal(runtime.calls.length, 1);
  assert.equal(runtime.calls[0].model.id, 'gpt-test');
  assert.equal(runtime.calls[0].context.systemPrompt, 'SYSTEM');
  assert.deepEqual(runtime.calls[0].context.messages, [
    { role: 'user', content: 'PROMPT', timestamp: 0 }
  ]);
  assert.deepEqual(runtime.calls[0].options, { sessionId: 'cache-only-hint' });
});

test('PiModelGateway rejects unknown models and non-text/error responses', async () => {
  const { PiModelGateway } = await api();
  const runtime = fakePiRuntime();
  const gateway = PiModelGateway.fromRuntime(runtime);

  await assert.rejects(() => gateway.complete({
    model: { provider: 'missing', model: 'none' }, system: 's', prompt: 'p'
  }), /model|not found/i);

  const errored = PiModelGateway.fromRuntime({
    ...runtime,
    async completeSimple() {
      return { content: [], stopReason: 'error', errorMessage: 'provider broke' };
    }
  });
  await assert.rejects(() => errored.complete({
    model: { provider: 'openai-codex', model: 'gpt-test' }, system: 's', prompt: 'p'
  }), /provider broke|error/i);
});

test('PiModelGateway default loader fails with actionable optional-dependency guidance', async () => {
  const { PiModelGateway } = await api();
  const gateway = new PiModelGateway(async () => {
    throw Object.assign(new Error('module missing'), { code: 'ERR_MODULE_NOT_FOUND' });
  });
  await assert.rejects(() => gateway.listModels(), /@earendil-works\/pi-ai|optional|install/i);
});

test('createPiRuntimeLoader injects the configured file credential store into builtinModels', async () => {
  const { createPiRuntimeLoader, PiCredentialFileStore } = await api();
  let receivedOptions;
  const runtime = fakePiRuntime();
  const loader = createPiRuntimeLoader('/tmp/operator-auth.json', async specifier => {
    assert.equal(specifier, '@earendil-works/pi-ai/providers/all');
    return {
      builtinModels(options) {
        receivedOptions = options;
        return runtime;
      }
    };
  });
  assert.equal(await loader(), runtime);
  assert.ok(receivedOptions.credentials instanceof PiCredentialFileStore);
  assert.equal(receivedOptions.credentials.path, '/tmp/operator-auth.json');
});

test('PiModelGateway forwards provider-owned login without putting credentials in model state', async () => {
  const { PiModelGateway } = await api();
  const runtime = fakePiRuntime();
  runtime.login = async (provider, type, interaction) => {
    assert.equal(provider, 'openai-codex');
    assert.equal(type, 'oauth');
    interaction.notify({ type: 'progress', message: 'opening browser' });
    assert.equal(await interaction.prompt({ type: 'select', message: 'Method', options: [{ id: 'browser', label: 'Browser' }] }), 'browser');
    return { type: 'oauth', access: 'a', refresh: 'r', expires: 123 };
  };
  const gateway = PiModelGateway.fromRuntime(runtime);
  const events = [];
  const credential = await gateway.login('openai-codex', 'oauth', {
    notify: event => events.push(event),
    prompt: async () => 'browser'
  });
  assert.equal(credential.type, 'oauth');
  assert.deepEqual(events, [{ type: 'progress', message: 'opening browser' }]);
});
