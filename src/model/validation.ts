import { identifier, instant, nonempty } from '../kernel/types.js';
import type { AgentTurn, FactProposal, WorkProposal } from './types.js';

function plainObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error(`${label} must be a JSON object`);
  return value as Record<string, unknown>;
}

function exactFields(object: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(object)) {
    if (!allowedSet.has(key))
      throw new Error(`Unknown ${label} field: ${key}`);
  }
}

function requiredString(object: Record<string, unknown>, key: string, label = key): string {
  const value = object[key];
  nonempty(value, label);
  if (value.length > 65536)
    throw new Error(`${label} is too large`);
  return value;
}

function parseWork(value: unknown): WorkProposal {
  const object = plainObject(value, 'work proposal');
  exactFields(object, ['id', 'title', 'goal'], 'work proposal');
  const id = requiredString(object, 'id');
  identifier(id, 'work proposal id');
  return { id, title: requiredString(object, 'title'), goal: requiredString(object, 'goal') };
}

function parseFact(value: unknown): FactProposal {
  const object = plainObject(value, 'fact proposal');
  exactFields(object, ['id', 'subject', 'predicate', 'value', 'validFrom', 'validTo', 'supersedes'], 'fact proposal');
  const id = requiredString(object, 'id');
  const subject = requiredString(object, 'subject');
  const predicate = requiredString(object, 'predicate');
  identifier(id, 'fact proposal id');
  identifier(subject, 'fact subject');
  nonempty(predicate, 'fact predicate');
  if (predicate.length > 200)
    throw new Error('fact predicate is too large');
  const validFrom = requiredString(object, 'validFrom');
  instant(validFrom);
  const validToValue = object.validTo;
  let validTo: string | null | undefined;
  if (validToValue !== undefined) {
    if (validToValue !== null) {
      if (typeof validToValue !== 'string')
        throw new Error('validTo must be a UTC ISO timestamp or null');
      instant(validToValue);
    }
    validTo = validToValue;
  }
  const supersedesValue = object.supersedes;
  let supersedes: string | undefined;
  if (supersedesValue !== undefined) {
    nonempty(supersedesValue, 'supersedes');
    identifier(supersedesValue, 'supersedes');
    supersedes = supersedesValue;
  }
  return {
    id,
    subject,
    predicate,
    value: requiredString(object, 'value'),
    validFrom,
    ...(validTo !== undefined ? { validTo } : {}),
    ...(supersedes !== undefined ? { supersedes } : {})
  };
}

export function parseAgentTurn(text: string): AgentTurn {
  nonempty(text, 'model output');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('Model output is not valid JSON');
  }
  const object = plainObject(parsed, 'agent turn');
  exactFields(object, ['reply', 'workProposals', 'factProposals'], 'agent turn');
  const reply = requiredString(object, 'reply');
  const workRaw = object.workProposals ?? [];
  const factRaw = object.factProposals ?? [];
  if (!Array.isArray(workRaw) || !Array.isArray(factRaw))
    throw new Error('Agent turn proposal fields must be arrays');
  if (workRaw.length > 32 || factRaw.length > 64)
    throw new Error('Agent turn proposal count exceeds limit');
  return {
    reply,
    workProposals: workRaw.map(parseWork),
    factProposals: factRaw.map(parseFact)
  };
}
