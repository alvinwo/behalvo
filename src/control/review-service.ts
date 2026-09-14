import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { State, WorkItem } from '../kernel/types.js';
import { identifier } from '../kernel/types.js';
import { commandDigest } from '../kernel/policy.js';
import type { SqliteStore } from '../storage/sqlite-store.js';
import type { Operator } from '../runtime/operator.js';
import type { OperationService } from '../operations/service.js';
import type { OperationAction } from '../operations/types.js';
import { isOperationCommand, validateOperationCommand } from '../operations/validation.js';
import type { OwnerControlSessions } from './session.js';
import type {
  ControlBinding, ControlPrincipal, ControlActionPage, ControlActionSummary,
  ControlReview, ControlDecisionInput
} from './types.js';
import { OwnerControlError } from './types.js';

const REVIEW_TTL = 2 * 60_000;
const APPROVAL_TTL = 10 * 60_000;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const CANCELLATION_REASON = 'Cancelled through authenticated local owner control.';

type ReceiptStatus = 'pending' | 'reserved';
interface ReviewReceipt {
  readonly key: string;
  readonly principal: ControlPrincipal;
  readonly instanceId: string;
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly ownerId: string;
  readonly actionId: string;
  readonly workId: string;
  readonly workRevision: number;
  readonly actionDigest: string;
  readonly tokenDigest: Buffer;
  readonly deadline: number;
  readonly approvalExpiresAt: string | null;
  status: ReceiptStatus;
}

export interface OwnerControlServiceOptions {
  store: SqliteStore;
  operator: Operator;
  operations: OperationService;
  sessions: OwnerControlSessions;
  binding: ControlBinding;
  clock?: () => number;
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'ascii').digest();
}

function matches(left: Buffer, right: Buffer): boolean {
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}

function actionIdentifier(value: unknown): asserts value is string {
  try { identifier(value, 'actionId'); } catch { throw new OwnerControlError('invalid_request'); }
}

function decisionInput(input: unknown): asserts input is ControlDecisionInput {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
    (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null) ||
    Object.keys(input).length !== 2 || !Object.hasOwn(input, 'reviewToken') || !Object.hasOwn(input, 'digest') ||
    typeof (input as ControlDecisionInput).reviewToken !== 'string' ||
    !TOKEN_PATTERN.test((input as ControlDecisionInput).reviewToken) ||
    typeof (input as ControlDecisionInput).digest !== 'string' ||
    !DIGEST_PATTERN.test((input as ControlDecisionInput).digest))
    throw new OwnerControlError('invalid_request');
}

function supportedAction(action: State['actions'][string] | undefined): OperationAction | undefined {
  if (!action || !isOperationCommand(action.command)) return undefined;
  try { validateOperationCommand(action.command); } catch { return undefined; }
  if (action.command.provider !== 'synthetic-accounts' || action.command.operationVersion !== '1' ||
    !['contact.update', 'subscription.cancel'].includes(action.command.operationId)) return undefined;
  return action as OperationAction;
}

function isRecognizedMutationConflict(error: unknown): boolean {
  return error instanceof Error && error.message === 'Stream version conflict';
}

export class OwnerControlService {
  readonly #store: SqliteStore;
  readonly #operator: Operator;
  readonly #operations: OperationService;
  readonly #sessions: OwnerControlSessions;
  readonly #binding: ControlBinding;
  readonly #clock: () => number;
  readonly #receipts = new Map<string, ReviewReceipt>();
  #closed = false;

  constructor(options: OwnerControlServiceOptions) {
    this.#store = options.store;
    this.#operator = options.operator;
    this.#operations = options.operations;
    this.#sessions = options.sessions;
    this.#binding = Object.freeze({ ...options.binding });
    this.#clock = options.clock ?? Date.now;
  }

