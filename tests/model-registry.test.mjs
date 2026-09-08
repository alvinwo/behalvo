import test from 'node:test';
import assert from 'node:assert/strict';
import { api } from './helpers.mjs';

test('ModelRegistry merges models, selects one and routes completion to its owning gateway', async () => {
  const { ModelRegistry, FakeModelGateway } = await api();
  const a = new FakeModelGateway([{ provider: 'a', model: 'one' }], req => ({ text: `A:${req.prompt}` }));
  const b = new FakeModelGateway([{ provider: 'b', model: 'two' }], req => ({ text: `B:${req.prompt}` }));
  const registry = new ModelRegistry([a, b]);
  assert.deepEqual(await registry.listModels(), [
    { provider: 'a', model: 'one' },
    { provider: 'b', model: 'two' }
  ]);
  assert.equal(registry.selected(), null);
  await registry.select('b', 'two');
  assert.deepEqual(registry.selected(), { provider: 'b', model: 'two' });
  const result = await registry.complete({ model: registry.selected(), system: 's', prompt: 'hello' });
  assert.equal(result.text, 'B:hello');
  assert.equal(a.requests.length, 0);
  assert.equal(b.requests.length, 1);
});

test('ModelRegistry rejects unknown or ambiguous model routes', async () => {
  const { ModelRegistry, FakeModelGateway } = await api();
  const one = new FakeModelGateway([{ provider: 'a', model: 'one' }], () => ({ text: 'x' }));
  const registry = new ModelRegistry([one]);
  await assert.rejects(() => registry.select('missing', 'x'), /model|unknown|not found/i);
  await assert.rejects(() => registry.complete({ model: { provider: 'missing', model: 'x' }, system: 's', prompt: 'p' }), /model|gateway|not found/i);

  const duplicate = new ModelRegistry([
    new FakeModelGateway([{ provider: 'a', model: 'one' }], () => ({ text: 'x' })),
    new FakeModelGateway([{ provider: 'a', model: 'one' }], () => ({ text: 'y' }))
  ]);
  await assert.rejects(() => duplicate.listModels(), /duplicate|ambiguous/i);
});

test('FakeModelGateway refuses requests for models outside its catalog', async () => {
  const { FakeModelGateway } = await api();
  const gateway = new FakeModelGateway([{ provider: 'fake', model: 'one' }], () => ({ text: 'ok' }));
  await assert.rejects(() => gateway.complete({ model: { provider: 'fake', model: 'other' }, system: 's', prompt: 'p' }), /model|catalog/i);
});
