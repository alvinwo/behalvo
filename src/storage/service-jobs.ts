import type { Action, DomainEvent, JournalRecord, RecordMetadata } from '../kernel/types.js';
import type { Observation } from '../monitoring/types.js';

export type ServiceJobKind = 'owner_turn' | 'execute' | 'readback' | 'reminder' | 'monitor';
export type ServiceJobStatus = 'queued' | 'running' | 'finished' | 'stopped' | 'interrupted';
export type ServiceStopReason = 'completed' | 'prepared_for_review' | 'model_unavailable'
  | 'invalid_model_result' | 'deadline' | 'cancelled' | 'action_ineligible'
  | 'action_failed' | 'action_unknown' | 'readback_unresolved' | 'process_interrupted'
  | 'monitor_observed' | 'monitor_paused' | 'monitor_terminal' | 'monitor_resumed' | 'monitor_resume_rejected';
export interface ScheduledMonitorExecutionBinding {
  monitorId: string;
  monitorJobId: string;
  grantId: string;
  grantDigest: string;
  grantRevision: number;
  adapter: string;
  adapterVersion: number;
  connectionId: string;
  connectionGeneration: number;
  browserProfileId: string;
  subjectDigest: string;
  installationGeneration: string;
  workId: string;
  workRevision: number;
  attemptId: string;
  observationDigest: string;
  observedAt: string;
}
export type ServiceEnvelope =
  | { kind: 'owner_turn'; threadId: string; workId?: string; text: string }
  | { kind: 'execute'; actionId: string; digest: string; scheduledMonitor?: ScheduledMonitorExecutionBinding }
  | { kind: 'readback'; actionId: string; digest: string }
  | { kind: 'schedule_reminder'; workId: string; dueAt: string }
  | { kind: 'reminder'; timerId: string; workId: string }
  | { kind: 'monitor'; purpose?: 'observe'; monitorId: string; grantId: string; dueAt: string }
  | { kind: 'monitor'; purpose: 'resume'; monitorId: string; grantId: string; digest: string;
      revision: number; controlRevision: number; recoverHandoff: boolean }
  | { kind: 'monitoring_setup'; fixtureId: 'visa-beijing-group-v1' }
  | { kind: 'monitoring_propose'; fixtureId: 'visa-beijing-group-v1' }
  | { kind: 'monitoring_arm'; grantId: string; digest: string; revision: number }
  | { kind: 'monitoring_revoke'; grantId: string; digest: string; revision: number }
  | { kind: 'monitoring_pause'; grantId: string; monitorId: string; digest: string; revision: number; controlRevision: number }
  | { kind: 'monitoring_takeover'; grantId: string; monitorId: string; digest: string; revision: number; controlRevision: number }
  | { kind: 'monitoring_stop'; grantId: string; monitorId: string; digest: string; revision: number; controlRevision: number };
export type ServiceJobParameters =
  | { kind: 'owner_turn'; ownerRecordId: string; threadId: string; workId?: string;
      model: { provider: string; model: string }; windowTokens: number;
      outputReserve: number; capability: 'prepare_only' }
  | { kind: 'execute' | 'readback'; actionId: string; digest: string }
  | { kind: 'reminder'; timerId: string; workId: string; timerRecordId: string }
  | { kind: 'monitor'; purpose?: 'observe'; monitorId: string; grantId: string; dueAt: string; pollRecordId: string }
  | { kind: 'monitor'; purpose: 'resume'; monitorId: string; grantId: string; digest: string;
      revision: number; controlRevision: number; recoverHandoff: boolean; resumeRecordId: string;
      serviceGeneration: string; installationGeneration: string; workRevision: number };
