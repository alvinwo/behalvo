import type { Action, WorkPhase } from '../kernel/types.js';
import type { Connection, OperationCommand } from '../operations/types.js';

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
