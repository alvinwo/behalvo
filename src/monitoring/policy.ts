import { createHash } from 'node:crypto';
import { identifier, instant, nonempty } from '../kernel/types.js';
import type { Connection, OperationCommand } from '../operations/types.js';
import { canonicalJson, exactObject, jsonValue, validateOperationCommand } from '../operations/validation.js';
import type {
  MonitoredActionBinding, MonitoredActionGrant, MonitoredActionPolicyAdapter, Observation
} from './types.js';

const OBSERVATION_RESULTS = new Set([
  'complete', 'session_expired', 'needs_human', 'rate_limited', 'provider_unavailable', 'contract_changed'
]);

/** Limits signed jitter so every active recurrence remains strictly after its recorded instant. */
export function boundedMonitorJitter(delayMs: number, configuredJitterMs: number): number {
  if (!Number.isSafeInteger(delayMs) || delayMs < 1 || !Number.isSafeInteger(configuredJitterMs) ||
      configuredJitterMs < 0) throw new Error('Invalid monitor delay');
  return Math.min(configuredJitterMs, delayMs - 1);
}

export function canonicalInstant(value: unknown, label = 'timestamp'): asserts value is string {
  instant(value);
  if (new Date(value).toISOString() !== value) throw new Error(`Invalid canonical UTC ${label}`);
}

export function monitoredActionGrantDigest(grant: Pick<MonitoredActionGrant,
  'id' | 'workspaceId' | 'ownerId' | 'adapter' | 'adapterVersion' | 'connectionId' |
  'connectionGeneration' | 'browserProfileId' | 'subjectDigest' | 'scope' | 'maximumEffects' |
  'expiresAt' | 'revision'>): string {
  const scope = jsonValue(grant.scope, 'monitored action scope');
  const canonical = canonicalJson(jsonValue([
    grant.id, grant.workspaceId, grant.ownerId, grant.adapter, grant.adapterVersion,
    grant.connectionId, grant.connectionGeneration, grant.browserProfileId, grant.subjectDigest,
    scope, grant.maximumEffects, grant.expiresAt, grant.revision
  ], 'monitored action grant'));
  return createHash('sha256').update(canonical).digest('hex');
}

export function observationDigest(observation: Observation): string {
  validateObservation(observation);
  return createHash('sha256').update(canonicalJson(jsonValue(observation, 'monitor observation'))).digest('hex');
}

export function monitoredActionCommandDigest(workspaceId: string, workId: string, workRevision: number,
    grant: Pick<MonitoredActionGrant, 'id' | 'digest' | 'revision'>, command: OperationCommand): string {
  validateOperationCommand(command);
  const canonical = canonicalJson(jsonValue([workspaceId, workId, workRevision, grant.id, grant.digest,
    grant.revision, command], 'monitored action command'));
  return createHash('sha256').update(canonical).digest('hex');
}

