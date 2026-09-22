import type { Action, WorkPhase } from '../kernel/types.js';
import type { Connection, OperationCommand, VerificationState } from '../operations/types.js';
import type { ServiceJobKind, ServiceJobStatus, ServiceQueueCounts, ServiceReceipt,
  ServiceStopReason } from '../storage/service-jobs.js';
import type { ServiceRuntimeSnapshot } from '../runtime/service-runtime.js';
import type { PrivateConnectionDisconnectResult, PrivateConnectionSummary } from '../connections/private-connection.js';
import type { UsVisaChinaReadiness } from '../adapters/us-visa-china/types.js';

export interface ControlBinding {
  readonly workspaceId: string;
  readonly ownerId: string;
}
export interface ControlPrincipal extends ControlBinding {
  readonly instanceId: string;
  readonly sessionId: string;
}
export interface ControlBootstrap {
  version: 1;
  origin: string;
  token: string;
  expiresAt: string;
}
export interface ControlSession {
  token: string;
  expiresAt: string;
  idleExpiresAt: string;
}
export type ControlErrorCode =
  | 'invalid_request' | 'unauthenticated' | 'forbidden'
  | 'not_found' | 'conflict' | 'rate_limited' | 'unavailable';

const ERROR_MESSAGES: Record<ControlErrorCode, string> = {
  invalid_request: 'Invalid request.',
  unauthenticated: 'Authentication required.',
  forbidden: 'Request forbidden.',
  not_found: 'Resource not found.',
  conflict: 'Request conflicts with current state.',
  rate_limited: 'Too many attempts.',
  unavailable: 'Local owner control unavailable.'
};

export class OwnerControlError extends Error {
  readonly code: ControlErrorCode;
  constructor(code: ControlErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = 'OwnerControlError';
    this.code = code;
  }
}
export interface ControlActionSummary {
  actionId: string;
  workId: string;
  workTitle: string;
  workRevision: number;
  currentWorkRevision: number;
  phase: WorkPhase;
  status: Action['status'];
  digest: string;
  approvalExpiresAt: string | null;
  synthetic: true;
}
export interface ControlActionPage {
  workspaceId: string;
  items: ControlActionSummary[];
  nextAfter: string | null;
}
export interface ControlReview {
  action: ControlActionSummary;
  command: OperationCommand;
  connection: Connection | null;
  reviewToken: string;
  reviewExpiresAt: string;
  approvalExpiresAt: string | null;
  canApprove: boolean;
  canCancel: boolean;
}
export interface ControlDecisionInput {
  reviewToken: string;
  digest: string;
}

export interface ControlServiceActionSummary extends ControlActionSummary {
  outcome: { status: Action['status']; evidenceRef: string | null };
  verification: { status: VerificationState['status']; recordedAt: string; evidenceRef: string | null } | null;
}

export interface ControlServiceActionPage {
  workspaceId: string;
  items: ControlServiceActionSummary[];
  nextAfter: string | null;
}

export interface ControlExecutionReview extends Omit<ControlReview, 'action'> {
  action: ControlServiceActionSummary;
  executionToken?: string;
  executionExpiresAt?: string;
  canExecute: boolean;
}

export interface ControlAdmission {
  receipt: ServiceReceipt;
  job: ControlJobSummary;
  duplicate: boolean;
}

export interface ControlJobSummary {
  id: string;
  position: number;
  requestId: string;
  kind: ServiceJobKind;
  status: ServiceJobStatus;
  admittedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  focus: { threadId: string; workId: string | null } | null;
  actionId: string | null;
  resultReason: ServiceStopReason | null;
}

export interface ControlJobResult {
  reason: ServiceStopReason;
  conversation?: { threadId: string; ownerText: string; assistantText: string };
  works?: Array<{ id: string; title: string; goal: string; phase: 'open' }>;
  action?: {
    actionId: string;
    outcome: { status: Action['status']; evidenceRef: string | null; evidence: string | null };
    verification: { status: VerificationState['status']; recordedAt: string;
      evidenceRef: string | null; evidence: string | null } | null;
  };
  reminder?: ControlReminderSummary;
}

export interface ControlJobDetail extends ControlJobSummary {
  result: ControlJobResult | null;
}

export interface ControlJobPage { items: ControlJobSummary[]; nextAfter: number | null }

export interface ControlReminderSummary {
  timerId: string;
  /** Both null when the timer has no owner-service scheduling receipt. */
  requestId: string | null;
  admittedAt: string | null;
  work: { id: string; title: string };
  dueAt: string;
  status: 'scheduled' | 'fired' | 'cancelled';
}

export interface ControlReminderPage { items: ControlReminderSummary[]; nextAfter: number | null }

export interface ControlServiceStatus {
  lifecycle: 'running' | 'stopping' | 'faulted';
  databaseMode: 'plaintext' | 'encrypted';
  model: { configured: boolean; selection: { provider: string; model: string } | null };
  queue: ServiceQueueCounts;
  runtime: ServiceRuntimeSnapshot;
  unresolvedActionIds: string[];
  unresolvedActions: Array<{ actionId: string; status: Action['status'];
    kind: 'active_execution' | 'crash_preserved_execution' | 'unknown_outcome' | 'accepted_unverified' }>;
  connections: PrivateConnectionSummary[];
  monitoredAdapters: UsVisaChinaReadiness[];
  limits: { foreground: true; awakeOnly: true; supervised: false };
}

export interface ServiceControlAdapter {
  list(principal: ControlPrincipal, after?: string): ControlServiceActionPage;
  review(principal: ControlPrincipal, actionId: string): ControlExecutionReview;
  approve(principal: ControlPrincipal, actionId: string, input: ControlDecisionInput): ControlServiceActionSummary;
  cancel(principal: ControlPrincipal, actionId: string, input: ControlDecisionInput): ControlServiceActionSummary;
  logout(principal: ControlPrincipal): void;
  status(principal: ControlPrincipal): ControlServiceStatus;
  jobs(principal: ControlPrincipal, after?: number): ControlJobPage;
  job(principal: ControlPrincipal, jobId: string): ControlJobDetail;
  reminders(principal: ControlPrincipal, after?: number): ControlReminderPage;
  chat(principal: ControlPrincipal, input: unknown): ControlAdmission;
  reminder(principal: ControlPrincipal, input: unknown): { receipt: ServiceReceipt; duplicate: boolean };
  execute(principal: ControlPrincipal, actionId: string, input: unknown): ControlAdmission;
  readback(principal: ControlPrincipal, actionId: string, input: unknown): ControlAdmission;
  disconnectConnection(principal: ControlPrincipal, connectionId: string, input: unknown):
    Promise<PrivateConnectionDisconnectResult>;
}
