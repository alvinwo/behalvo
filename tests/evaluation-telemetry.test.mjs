import test from 'node:test';
import assert from 'node:assert/strict';
import { api } from './helpers.mjs';

const request = {
  model: { provider: 'synthetic', model: 'bounded-test' },
  system: 'private system prompt',
  prompt: 'synthetic owner request'
};

function scriptedGateway(complete) {
  return {
    async listModels() {
      return [{ provider: 'synthetic', model: 'bounded-test' }];
    },
    complete
  };
}

async function rejectionCode(promise, code) {
  await assert.rejects(promise, error => {
    assert.equal(error.code, code);
    assert.equal(error.message, code);
    return true;
  });
}

test('BudgetedModelGateway forwards evaluation controls and records bounded safe telemetry', async () => {
  const { BudgetedModelGateway } = await api();
  let received;
  let now = 100;
  const gateway = new BudgetedModelGateway(scriptedGateway(async next => {
    received = next;
    now = 112;
    return {
      text: '你'.repeat(3000),
      providerResponseId: 'private-provider-id',
      usage: {
        inputTokens: 9,
        outputTokens: 4,
        cacheReadTokens: 0,
        cacheWriteTokens: null,
        totalTokens: 13,
        estimatedCostUsd: 0.004,
        source: 'pi-sdk'
      }
    };
  }), { maxCalls: 2, maxDurationMs: 1000, clock: () => now });

  const response = await gateway.complete(request);
  assert.equal(response.text, '你'.repeat(3000));
  assert.equal(received.maxRetries, 0);
  assert.equal(received.maxOutputTokens, 2048);
  assert.ok(received.signal instanceof AbortSignal);
  assert.equal(received.signal.aborted, false);

  const records = gateway.records;
  assert.equal(records.length, 1);
  assert.deepEqual(records[0], {
    provider: 'synthetic',
    model: 'bounded-test',
    latencyMs: 12,
    requestBytes: Buffer.byteLength(JSON.stringify(request), 'utf8'),
    responseBytes: 9000,
    status: 'ok',
    usage: {
      inputTokens: 9,
      outputTokens: 4,
      cacheReadTokens: 0,
      cacheWriteTokens: null,
      totalTokens: 13,
      estimatedCostUsd: 0.004,
      source: 'pi-sdk'
    },
    responseExcerpt: '你'.repeat(2666),
    responseTruncated: true
  });
  assert.ok(Buffer.byteLength(records[0].responseExcerpt, 'utf8') <= 8000);
  assert.ok(Object.isFrozen(records));
  assert.ok(Object.isFrozen(records[0]));
  assert.throws(() => records.push({}), TypeError);
  assert.equal(JSON.stringify(records).includes('private system prompt'), false);
  assert.equal(JSON.stringify(records).includes('private-provider-id'), false);
});

test('BudgetedModelGateway rejects a response resolved after the absolute call deadline', async () => {
  const { BudgetedModelGateway } = await api();
  let now = 0;
  let receivedSignal;
  const gateway = new BudgetedModelGateway(scriptedGateway(async next => {
    receivedSignal = next.signal;
    now = 11;
    return { text: 'resolved after deadline' };
  }), { maxCalls: 1, maxDurationMs: 1000, callTimeoutMs: 10, clock: () => now });

  await rejectionCode(gateway.complete(request), 'call_timeout');
  assert.equal(receivedSignal.aborted, true);
  assert.deepEqual(gateway.records.map(record => ({ status: record.status, latencyMs: record.latencyMs })), [
    { status: 'call_timeout', latencyMs: 11 }
  ]);
});

test('BudgetedModelGateway classifies a response resolved after a clamped suite deadline', async () => {
  const { BudgetedModelGateway } = await api();
  let now = 0;
  let receivedSignal;
  const gateway = new BudgetedModelGateway(scriptedGateway(async next => {
    receivedSignal = next.signal;
    now = 11;
    return { text: 'resolved after suite deadline' };
  }), { maxCalls: 1, maxDurationMs: 10, callTimeoutMs: 1000, clock: () => now });

  await rejectionCode(gateway.complete(request), 'suite_deadline');
  assert.equal(receivedSignal.aborted, true);
  assert.equal(gateway.exhausted, true);
  assert.deepEqual(gateway.records.map(record => ({ status: record.status, latencyMs: record.latencyMs })), [
    { status: 'suite_deadline', latencyMs: 11 }
  ]);
});

