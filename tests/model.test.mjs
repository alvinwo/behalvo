import test from 'node:test';
import assert from 'node:assert/strict';
import { api } from './helpers.mjs';

test('parseAgentTurn accepts the exact provider-independent envelope', async () => {
  const { parseAgentTurn } = await api();
  const turn = parseAgentTurn(JSON.stringify({
    reply: 'I will track that.',
    workProposals: [{ id: 'trip-maui', title: 'Prepare Maui trip', goal: 'Ready to depart' }],
    factProposals: [{ id: 'move-date', subject: 'owner', predicate: 'travel.departure', value: '2026-09-12', validFrom: '2026-09-07T00:00:00.000Z' }]
  }));
  assert.equal(turn.reply, 'I will track that.');
  assert.equal(turn.workProposals[0].id, 'trip-maui');
  assert.equal(turn.factProposals[0].predicate, 'travel.departure');
});

test('parseAgentTurn rejects malformed JSON, unknown fields and model-forged provenance', async () => {
  const { parseAgentTurn } = await api();
  assert.throws(() => parseAgentTurn('{not-json'), /json|parse/i);
  assert.throws(() => parseAgentTurn(JSON.stringify({ reply: 'x', commands: [] })), /field|schema|unknown/i);
  assert.throws(() => parseAgentTurn(JSON.stringify({ reply: 'x', factProposals: [{
    id: 'f', subject: 'owner', predicate: 'x', value: 'y', validFrom: '2026-09-07T00:00:00.000Z', sourceRecordId: 'forged'
  }] })), /field|schema|unknown/i);
});

test('parseAgentTurn rejects invalid identifiers and invalid validity timestamps', async () => {
  const { parseAgentTurn } = await api();
  assert.throws(() => parseAgentTurn(JSON.stringify({ reply: 'x', workProposals: [{ id: '../bad', title: 'x', goal: 'y' }] })), /id|identifier/i);
  assert.throws(() => parseAgentTurn(JSON.stringify({ reply: 'x', factProposals: [{
    id: 'f', subject: 'owner', predicate: 'x', value: 'y', validFrom: 'tomorrow'
  }] })), /timestamp|instant|date/i);
});