  list(principal: ControlPrincipal, after?: string): ControlActionPage {
    const state = this.#state(principal);
    if (after !== undefined) actionIdentifier(after);
    const available = Object.values(state.actions)
      .filter((candidate): candidate is OperationAction => {
        const action = supportedAction(candidate);
        return action !== undefined && Object.hasOwn(state.works, action.workId) && this.#digestCurrent(state, action);
      })
      .filter(action => after === undefined || action.id > after)
      .sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
    const hasMore = available.length > 100;
    const selected = available.slice(0, 100);
    return {
      workspaceId: this.#binding.workspaceId,
      items: selected.map(action => this.#summary(state, action)),
      nextAfter: hasMore ? selected[selected.length - 1]!.id : null
    };
  }

  review(principal: ControlPrincipal, actionId: string): ControlReview {
    const state = this.#state(principal);
    const action = this.#action(state, actionId);
    const now = this.#now();
    this.#prune(now);
    const key = this.#receiptKey(principal, action.id);
    this.#deleteReceipt(key);
    if (this.#receipts.size >= 100) throw new OwnerControlError('rate_limited');
    const canApprove = this.#approvable(state, action);
    const canCancel = this.#cancellable(state, action);
    const approvalExpiresAt = action.approval?.expiresAt ??
      (canApprove ? new Date(now + APPROVAL_TTL).toISOString() : null);
    const reviewToken = randomBytes(32).toString('base64url');
    const deadline = now + REVIEW_TTL;
    const receipt: ReviewReceipt = {
      key, principal, instanceId: principal.instanceId, sessionId: principal.sessionId,
      workspaceId: principal.workspaceId, ownerId: principal.ownerId,
      actionId: action.id, workId: action.workId, workRevision: action.workRevision,
      actionDigest: action.digest, tokenDigest: digest(reviewToken), deadline,
      approvalExpiresAt, status: 'pending'
    };
    this.#receipts.set(key, receipt);
    return {
      action: this.#summary(state, action, approvalExpiresAt),
      command: structuredClone(action.command),
      connection: state.connections[action.command.connectionId]
        ? structuredClone(state.connections[action.command.connectionId]!) : null,
      reviewToken,
      reviewExpiresAt: new Date(deadline).toISOString(),
      approvalExpiresAt,
      canApprove,
      canCancel
    };
  }

  approve(principal: ControlPrincipal, actionId: string, input: ControlDecisionInput): ControlActionSummary {
    return this.#decide(principal, actionId, input, 'approve');
  }

  cancel(principal: ControlPrincipal, actionId: string, input: ControlDecisionInput): ControlActionSummary {
    return this.#decide(principal, actionId, input, 'cancel');
  }

  logout(principal: ControlPrincipal): void {
    this.#assertPrincipal(principal);
    for (const [key, receipt] of this.#receipts) {
      if (receipt.principal === principal) this.#deleteReceipt(key);
    }
    this.#sessions.logout(principal);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const key of [...this.#receipts.keys()]) this.#deleteReceipt(key);
    this.#sessions.close();
  }

  #decide(principal: ControlPrincipal, actionId: string, input: ControlDecisionInput,
    kind: 'approve' | 'cancel'): ControlActionSummary {
    this.#assertPrincipal(principal);
    actionIdentifier(actionId);
    decisionInput(input);
    const key = this.#receiptKey(principal, actionId);
    const receipt = this.#receipts.get(key);
    const supplied = digest(input.reviewToken);
    if (!receipt || receipt.status !== 'pending' || !matches(supplied, receipt.tokenDigest) ||
      input.digest !== receipt.actionDigest || receipt.principal !== principal ||
      receipt.instanceId !== principal.instanceId || receipt.sessionId !== principal.sessionId ||
      receipt.workspaceId !== this.#binding.workspaceId || receipt.ownerId !== this.#binding.ownerId ||
      this.#now() >= receipt.deadline) {
      if (receipt && this.#now() >= receipt.deadline) this.#deleteReceipt(key);
      throw new OwnerControlError('conflict');
    }
    receipt.status = 'reserved';
    try {
      const guard = (): void => this.#guard(principal, receipt, kind);
      guard();
      if (kind === 'approve') {
        if (receipt.approvalExpiresAt === null) throw new OwnerControlError('conflict');
        this.#operations.approveBatch({
          workspaceId: this.#binding.workspaceId,
          ownerId: this.#binding.ownerId,
          expiresAt: receipt.approvalExpiresAt,
          approvals: [{ actionId, digest: receipt.actionDigest }]
        }, guard);
      } else {
        this.#operator.cancelAction(this.#binding.workspaceId, this.#binding.ownerId,
          actionId, CANCELLATION_REASON, guard);
      }
      const latest = this.#store.state(this.#binding.workspaceId);
      return this.#summary(latest, this.#action(latest, actionId));
    } catch (error) {
      if (error instanceof OwnerControlError) throw error;
      if (isRecognizedMutationConflict(error)) throw new OwnerControlError('conflict');
      throw error;
    } finally {
      this.#deleteReceipt(key, receipt);
    }
  }

  #guard(principal: ControlPrincipal, receipt: ReviewReceipt, kind: 'approve' | 'cancel'): void {
    this.#assertPrincipal(principal);
    const now = this.#now();
    if (this.#receipts.get(receipt.key) !== receipt || receipt.status !== 'reserved' || now >= receipt.deadline)
      throw new OwnerControlError('conflict');
    const state = this.#boundState();
    const action = this.#action(state, receipt.actionId);
    if (action.workId !== receipt.workId || action.workRevision !== receipt.workRevision ||
      action.digest !== receipt.actionDigest || !this.#digestCurrent(state, action))
      throw new OwnerControlError('conflict');
    if (kind === 'approve') {
      if (receipt.approvalExpiresAt === null || Date.parse(receipt.approvalExpiresAt) <= now || !this.#approvable(state, action))
        throw new OwnerControlError('conflict');
    } else if (!this.#cancellable(state, action)) {
      throw new OwnerControlError('conflict');
    }
  }

  #state(principal: ControlPrincipal): State {
    this.#assertPrincipal(principal);
    return this.#boundState();
  }

  #boundState(): State {
    let state: State;
    try { state = this.#store.state(this.#binding.workspaceId); }
    catch { throw new OwnerControlError('unavailable'); }
    if (state.ownerId !== this.#binding.ownerId) throw new OwnerControlError('forbidden');
    return state;
  }

  #assertPrincipal(principal: ControlPrincipal): void {
    if (this.#closed) throw new OwnerControlError('unavailable');
    this.#sessions.assertActive(principal);
    if (principal.workspaceId !== this.#binding.workspaceId || principal.ownerId !== this.#binding.ownerId ||
      principal.instanceId !== this.#sessions.instanceId) throw new OwnerControlError('forbidden');
  }

  #action(state: State, actionId: string): OperationAction {
    actionIdentifier(actionId);
    const action = supportedAction(state.actions[actionId]);
    if (!action || !Object.hasOwn(state.works, action.workId)) throw new OwnerControlError('not_found');
    return action;
  }

  #summary(state: State, action: OperationAction, approvalExpiresAt = action.approval?.expiresAt ?? null): ControlActionSummary {
    const work = state.works[action.workId];
    if (!work) throw new OwnerControlError('not_found');
    return {
      actionId: action.id, workId: action.workId, workTitle: work.title,
      workRevision: action.workRevision, currentWorkRevision: work.revision,
      phase: work.phase, status: action.status, digest: action.digest,
      approvalExpiresAt, synthetic: true
    };
  }

  #digestCurrent(state: State, action: OperationAction): boolean {
    try {
      return action.digest === commandDigest(state.workspaceId, action.workId, action.workRevision, action.command);
    } catch { return false; }
  }

  #approvable(state: State, action: OperationAction): boolean {
    const work: WorkItem | undefined = state.works[action.workId];
    const connection = state.connections[action.command.connectionId];
    return action.status === 'proposed' && work !== undefined && work.revision === action.workRevision &&
      !['done', 'cancelled'].includes(work.phase) && this.#digestCurrent(state, action) && connection !== undefined &&
      connection.status === 'active' && connection.provider === action.command.provider &&
      connection.subject === action.command.subject && connection.generation === action.command.connectionGeneration;
  }

  #cancellable(state: State, action: OperationAction): boolean {
    return ['proposed', 'approved'].includes(action.status) && this.#digestCurrent(state, action);
  }

  #receiptKey(principal: ControlPrincipal, actionId: string): string {
    return `${principal.sessionId}\u0000${actionId}`;
  }

  #prune(now: number): void {
    for (const [key, receipt] of this.#receipts) {
      if (receipt.deadline <= now) this.#deleteReceipt(key);
    }
  }

  #deleteReceipt(key: string, expected?: ReviewReceipt): void {
    const receipt = this.#receipts.get(key);
    if (!receipt || (expected !== undefined && receipt !== expected)) return;
    this.#receipts.delete(key);
    receipt.tokenDigest.fill(0);
  }

  #now(): number {
    const value = this.#clock();
    if (!Number.isFinite(value)) throw new OwnerControlError('unavailable');
    return value;
  }
}
