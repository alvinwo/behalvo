import type { Action } from '../kernel/types.js';
import type { TrustedExecutionFence } from '../operations/execution-context.js';
import type { Connection, JsonValue, OperationCommand } from '../operations/types.js';
import type { BrowserEpoch } from '../browser/types.js';

export type MonitoredActionGrantStatus =
  | 'pending' | 'active' | 'revoked' | 'expired' | 'consumed' | 'blocked';

export interface MonitoredArmPlanV1 {
  version: 1;
  fixtureId: 'visa-beijing-group-v1';
  monitorId: string;
  workId: string;
  workRevision: number;
  termsVersion: 'terms-1';
  polling: {
    maxObservationAgeMs: 60_000;
    intervalMs: 2_000;
    jitterMs: 250;
    requestBudget: 30;
    requestWindowMs: 60_000;
    backoffBaseMs: 2_000;
    backoffMaxMs: 60_000;
  };
  stopPolicy: 'synthetic-visa-one-effect-v1';
}

export interface MonitoredActionGrant {
  id: string;
  workspaceId: string;
  ownerId: string;
  adapter: string;
  adapterVersion: number;
  connectionId: string;
  connectionGeneration: number;
  browserProfileId: string;
  subjectDigest: string;
  scope: JsonValue;
  maximumEffects: 1;
  expiresAt: string;
  createdAt: string;
  revision: number;
  digest: string;
  status: MonitoredActionGrantStatus;
  armPlan?: MonitoredArmPlanV1;
  activatedAt?: string;
  installationGeneration?: string;
  revokedAt?: string;
  revocationReason?: 'owner_revoked' | 'material_drift';
  reservedActionId?: string;
  reservationAttemptId?: string;
  reservationObservationDigest?: string;
  settlement?: MonitoredGrantSettlement;
}

export type MonitoredGrantSettlementOutcome =
  | 'accepted_verified' | 'accepted_unverified' | 'failed' | 'unknown' | 'not_satisfied';

export interface MonitoredGrantSettlement {
  actionId: string;
  outcome: MonitoredGrantSettlementOutcome;
  settledAt: string;
}

export interface MonitoredActionBinding {
  adapter: string;
  adapterVersion: number;
  connectionId: string;
  connectionGeneration: number;
  browserProfileId: string;
  subjectDigest: string;
}

export interface MonitorResumeEvidence {
  observedAt: string;
  identityDigest: string;
  subjectDigest: string;
  rosterDigest: string;
  termsDigest: string;
  termsVersion: string;
  appointmentAbsent: true;
  pageState: 'calendar';
  evidenceDigest: string;
}

export type ObservationResult = 'complete' | 'session_expired' | 'needs_human' |
  'rate_limited' | 'provider_unavailable' | 'contract_changed';

export interface Observation<Candidate extends JsonValue = JsonValue> {
  observedAt: string;
  complete: boolean;
  coverage: JsonValue;
  candidates: Candidate[];
  result: ObservationResult;
}

export interface MonitoredActionPolicyAdapter {
  readonly id: string;
  readonly version: number;
  validateScope(value: unknown): JsonValue;
  coverageSufficient(scope: Readonly<JsonValue>, coverage: Readonly<JsonValue>): boolean;
  selectCommand(input: {
    grant: Readonly<MonitoredActionGrant>;
    scope: Readonly<JsonValue>;
    observation: Readonly<Observation>;
  }): OperationCommand | undefined;
  inspect?(input: {
    monitor: Readonly<MonitorState>;
    grant: Readonly<MonitoredActionGrant>;
    connection: Readonly<Connection>;
    fence: TrustedExecutionFence;
  }): Promise<Observation>;
  executeReserved?(input: { action: Readonly<MonitoredAction>; grant: Readonly<MonitoredActionGrant>;
    connection: Readonly<Connection>; fence: TrustedExecutionFence; intentId: string;
    recordConfirmation(receipt: JsonValue): Promise<void> }):
    Promise<MonitoredExecutionResult>;
  verifyReserved?(input: { action: Readonly<MonitoredAction>; grant: Readonly<MonitoredActionGrant>;
    connection: Readonly<Connection>; fence: TrustedExecutionFence }): Promise<MonitoredVerificationResult>;
}

export type MonitoredExecutionResult =
  | { status: 'accepted'; receipt: JsonValue }
  | { status: 'failed'; reason: 'contract_changed' }
  | { status: 'unknown'; verificationOnly: true };
export type MonitoredVerificationResult =
  | { status: 'satisfied'; receipt: JsonValue }
  | { status: 'unknown' };

export interface MonitorSpec {
  id: string;
  workspaceId: string;
  grantId: string;
  workId: string;
  adapter: string;
  adapterVersion: number;
  connectionId: string;
  connectionGeneration: number;
  browserProfileId: string;
  subjectDigest: string;
  maxObservationAgeMs: number;
  intervalMs: number;
  jitterMs: number;
  requestBudget: number;
  requestWindowMs: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
}

export type MonitorPauseReason = 'session_expired' | 'needs_human' | 'rate_limited' |
  'contract_changed' | 'installation_changed' | 'grant_unavailable' | 'owner_paused' | 'owner_takeover';

export interface MonitorControlV1 {
  version: 1;
  revision: number;
  handoff: null | { id: string; state: 'pending' | 'confirmed' | 'failed'; binding: BrowserEpoch & { tabId: number } };
  resume: null | { jobId: string; candidate: null | (BrowserEpoch & { tabId: number }) };
}

export interface MonitorObservationSummary {
  observedAt: string;
  complete: boolean;
  coverage: JsonValue;
  result: ObservationResult;
}

export interface MonitorState extends MonitorSpec {
  status: 'active' | 'paused' | 'stopped';
  nextDueAt: string | null;
  requestWindowStartedAt: string;
  requestsInWindow: number;
  lastObservation: MonitorObservationSummary | null;
  lastCompleteObservationAt: string | null;
  lastCompleteCoverage: JsonValue | null;
  consecutiveFailures: number;
  backoffMs: number;
  pauseReason: MonitorPauseReason | null;
  inFlightJobId: string | null;
  control?: MonitorControlV1;
}

export interface MonitoredActionReference {
  id: string;
  digest: string;
  revision: number;
}

export type MonitoredAction = Action & { monitoredGrant: MonitoredActionReference };
