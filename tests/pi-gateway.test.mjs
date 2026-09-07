import test from 'node:test';
import assert from 'node:assert/strict';
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
