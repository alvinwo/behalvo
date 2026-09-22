import type { DomainEvent, JournalRecord, RecordMetadata } from '../kernel/types.js';

export type ServiceJobKind = 'owner_turn' | 'execute' | 'readback' | 'reminder' | 'monitor';
export type ServiceJobStatus = 'queued' | 'running' | 'finished' | 'stopped' | 'interrupted';
export type ServiceStopReason = 'completed' | 'prepared_for_review' | 'model_unavailable'
  | 'invalid_model_result' | 'deadline' | 'cancelled' | 'action_ineligible'
  | 'action_failed' | 'action_unknown' | 'readback_unresolved' | 'process_interrupted'
  | 'monitor_observed' | 'monitor_paused' | 'monitor_terminal';
export type ServiceEnvelope =
  | { kind: 'owner_turn'; threadId: string; workId?: string; text: string }
  | { kind: 'execute' | 'readback'; actionId: string; digest: string }
  | { kind: 'schedule_reminder'; workId: string; dueAt: string }
  | { kind: 'reminder'; timerId: string; workId: string }
  | { kind: 'monitor'; monitorId: string; grantId: string; dueAt: string };
export type ServiceJobParameters =
  | { kind: 'owner_turn'; ownerRecordId: string; threadId: string; workId?: string;
      model: { provider: string; model: string }; windowTokens: number;
      outputReserve: number; capability: 'prepare_only' }
  | { kind: 'execute' | 'readback'; actionId: string; digest: string }
  | { kind: 'reminder'; timerId: string; workId: string; timerRecordId: string }
  | { kind: 'monitor'; monitorId: string; grantId: string; dueAt: string; pollRecordId: string };
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
export interface CompleteOwnerTurnResult { job: ServiceJob; records: JournalRecord[] }