export function validateGrant(grant: MonitoredActionGrant): void {
  exactMonitoringObject(grant, ['id', 'workspaceId', 'ownerId', 'adapter', 'adapterVersion', 'connectionId',
    'connectionGeneration', 'browserProfileId', 'subjectDigest', 'scope', 'maximumEffects', 'expiresAt',
    'createdAt', 'revision', 'digest', 'status'], ['activatedAt', 'installationGeneration', 'revokedAt',
    'revocationReason', 'reservedActionId', 'reservationAttemptId', 'reservationObservationDigest', 'settlement'],
  'monitored action grant');
  for (const [value, label] of [[grant.id, 'grantId'], [grant.workspaceId, 'workspaceId'],
    [grant.ownerId, 'ownerId'], [grant.adapter, 'adapter'], [grant.connectionId, 'connectionId'],
    [grant.browserProfileId, 'browserProfileId']] as const) identifier(value, label);
  if (!Number.isSafeInteger(grant.adapterVersion) || grant.adapterVersion < 1 ||
      !Number.isSafeInteger(grant.connectionGeneration) || grant.connectionGeneration < 1 ||
      grant.maximumEffects !== 1 || grant.revision !== 1) throw new Error('Invalid monitored action version or maximum effects');
  if (!/^[a-f0-9]{64}$/.test(grant.subjectDigest) || !/^[a-f0-9]{64}$/.test(grant.digest))
    throw new Error('Invalid monitored action digest');
  jsonValue(grant.scope, 'monitored action scope');
  canonicalInstant(grant.expiresAt, 'expiry'); canonicalInstant(grant.createdAt, 'creation time');
  if (Date.parse(grant.expiresAt) <= Date.parse(grant.createdAt)) throw new Error('Monitored action expiry must follow creation');
  if (!['pending', 'active', 'revoked', 'expired', 'consumed', 'blocked'].includes(grant.status))
    throw new Error('Invalid monitored action status');
  if (grant.digest !== monitoredActionGrantDigest(grant)) throw new Error('Monitored action digest mismatch');
  if ((grant.status === 'active' || grant.status === 'blocked' || grant.status === 'consumed') &&
      (!grant.activatedAt || !grant.installationGeneration)) throw new Error('Activated grant binding is missing');
  if (grant.activatedAt) canonicalInstant(grant.activatedAt, 'activation time');
  if (grant.installationGeneration) identifier(grant.installationGeneration, 'installationGeneration');
  if (grant.revokedAt) canonicalInstant(grant.revokedAt, 'revocation time');
  if (grant.revocationReason && !['owner_revoked', 'material_drift'].includes(grant.revocationReason))
    throw new Error('Invalid grant revocation reason');
  if (grant.reservedActionId) identifier(grant.reservedActionId, 'actionId');
  if (grant.reservationAttemptId) identifier(grant.reservationAttemptId, 'attemptId');
  if (grant.reservationObservationDigest && !/^[a-f0-9]{64}$/.test(grant.reservationObservationDigest))
    throw new Error('Invalid observation digest');
  if (grant.settlement) {
    exactObject(grant.settlement, ['actionId', 'outcome', 'settledAt'], 'grant settlement');
    identifier(grant.settlement.actionId, 'actionId'); canonicalInstant(grant.settlement.settledAt, 'settlement time');
    if (!['accepted_verified', 'accepted_unverified', 'failed', 'unknown', 'not_satisfied'].includes(grant.settlement.outcome))
      throw new Error('Invalid grant settlement');
  }
  const activated = grant.activatedAt !== undefined && grant.installationGeneration !== undefined;
  const revoked = grant.revokedAt !== undefined && grant.revocationReason !== undefined;
  const reservationFields = [grant.reservedActionId, grant.reservationAttemptId, grant.reservationObservationDigest]
    .filter(value => value !== undefined).length;
  if ((grant.activatedAt === undefined) !== (grant.installationGeneration === undefined) ||
      (grant.revokedAt === undefined) !== (grant.revocationReason === undefined) ||
      ![0, 3].includes(reservationFields)) throw new Error('Invalid monitored action provenance');
  const reserved = reservationFields === 3;
  if (grant.status === 'pending' && (activated || revoked || reserved || grant.settlement) ||
      grant.status === 'active' && (!activated || revoked || reserved || grant.settlement) ||
      grant.status === 'revoked' && (!revoked || reserved || grant.settlement) ||
      grant.status === 'expired' && (revoked || reserved || grant.settlement) ||
      grant.status === 'blocked' && (!activated || revoked ||
        (reserved ? grant.settlement?.outcome === 'accepted_verified' : grant.settlement !== undefined)) ||
      grant.status === 'consumed' && (!activated || revoked || !reserved || grant.settlement?.outcome !== 'accepted_verified'))
    throw new Error('Monitored action status provenance mismatch');
}

export function validateBinding(binding: MonitoredActionBinding): void {
  exactObject(binding, ['adapter', 'adapterVersion', 'connectionId', 'connectionGeneration',
    'browserProfileId', 'subjectDigest'], 'monitored action binding');
  identifier(binding.adapter, 'adapter'); identifier(binding.connectionId, 'connectionId');
  identifier(binding.browserProfileId, 'browserProfileId');
  if (!Number.isSafeInteger(binding.adapterVersion) || binding.adapterVersion < 1 ||
      !Number.isSafeInteger(binding.connectionGeneration) || binding.connectionGeneration < 1 ||
      !/^[a-f0-9]{64}$/.test(binding.subjectDigest)) throw new Error('Invalid monitored action binding');
}

