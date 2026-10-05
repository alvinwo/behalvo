import test from 'node:test';
import assert from 'node:assert/strict';
import { api, fixture } from './helpers.mjs';
const model = { provider: 'openai-codex', model: 'synthetic' };
const request = { model, system: 'synthetic', prompt: 'synthetic', sessionHint: 'shared-hint' };
const signature = (id, phase) => JSON.stringify({ v: 1, id, phase });
function runtime(message) {
  return { getModels: () => [], getModel: () => ({ provider: model.provider, id: model.model }),
    completeSimple: async () => message };
}
test('phase metadata selects one final answer and never concatenates commentary into protocol', async () => {
  const { PiModelGateway } = await api();
  const message = { stopReason: 'stop', content: [
    { type: 'text', text: 'Checking. {"tool":{}}', textSignature: signature('a', 'commentary') },
    { type: 'text', text: '{"tool":{"name":"catalog","arguments":{}}}', textSignature: signature('b', 'final_answer') }
  ] };
  assert.equal((await PiModelGateway.fromRuntime(runtime(message)).complete(request)).text, message.content[1].text);
});
test('ambiguous phase selections and incomplete stop reasons cannot produce protocol text', async () => {
  const { PiModelGateway } = await api();
  const final = { type: 'text', text: '{}', textSignature: signature('a', 'final_answer') };
  for (const content of [[final, { ...final, textSignature: signature('b', 'final_answer') }],
    [{ ...final, textSignature: signature('a', 'commentary') }], [final, { type: 'text', text: '{}' }]])
    await assert.rejects(PiModelGateway.fromRuntime(runtime({ stopReason: 'stop', content })).complete(request));
  for (const stopReason of ['length', 'aborted', 'toolUse'])
    await assert.rejects(PiModelGateway.fromRuntime(runtime({ stopReason, content: [final] })).complete(request));
});
test('runtime loader releases only its unique completion sessions on success and failure', async () => {
  const { PiModelGateway, createPiRuntimeLoader } = await api();
  const calls = [], closed = []; let reject = false;
  const original = runtime({});
  original.completeSimple = async (_model, _context, options) => {
    calls.push(options.sessionId);
    if (reject) throw new Error('synthetic failure');
    return { stopReason: 'stop', content: [{ type: 'text', text: '{}' }] };
  };
  const importer = async id => id.endsWith('/providers/all') ? { builtinModels: () => original }
    : { cleanupSessionResources: id => closed.push(id) };
  const gateway = new PiModelGateway(createPiRuntimeLoader('/unused/synthetic-auth.json', importer));
  await Promise.all([gateway.complete(request), gateway.complete(request)]);
  reject = true; await assert.rejects(gateway.complete(request));
  assert.equal(new Set(calls).size, 3);
  assert.ok(calls.every(id => typeof id === 'string' && id !== request.sessionHint));
  assert.deepEqual(closed.sort(), calls.sort());
});
test('owner fact identity is present in trusted context before any owner fact exists', async t => {
  const f = await fixture(t); f.store.createWorkspace('synthetic', 'synthetic-owner-123');
  const gateway = { listModels: async () => [], complete: async req => {
    const view = JSON.parse(req.prompt.split('CURRENT WORKSPACE VIEW\n')[1].split('\n')[0]);
    assert.equal(view.ownerId, 'synthetic-owner-123');
    assert.match(req.system, /ownerId/);
    return { text: JSON.stringify({ reply: 'Recorded.', workProposals: [], factProposals: [
      { id: 'language', subject: view.ownerId, predicate: 'documentation.language', value: 'English' }
    ] }) };
  } };
  await new f.AgentService(f.store, gateway).runOwnerTurn({ workspaceId: 'synthetic', ownerId: 'synthetic-owner-123',
    threadId: 'test', externalId: 'one', text: 'Remember I prefer English documentation.', model });
  assert.equal(f.store.state('synthetic').facts.language.subject, 'synthetic-owner-123');
});
test('phase extraction retains commentary in diagnostic evidence', async () => {
  const { PiModelGateway } = await api();
  const message = { stopReason: 'stop', content: [
    { type: 'text', text: 'SYNTHETIC_DIAGNOSTIC_CANARY', textSignature: signature('a', 'commentary') },
    { type: 'text', text: '{}', textSignature: signature('b', 'final_answer') }
  ] };
  const response = await PiModelGateway.fromRuntime(runtime(message)).complete(request);
  assert.match(response.diagnosticText, /SYNTHETIC_DIAGNOSTIC_CANARY/);
  assert.equal(response.text, '{}');
});

test('provider resource cleanup lets a command exit despite a persistent synthetic handle', async () => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const source = `
    import { PiModelGateway, createPiRuntimeLoader } from './dist/model/pi-gateway.js';
    const handles = new Map();
    const runtime = { getModels: () => [], getModel: () => ({provider:'synthetic',id:'test'}),
      async completeSimple(_m,_c,o) { handles.set(o.sessionId,setInterval(()=>{},1000));
        return {stopReason:'stop',content:[{type:'text',text:'{}'}]}; } };
    const importer = async id => id.endsWith('/providers/all') ? {builtinModels:()=>runtime}
      : {cleanupSessionResources:id=>{clearInterval(handles.get(id));handles.delete(id);}};
    const gateway = new PiModelGateway(createPiRuntimeLoader('/unused/synthetic.json',importer));
    await gateway.complete({model:{provider:'synthetic',model:'test'},system:'',prompt:''});
    if(handles.size) throw new Error('owned handle remains');
  `;
  await promisify(execFile)(process.execPath, ['--input-type=module', '-e', source], { cwd: process.cwd(), timeout: 5000 });
});

test('gateway bounds full visible output even for callers without the operation loop', async () => {
  const { PiModelGateway } = await api();
  const message = { stopReason: 'stop', content: [
    { type: 'text', text: 'x'.repeat(65537), textSignature: signature('a', 'commentary') },
    { type: 'text', text: '{}', textSignature: signature('b', 'final_answer') }
  ] };
  await assert.rejects(PiModelGateway.fromRuntime(runtime(message)).complete(request));
});
