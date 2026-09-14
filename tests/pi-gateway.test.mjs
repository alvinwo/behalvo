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

test('PiModelGateway forwards optional request controls and normalizes Pi usage', async () => {
  const { PiModelGateway } = await api();
  const runtime = fakePiRuntime();
  runtime.completeSimple = async (model, context, options) => {
    runtime.calls.push({ model, context, options });
    return {
      content: [{ type: 'text', text: 'bounded response' }],
      stopReason: 'stop',
      usage: {
        input: 11,
        output: 7,
        cacheRead: 3,
        cacheWrite: 2,
        totalTokens: 23,
        cost: { input: 0.001, output: 0.002, cacheRead: 0.0001, cacheWrite: 0.0002, total: 0.0033 }
      }
    };
  };
  const gateway = PiModelGateway.fromRuntime(runtime);
  const controller = new AbortController();

  const response = await gateway.complete({
    model: { provider: 'openai-codex', model: 'gpt-test' },
    system: 'SYSTEM',
    prompt: 'PROMPT',
    sessionHint: 'cache-only-hint',
    signal: controller.signal,
    maxRetries: 0,
    maxOutputTokens: 2048
  });

  assert.deepEqual(runtime.calls[0].options, {
    sessionId: 'cache-only-hint',
    signal: controller.signal,
    maxRetries: 0,
    maxTokens: 2048
  });
  assert.deepEqual(response.usage, {
    inputTokens: 11,
    outputTokens: 7,
    cacheReadTokens: 3,
    cacheWriteTokens: 2,
    totalTokens: 23,
    estimatedCostUsd: 0.0033,
    source: 'pi-sdk'
  });
});

test('PiModelGateway keeps missing and invalid Pi usage fields unknown', async () => {
  const { PiModelGateway } = await api();
  const runtime = fakePiRuntime();
  runtime.completeSimple = async () => ({
    content: [{ type: 'text', text: 'sanitized response' }],
    stopReason: 'stop',
    usage: {
      input: -1,
      output: 1.5,
      cacheRead: Number.POSITIVE_INFINITY,
      totalTokens: 0,
      cost: { total: Number.NaN }
    }
  });

  const response = await PiModelGateway.fromRuntime(runtime).complete({
    model: { provider: 'openai-codex', model: 'gpt-test' }, system: 's', prompt: 'p'
  });

  assert.deepEqual(response.usage, {
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    totalTokens: null,
    estimatedCostUsd: null,
    source: 'pi-sdk'
  });
});