test('BudgetedModelGateway rejects oversized responses without returning them', async () => {
  const { BudgetedModelGateway } = await api();
  const gateway = new BudgetedModelGateway(scriptedGateway(async () => ({ text: 'x'.repeat(65537) })), {
    maxCalls: 1,
    maxDurationMs: 1000
  });

  await rejectionCode(gateway.complete(request), 'response_size');
  assert.equal(gateway.records[0].status, 'response_size');
  assert.equal(gateway.records[0].responseBytes, 65537);
  assert.equal(Buffer.byteLength(gateway.records[0].responseExcerpt, 'utf8'), 8000);
  assert.equal(gateway.records[0].responseTruncated, true);
});

test('BudgetedModelGateway hides provider errors from errors and records', async () => {
  const { BudgetedModelGateway } = await api();
  const secret = 'credential=synthetic-secret-value';
  const gateway = new BudgetedModelGateway(scriptedGateway(async () => {
    throw new Error(secret);
  }), { maxCalls: 1, maxDurationMs: 1000 });

  await rejectionCode(gateway.complete(request), 'provider_error');
  assert.equal(gateway.records[0].status, 'provider_error');
  assert.equal(JSON.stringify(gateway.records).includes(secret), false);
  assert.equal(JSON.stringify(gateway.records).includes(request.system), false);
});

test('BudgetedModelGateway aborts timed out calls and discards late results', async () => {
  const { BudgetedModelGateway } = await api();
  let resolveLate;
  let receivedSignal;
  const late = new Promise(resolve => { resolveLate = resolve; });
  const gateway = new BudgetedModelGateway(scriptedGateway(next => {
    receivedSignal = next.signal;
    return late;
  }), { maxCalls: 1, maxDurationMs: 1000, callTimeoutMs: 10 });

  await rejectionCode(gateway.complete(request), 'call_timeout');
  assert.equal(receivedSignal.aborted, true);
  assert.deepEqual(gateway.records.map(record => record.status), ['call_timeout']);

  resolveLate({
    text: 'late private result',
    usage: {
      inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0,
      totalTokens: 2, estimatedCostUsd: 1, source: 'pi-sdk'
    }
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(gateway.records.map(record => record.status), ['call_timeout']);
  assert.equal(JSON.stringify(gateway.records).includes('late private result'), false);
});

test('BudgetedModelGateway clamps a call to the remaining suite deadline', async () => {
  const { BudgetedModelGateway } = await api();
  let receivedSignal;
  const gateway = new BudgetedModelGateway(scriptedGateway(next => {
    receivedSignal = next.signal;
    return new Promise(() => {});
  }), { maxCalls: 2, maxDurationMs: 10, callTimeoutMs: 1000 });

  await rejectionCode(gateway.complete(request), 'suite_deadline');
  assert.equal(receivedSignal.aborted, true);
  assert.equal(gateway.records[0].status, 'suite_deadline');
  assert.equal(gateway.exhausted, true);
  await rejectionCode(gateway.complete(request), 'suite_deadline');
  assert.equal(gateway.records.length, 1);
});

test('BudgetedModelGateway reserves concurrent call slots before dispatch', async () => {
  const { BudgetedModelGateway } = await api();
  let release;
  let calls = 0;
  const pending = new Promise(resolve => { release = resolve; });
  const gateway = new BudgetedModelGateway(scriptedGateway(async () => {
    calls++;
    return pending;
  }), { maxCalls: 1, maxDurationMs: 1000 });

  const first = gateway.complete(request);
  await rejectionCode(gateway.complete(request), 'call_budget');
  assert.equal(calls, 1);
  assert.equal(gateway.exhausted, true);
  release({ text: 'one response' });
  assert.equal((await first).text, 'one response');
  assert.equal(gateway.records.length, 1);
});

test('BudgetedModelGateway validates positive bounded options', async () => {
  const { BudgetedModelGateway } = await api();
  const inner = scriptedGateway(async () => ({ text: 'unused' }));
  for (const options of [
    { maxCalls: 0, maxDurationMs: 1 },
    { maxCalls: 2401, maxDurationMs: 1 },
    { maxCalls: 1.5, maxDurationMs: 1 },
    { maxCalls: 1, maxDurationMs: 0 },
    { maxCalls: 1, maxDurationMs: 3600001 },
    { maxCalls: 1, maxDurationMs: 1, callTimeoutMs: 0 },
    { maxCalls: 1, maxDurationMs: 1, callTimeoutMs: 3600001 }
  ]) {
    assert.throws(() => new BudgetedModelGateway(inner, options), /invalid/i);
  }
});