export function bindingMatches(grant: MonitoredActionGrant, binding: MonitoredActionBinding): boolean {
  validateBinding(binding);
  return grant.adapter === binding.adapter && grant.adapterVersion === binding.adapterVersion &&
    grant.connectionId === binding.connectionId && grant.connectionGeneration === binding.connectionGeneration &&
    grant.browserProfileId === binding.browserProfileId && grant.subjectDigest === binding.subjectDigest;
}

export function validateObservation(value: unknown): asserts value is Observation {
  exactObject(value, ['observedAt', 'complete', 'coverage', 'candidates', 'result'], 'monitor observation');
  canonicalInstant(value.observedAt, 'observation time');
  if (typeof value.complete !== 'boolean' || typeof value.result !== 'string' || !OBSERVATION_RESULTS.has(value.result) ||
      !Array.isArray(value.candidates) || value.candidates.length > 1000) throw new Error('Invalid monitor observation');
  jsonValue(value.coverage, 'observation coverage');
  for (const candidate of value.candidates) jsonValue(candidate, 'observation candidate');
  if (value.result !== 'complete' && (value.complete || value.candidates.length !== 0))
    throw new Error('Non-complete observation cannot contain candidates');
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > 262144) throw new Error('Monitor observation exceeds size limit');
}

export function evaluateMonitoredAction(grant: MonitoredActionGrant, observation: Observation,
    adapter: MonitoredActionPolicyAdapter, context: {
      now: string; maxObservationAgeMs: number; connection: Connection;
    }): OperationCommand | undefined {
  validateGrant(grant); validateObservation(observation); canonicalInstant(context.now, 'evaluation time');
  if (grant.status !== 'active') throw new Error('Monitored action grant is not active');
  if (Date.parse(context.now) >= Date.parse(grant.expiresAt)) throw new Error('Monitored action grant expired');
  if (!Number.isSafeInteger(context.maxObservationAgeMs) || context.maxObservationAgeMs < 1 || context.maxObservationAgeMs > 300000)
    throw new Error('Invalid observation freshness limit');
  const age = Date.parse(context.now) - Date.parse(observation.observedAt);
  if (age < 0 || age > context.maxObservationAgeMs) throw new Error('Stale or non-fresh monitor observation');
  if (observation.result !== 'complete' || !observation.complete) throw new Error('Complete observation required');
  if (adapter.id !== grant.adapter || adapter.version !== grant.adapterVersion) throw new Error('Monitoring adapter binding mismatch');
  if (context.connection.id !== grant.connectionId || context.connection.generation !== grant.connectionGeneration ||
      context.connection.status !== 'active') throw new Error('Monitored connection binding changed');
  if (adapter.coverageSufficient(structuredClone(grant.scope), structuredClone(observation.coverage)) !== true)
    throw new Error('Observation coverage is insufficient');
  const command = adapter.selectCommand({ grant: structuredClone(grant), scope: structuredClone(grant.scope),
    observation: structuredClone(observation) });
  if (command === undefined) return undefined;
  validateOperationCommand(command);
  if (command.operationId !== grant.adapter || command.operationVersion !== String(grant.adapterVersion) ||
      command.connectionId !== grant.connectionId || command.connectionGeneration !== grant.connectionGeneration ||
      command.provider !== context.connection.provider || command.subject !== context.connection.subject ||
      command.precondition.observedAt !== observation.observedAt)
    throw new Error('Selected command violates monitored action binding');
  return structuredClone(command);
}

export function validateDigest(value: unknown, label: string): asserts value is string {
  nonempty(value, label);
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error(`Invalid ${label}`);
}

export function exactMonitoringObject(value: unknown, requiredKeys: readonly string[], optionalKeys: readonly string[],
    label: string): asserts value is Record<string, unknown> {
  exactObject(value, [...requiredKeys, ...optionalKeys], label);
  for (const key of requiredKeys) if (!Object.hasOwn(value, key)) throw new Error(`Missing ${label} field: ${key}`);
}
