import { randomUUID } from 'node:crypto';
import { BrowserDiagnosticError, BrowserNoDispatchError, type BrowserStoppedResult, type BrowserActionDiagnostic } from '../browser/live-failure.js';
import { assertNoUnknownBrowserAction, isBrowserActionCommand, validateBrowserActionCommand, type BrowserActionCommand } from '../kernel/browser-action.js';
import { commandDigest } from '../kernel/policy.js';
import { assertTeachingClear } from '../kernel/teachings.js';
import type { Action } from '../kernel/types.js';
import { assertExecutionActive, withinExecution, type OperationExecutionContext } from '../operations/execution-context.js';
import type { SqliteStore } from '../storage/sqlite-store.js';
import { assertBrowserWork } from './browser-learning.js';
import type { TeachingBinding } from './teachings.js';
import { Operator } from './operator.js';

export type BrowserReview = 'approve' | 'reject' | 'handoff';
export interface BrowserGestureExecution<T> {
    review(action: Action, signal?: AbortSignal): Promise<BrowserReview>;
    /** Async current DOM check; executed again after owner review. */
    validate(): Promise<void>;
    /** Synchronous lease/document guard immediately before dispatch. */
    assertCurrent?(): void;
    dispatch(markDispatch:()=>void): Promise<T>;
}
export type BrowserGestureResult<T> = { actionId: string; status:'accepted'; observation:T } |
    BrowserStoppedResult;

/** The model cannot approve; this broker receives a trusted controller authorization callback. */
export class BrowserActionBroker {
    constructor(private readonly store: SqliteStore) {}
    /** Caller holds the database process lock after stopping all effect workers. Never dispatches. */
    recoverInterrupted(workspaceId:string,exclusiveMaintenance:boolean):number {
        if(exclusiveMaintenance!==true)throw new Error('Exclusive maintenance required');
        const actions=Object.values(this.store.state(workspaceId).actions).filter(a=>a.status==='running'&&isBrowserActionCommand(a.command));
        let recovered=0;
        for(const action of actions)if(this.store.finishActionAttempt(workspaceId,action.id,action.attemptId!,'unknown',
            JSON.stringify({explanation:'Interrupted browser execution; outcome unknown. Exclusive-maintenance recovery never retries an action.',diagnostic:{phase:'dispatch',code:'dispatch_unconfirmed'}})))recovered++;
        return recovered;
    }
    async perform<T>(binding: TeachingBinding, command: BrowserActionCommand, execution: OperationExecutionContext,
        gesture: BrowserGestureExecution<T>): Promise<BrowserGestureResult<T>> {
        validateBrowserActionCommand(command);
        const check=()=>{
            assertExecutionActive(execution);const state=assertBrowserWork(this.store,binding);
            assertTeachingClear(state,binding.workId);gesture.assertCurrent?.();
            const source=this.store.record(binding.workspaceId,binding.ownerRecordId);
            if(source.event.type!=='message.received'||source.event.data.threadId!==command.threadId)throw new Error('Browser action thread mismatch');
            return state;
        };
        const initial=check();assertNoUnknownBrowserAction(initial,binding.workId);
        await withinExecution(()=>gesture.validate(),execution);check();
        const action:Action={id:randomUUID(),workId:binding.workId,workRevision:binding.expectedWorkRevision,
            key:`browser:${binding.ownerRecordId}:${randomUUID()}`,command:structuredClone(command),
            digest:commandDigest(binding.workspaceId,binding.workId,binding.expectedWorkRevision,command),status:'proposed'};
        const append=(event:Parameters<SqliteStore['append']>[2][number],guard?:()=>void)=>
            this.store.append(binding.workspaceId,this.store.state(binding.workspaceId).version,[event],{actorId:binding.ownerId,causationId:binding.ownerRecordId},guard);
        append({type:'action.proposed',data:{action}},()=>{check();assertNoUnknownBrowserAction(this.store.state(binding.workspaceId),binding.workId);});
        let started=false,dispatched=false,attemptId='';
        const cancelled=(status:'rejected'|'reject'|'handoff'):BrowserGestureResult<T>=>{
            const current=this.store.state(binding.workspaceId).actions[action.id]!;
            if(['proposed','approved'].includes(current.status))append({type:'action.cancelled',data:{id:action.id,reason:'Browser gesture was not dispatched.'}});
            return {actionId:action.id,status};
        };
        try {
            const decision=await withinExecution(()=>gesture.review(structuredClone(action),execution.signal),execution);
            if(decision!=='approve')return cancelled(decision==='handoff'?'handoff':'reject');
            check();await withinExecution(()=>gesture.validate(),execution);check();
            new Operator(this.store).approve(binding.workspaceId,binding.ownerId,action.id,action.digest,new Date(execution.deadline).toISOString());
            check();attemptId=randomUUID();
            append({type:'action.started',data:{id:action.id,attemptId}},()=>{check();assertNoUnknownBrowserAction(this.store.state(binding.workspaceId),binding.workId);});
            started=true;
            const observation=await withinExecution(()=>gesture.dispatch(()=>{
                if(dispatched)throw new Error('Browser gesture dispatch is one-shot');
                check();const live=this.store.state(binding.workspaceId).actions[action.id]!;
                if(live.status!=='running'||live.attemptId!==attemptId)throw new Error('Browser attempt retired');
                dispatched=true;
            }),execution);
            if(!dispatched)throw new Error('Browser dispatch receipt missing');
            check();
            if(!this.store.finishActionAttempt(binding.workspaceId,action.id,attemptId,'accepted',
                'Approved browser gesture completed and fresh page state was captured. This is not verification of a remote outcome or task completion.'))
                throw new Error('Browser attempt already settled');
            return {actionId:action.id,status:'accepted',observation};
        } catch(error) {
            if(!started)return cancelled('rejected');
            const noDispatch=error instanceof BrowserNoDispatchError;
            const status=dispatched&&!noDispatch?'unknown':'failed';
            const diagnostic:BrowserActionDiagnostic=error instanceof BrowserDiagnosticError?error.diagnostic:
                dispatched?{phase:'dispatch',code:'dispatch_unconfirmed'}:{phase:'validation',code:'pre_dispatch_stopped'};
            const explanation=status==='unknown'?
                'Browser gesture may have occurred. Outcome unknown; no automatic retry. Owner reconciliation is required.':
                'Browser gesture stopped before dispatch. No gesture was sent.';
            this.store.finishActionAttempt(binding.workspaceId,action.id,attemptId,status,JSON.stringify({explanation,diagnostic,...(noDispatch?{disposition:'not_dispatched'}:{})}));
            return {actionId:action.id,status,diagnostic,...(noDispatch?{disposition:'not_dispatched'}:{})};
        }
    }
}