export interface ServiceRequestIdentity {
  workspaceId: string;
  source: string;
  requestId: string;
}
export interface ServiceReceipt extends ServiceRequestIdentity {
  id: string;
  kind: ServiceEnvelope['kind'];
  admittedAt: string;
  jobId?: string;
  timerId?: string;
  monitoring?: {
    fixtureId?: 'visa-beijing-group-v1';
    connectionId?: string;
    workId?: string;
    grantId?: string;
    monitorId?: string;
    recordIds: string[];
  };
}
export interface ServiceJobClaim { jobId: string; claimId: string; instanceId: string }
export interface ServiceJobResult {
  reason: ServiceStopReason;
  recordIds: string[];
  assistantRecordId?: string;
  actionId?: string;
  attemptId?: string;
  actionRecordId?: string;
  verificationRecordId?: string;
  timerId?: string;
}
export interface ServiceJob {
  id: string;
  workspaceId: string;
  receiptId: string;
  position: number;
  kind: ServiceJobKind;
  status: ServiceJobStatus;
  admittedAt: string;
  admittedBy: string;
  parameters: ServiceJobParameters;
  startedAt?: string;
  finishedAt?: string;
  claim?: ServiceJobClaim;
  attemptId?: string;
  /** Historical action.finished record bound when an explicit readback is claimed. */
  actionRecordId?: string;
  /** Exact trusted verification durably associated with this service claim. */
  verificationRecordId?: string;
  result?: ServiceJobResult;
}
export interface ServiceJobPage { items: ServiceJob[]; nextAfter: number | null }
export interface ServiceReminderRequest {
  position: number;
  /** Null for journaled timers without an owner-service scheduling receipt. */
  receipt: ServiceReceipt | null;
  timerId: string;
  workId: string;
  dueAt: string;
}
export interface ServiceReminderRequestPage { items: ServiceReminderRequest[]; nextAfter: number | null }
export interface ServiceQueueCounts {
  queued: number;
  running: number;
  finished: number;
  stopped: number;
  interrupted: number;
  oldestQueuedAt: string | null;
  activeJobId: string | null;
}

export class ServiceStorageError extends Error {
  readonly code: 'conflict' | 'full' | 'invalid' | 'integrity';
  constructor(code: ServiceStorageError['code'], message: string) {
    super(message);
    this.name = 'ServiceStorageError';
    this.code = code;
  }
}

/** Runtime-only classification for faults that make further trusted persistence unsafe. */
export function isFatalServiceStorageError(error: unknown): boolean {
  if (error instanceof ServiceStorageError) return error.code === 'integrity';
  if (!(error instanceof Error)) return false;
  const code = (error as Error & { code?: unknown }).code;
  if (typeof code === 'string' && (code.startsWith('SQLITE_') || code.startsWith('ERR_SQLITE'))) return true;
  return error.message === 'Unable to open encrypted payload.' ||
    error.message === 'Unable to seal encrypted payload.' ||
    error.message === 'Unable to create lookup token.' ||
    error.message === 'Invalid storage format or encryption key.';
}

// These aliases keep the public store signatures close to the durable contract.
export interface CompleteOwnerTurnInput {
  ownerRecordId: string;
  expectedVersion: number;
  events: DomainEvent[];
  reply: { text: string; source: 'agent:model' | 'agent:application'; externalId: string; threadId: string };
  status: 'finished' | 'stopped';
  reason: ServiceStopReason;
  at: string;
}
export interface StartActionAttemptInput {
  workspaceId: string;
  expectedVersion: number;
  actionId: string;
  attemptId: string;
  metadata?: RecordMetadata;
  beforeAppend?: () => void;
  claim?: ServiceJobClaim;
}
export interface CompleteMonitorJobAndAdmitActionInput {
  expectedVersion: number;
  event: Extract<DomainEvent, { type: 'monitor.observation_recorded' }>;
  observation: Observation;
  action: Action;
  attemptId: string;
  observationDigest: string;
  binding: Omit<ScheduledMonitorExecutionBinding, 'monitorJobId' | 'attemptId' | 'observationDigest' | 'observedAt'>;
  maxObservationAgeMs: number;
  at: string;
}
export interface CompleteMonitorJobAndAdmitActionResult {
  monitorJob: ServiceJob;
  receipt: ServiceReceipt;
  job: ServiceJob;
  action: Action;
  duplicate: boolean;
}
export interface CompleteOwnerTurnResult { job: ServiceJob; records: JournalRecord[] }