test('PiModelGateway treats an all-zero SDK usage placeholder as unknown', async () => {
  const { PiModelGateway } = await api();
  const runtime = fakePiRuntime();
  runtime.completeSimple = async () => ({
    content: [{ type: 'text', text: 'response with unreported usage' }],
    stopReason: 'stop',
    usage: {
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
    }
  });

  const response = await PiModelGateway.fromRuntime(runtime).complete({
    model: { provider: 'openai-codex', model: 'gpt-test' }, system: 's', prompt: 'p'
  });

  assert.deepEqual(response.usage, {
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    totalTokens: null,
    estimatedCostUsd: null,
    source: 'pi-sdk'
  });
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

test('protected loader eagerly captures its key and injects a protected credential store through argument three', async t => {
  const { PiModelGateway, createPiRuntimeLoader, PiCredentialFileStore } = await api();
  const dir = await mkdtemp(join(tmpdir(), 'behalvo-pi-protected-loader-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'auth.json');
  const callerKey = Buffer.alloc(32, 5);
  let received;
  const loader = createPiRuntimeLoader(path, async () => ({
    builtinModels(options) {
      received = options.credentials;
      const runtime = fakePiRuntime();
      runtime.login = (provider, type) => received.modify(provider, async () => ({ type, key: 'synthetic-protected' }));
      return runtime;
    }
  }), { encryptionKey: callerKey });
  callerKey.fill(0);
  const gateway = new PiModelGateway(loader, { sanitizeErrors: true });
  await gateway.login('synthetic', 'api_key', { prompt: async () => '', notify() {} });
  assert.ok(received instanceof PiCredentialFileStore);
  assert.doesNotMatch((await readFile(path, 'utf8')), /synthetic-protected|synthetic/);
  assert.equal((await received.read('synthetic')).key, 'synthetic-protected');
});

test('an injected Pi runtime refreshes synthetic OAuth credentials through the protected store', async t => {
  const { PiModelGateway, createPiRuntimeLoader } = await api();
  const dir = await mkdtemp(join(tmpdir(), 'behalvo-pi-protected-refresh-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'auth.json');
  let credentials;
  const loader = createPiRuntimeLoader(path, async () => ({
    builtinModels(options) {
      credentials = options.credentials;
      const runtime = fakePiRuntime();
      runtime.login = provider => credentials.modify(provider, async () => ({
        type: 'oauth', access: 'synthetic-expired', refresh: 'synthetic-refresh', expires: 1
      }));
      runtime.completeSimple = async () => {
        await credentials.modify('openai-codex', async current => ({
          ...current, access: 'synthetic-refreshed', refresh: 'synthetic-rotated', expires: 2
        }));
        return { content: [{ type: 'text', text: 'synthetic response' }], stopReason: 'stop' };
      };
      return runtime;
    }
  }), { encryptionKey: Buffer.alloc(32, 6) });
  const gateway = new PiModelGateway(loader, { sanitizeErrors: true });
  await gateway.login('openai-codex', 'oauth', { prompt: async () => '', notify() {} });
  assert.equal((await gateway.complete({
    model: { provider: 'openai-codex', model: 'gpt-test' }, system: 'synthetic', prompt: 'synthetic'
  })).text, 'synthetic response');
  assert.deepEqual(await credentials.read('openai-codex'), {
    type: 'oauth', access: 'synthetic-refreshed', refresh: 'synthetic-rotated', expires: 2
  });
});

test('sanitized Pi gateway uses exact no-cause errors without leaking synthetic secrets', async () => {
  const { PiModelGateway } = await api();
  const checks = [
    [new PiModelGateway(async () => { throw new Error('synthetic-loader-secret'); }, { sanitizeErrors: true }),
      gateway => gateway.listModels(), 'Unable to load bundled Pi model support (@earendil-works/pi-ai). Use Node >=22.19 and run npm ci.'],
    [new PiModelGateway(async () => ({ ...fakePiRuntime(), async login() { throw new Error('synthetic-login-secret'); } }), { sanitizeErrors: true }),
      gateway => gateway.login('synthetic-provider-secret', 'oauth', { prompt: async () => '', notify() {} }), 'Pi login failed.'],
    [new PiModelGateway(async () => ({ ...fakePiRuntime(), getModels() { throw new Error('synthetic-catalog-secret'); } }), { sanitizeErrors: true }),
      gateway => gateway.listModels(), 'Pi model catalog is unavailable.'],
    [new PiModelGateway(async () => ({ ...fakePiRuntime(), getModel() { throw new Error('synthetic-lookup-secret'); } }), { sanitizeErrors: true }),
      gateway => gateway.complete({ model: { provider: 'p', model: 'm' }, system: 's', prompt: 'p' }), 'Pi provider request failed.'],
    [new PiModelGateway(async () => ({ ...fakePiRuntime(), async completeSimple() { throw new Error('synthetic-provider-secret'); } }), { sanitizeErrors: true }),
      gateway => gateway.complete({ model: { provider: 'openai-codex', model: 'gpt-test' }, system: 's', prompt: 'p' }), 'Pi provider request failed.'],
    [new PiModelGateway(async () => ({ ...fakePiRuntime(), async completeSimple() {
      return { content: [], stopReason: 'error', errorMessage: 'synthetic-returned-secret' };
    } }), { sanitizeErrors: true }),
      gateway => gateway.complete({ model: { provider: 'openai-codex', model: 'gpt-test' }, system: 's', prompt: 'p' }), 'Pi provider request failed.']
  ];
  for (const [gateway, operation, expected] of checks)
    await assert.rejects(() => operation(gateway), error => error.message === expected && !Object.hasOwn(error, 'cause'));
});

test('default Pi gateway mode retains raw provider failures for existing library callers', async () => {
  const { PiModelGateway } = await api();
  const loginFailure = new Error('legacy login detail');
  const gateway = new PiModelGateway(async () => ({ ...fakePiRuntime(), async login() { throw loginFailure; } }));
  await assert.rejects(
    () => gateway.login('synthetic', 'oauth', { prompt: async () => '', notify() {} }),
    error => error === loginFailure
  );
});
