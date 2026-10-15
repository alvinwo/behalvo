import { prepareProgressEvent, PROGRESS_PROTOCOL } from './task-continuity.js';
import { runRecallLoop } from './recall-loop.js';
import { memoryMessage } from '../memory/messages.js';
import { processTaskIntake } from './task-intake.js';
import { taskMessage } from './task-messages.js';
import { assertBrowserWork } from './browser-learning.js';
import { runBrowserExploration, type BrowserExplorationOptions, type BrowserExplorationResult } from './browser-exploration.js';
import { browserMessage } from './browser-messages.js';
import { extractTeachings } from './teaching-extractor.js';
import { prepareTeachingEvents } from './teachings.js';
import { teachingHold } from '../kernel/teachings.js';
import { teachingMessage } from './teaching-messages.js';
import { assertExecutionActive, executionDeadlineReached, withinExecution, OperationStoppedError,
  type OperationExecutionContext, type TrustedExecutionFence } from '../operations/execution-context.js';
import { OperationLoop, type OperationLoopOptions, type OperationLoopResult } from './operation-loop.js';
import { randomUUID } from 'node:crypto';
import { unresolvedBrowserActions } from '../kernel/browser-action.js';
import { browserStopMessage, liveMessage, unresolvedBrowserMessage, type BrowserStopCode } from '../browser/live-messages.js';
import type { DomainEvent, Fact, JournalRecord } from '../kernel/types.js';
import { reduce } from '../kernel/reducer.js';
import { assertOwner } from '../kernel/policy.js';
import { buildContext, type ContextPacket } from '../memory/context.js';
import type { AgentTurn, ModelGateway, ModelRef } from '../model/types.js';
import { parseAgentTurn } from '../model/validation.js';
import { Operator } from './operator.js';
import type { SqliteStore } from '../storage/sqlite-store.js';
import type { ServiceJob, ServiceStopReason } from '../storage/service-jobs.js';

const AGENT_SYSTEM = `You are the reasoning component of Behalvo.
The application's journal and projected state are authoritative. Never claim you executed an external action.
Return exactly one JSON object with only these fields:
{"reply": string, "workProposals": [{"id": string, "title": string, "goal": string}], "factProposals": [{"id": string, "subject": string, "predicate": string, "value": string, "validFrom"?: UTC_ISO_STRING|null, "validTo"?: UTC_ISO_STRING|null, "supersedes"?: string}]}
Use null or omit validFrom when the onset is unknown. A validity timestamp is supported only as YYYY-MM-DDTHH:mm:ssZ or YYYY-MM-DDTHH:mm:ss.sssZ and when that exact string appears verbatim in the CURRENT OWNER INPUT. Do not infer, normalize, or backdate dates from phrases such as "today", month/day text, or ordinary preference statements.
For facts about the owner, copy the exact ownerId from CURRENT WORKSPACE VIEW as subject; never substitute the literal "owner" or an invented identity.
Use empty arrays when there are no proposals. Do not include commands, provenance IDs, credentials, markdown fences, or extra final fields.`;

export interface OwnerTurnInput {
  workspaceId: string;
  ownerId: string;
  threadId: string;
  externalId: string;
  text: string;
  model: ModelRef;
  workId?: string;
  windowTokens?: number;
  outputReserve?: number;
}

export interface AgentTurnResult {
  ownerRecordId: string;
  assistantRecordId: string;
  context: ContextPacket;
  turn: AgentTurn;
  /** Resolved intake task; retry results do not change the persisted focus. */
  workId?: string;
}

export interface AdmittedOwnerTurnInput {
  workspaceId: string;
  ownerId: string;
  job: ServiceJob;
  fence: TrustedExecutionFence;
}

/**
 * Trusted application boundary between untrusted model output and durable domain state.
 * The model receives a projection/context view and can only return validated proposals.
 */
export class AgentService {
  readonly #operator: Operator;
  readonly #loop: OperationLoop | undefined;
  readonly #workspaceId: string | undefined;
  readonly #clock: () => string;
  readonly #timeoutMs: number;
  #browserCleanupPending = false;
  readonly #activeThreads = new Set<string>();

  constructor(
    private readonly store: SqliteStore,
    private readonly gateway: ModelGateway,
    clock: () => string = () => new Date().toISOString(),
    operations?: OperationLoopOptions,
    private readonly features: { teachingMode?: boolean; taskContinuity?: boolean; browser?: BrowserExplorationOptions } = {}
  ) {
    this.#timeoutMs = operations?.timeoutMs ?? 120000;
    this.#operator = new Operator(store, clock);
    this.#clock = clock;
    this.#workspaceId = operations?.workspaceId;
    this.#loop = operations ? new OperationLoop(store, operations) : undefined;
  }

  get continuityEnabled(): boolean { return this.features.taskContinuity === true; }

  async runOwnerTurn(input: OwnerTurnInput): Promise<AgentTurnResult> {
    const key=JSON.stringify([input.workspaceId,input.threadId]);
    if(this.#activeThreads.has(key))throw new Error(memoryMessage('busy'));
    this.#activeThreads.add(key);
    try {return await this.#runDirectOwnerTurn(input);} finally {this.#activeThreads.delete(key);}
  }

  async #runDirectOwnerTurn(input: OwnerTurnInput): Promise<AgentTurnResult> {
    if (this.#workspaceId !== undefined && input.workspaceId !== this.#workspaceId)
      throw new Error('Agent service workspace binding mismatch');
    const initial = this.store.state(input.workspaceId);
    assertOwner(initial, input.ownerId);

    this.features.browser?.beforeTurn?.(input);

    const ownerRecord = this.store.ingest(input.workspaceId, {
      source: 'owner:local',
      externalId: input.externalId,
      threadId: input.threadId,
      senderId: input.ownerId,
      senderRole: 'owner',
      text: input.text
    });

    if (!this.store.inbox(input.workspaceId).some(record => record.id === ownerRecord.id))
      throw new Error('Inbox record already handled or not found');

    if (input.workId) {
      const state = this.store.state(input.workspaceId);
      const work = state.works[input.workId];
      if (!work)
        throw new Error(`Work not found: ${input.workId}`);
      if (!work.threadIds.includes(input.threadId) && (this.features.taskContinuity || this.features.teachingMode || this.features.browser || Object.values(state.browserMemory?.notes ?? {}).some(n=>n.workId===work.id))) throw new Error('Thread must be explicitly linked to work');
      if (!work.threadIds.includes(input.threadId))
        this.#operator.linkThread(input.workspaceId, input.ownerId, input.workId, input.threadId);
    }

    return this.#processOwnerRecord(input, ownerRecord);
  }

  async processAdmittedOwnerTurn(input: AdmittedOwnerTurnInput): Promise<AgentTurnResult> {
    if (this.#workspaceId !== undefined && input.workspaceId !== this.#workspaceId)
      throw new Error('Agent service workspace binding mismatch');
    const initial = this.store.state(input.workspaceId);
    assertOwner(initial, input.ownerId);
    if(input.job.parameters.kind==='owner_turn')this.features.browser?.beforeTurn?.({workspaceId:input.workspaceId,ownerId:input.ownerId,threadId:input.job.parameters.threadId,...(input.job.parameters.workId?{workId:input.job.parameters.workId}:{})});
    const job = input.job;
    if (job.workspaceId !== input.workspaceId || job.status !== 'running' || !job.claim ||
        job.kind !== 'owner_turn' || job.parameters.kind !== 'owner_turn')
      throw new Error('Invalid admitted owner job');
    const ownerRecord = this.store.record(input.workspaceId, job.parameters.ownerRecordId);
    if (ownerRecord.event.type !== 'message.received' || ownerRecord.event.data.senderRole !== 'owner' ||
        ownerRecord.event.data.threadId !== job.parameters.threadId)
      throw new Error('Invalid admitted owner record');
    if (!this.store.inbox(input.workspaceId).some(record => record.id === ownerRecord.id))
      throw new Error('Inbox record already handled or not found');
    const text = this.store.readArtifact(input.workspaceId, ownerRecord.event.data.artifactId);
    const parameters = job.parameters;
    if (parameters.workId) {
      const work = initial.works[parameters.workId];
      if (!work || !work.threadIds.includes(parameters.threadId))
        throw new Error('Admitted owner work binding is no longer valid');
    }
    return this.#processOwnerRecord({ workspaceId: input.workspaceId, ownerId: input.ownerId,
      threadId: parameters.threadId, externalId: ownerRecord.event.data.externalId, text,
      model: parameters.model, ...(parameters.workId ? { workId: parameters.workId } : {}),
      windowTokens: parameters.windowTokens, outputReserve: parameters.outputReserve }, ownerRecord,
      { job, fence: input.fence });
  }

  async #processOwnerRecord(input: OwnerTurnInput, ownerRecord: JournalRecord,
    admitted?: { job: ServiceJob; fence: TrustedExecutionFence }): Promise<AgentTurnResult> {

    input = {...input};
    const continuityEnabled = this.continuityEnabled;
    const teachingEvents: DomainEvent[] = [];
    const hasNotes = !!input.workId && Object.values(this.store.state(input.workspaceId).browserMemory?.notes ?? {}).some(n=>n.workId===input.workId&&n.status==='candidate');
    const browserAvailable=()=>!!input.workId&&!!this.features.browser&&(this.features.browser.mode==='live'||!this.features.browser.available||this.features.browser.available({workspaceId:input.workspaceId,ownerId:input.ownerId,threadId:input.threadId,workId:input.workId}));
    let explorationEnabled = browserAvailable();
    const teachingEnabled = continuityEnabled || this.features.teachingMode === true || explorationEnabled || hasNotes;
    const browserEvents: DomainEvent[] = [];
    let browserCommitGuard: (()=>void) | undefined;
    if ((explorationEnabled || continuityEnabled && this.features.browser) && this.#browserCleanupPending) throw new Error('Previous browser cleanup remains unconfirmed');
    const controller = teachingEnabled && !admitted ? new AbortController() : undefined;
    const timer = controller ? setTimeout(()=>controller.abort(),this.#timeoutMs) : undefined;
    try {
    const execution: OperationExecutionContext | undefined = teachingEnabled ? {
      deadline: Math.min(Date.now()+this.#timeoutMs,admitted?.fence.deadline ?? Infinity),
      ...(admitted ? {signal:admitted.fence.signal,assertCurrent:()=>admitted.fence.assertCurrent()} : controller ? {signal:controller.signal} : {})
    } : undefined;
    let teachingReply: string | undefined;
    let extracted = false;
    if (continuityEnabled) {
      if (!this.store.state(input.workspaceId).taskContinuity) throw new Error(taskMessage('upgrade'));
      try {
        const intake = await processTaskIntake(this.store,this.gateway,input.model,{
          workspaceId:input.workspaceId,ownerId:input.ownerId,threadId:input.threadId,ownerRecordId:ownerRecord.id,
          ...(input.workId?{workId:input.workId}:{}),
          ...(admitted?{assertCommitCurrent:()=>{
            const check=admitted.fence.assertDispatchCurrent??admitted.fence.assertSettlementCurrent;
            if(!check)throw new Error('Task intake requires a synchronous service fence');
            check();
            const current=this.store.serviceJob(input.workspaceId,admitted.job.id);
            if(current.status!=='running'||current.claim?.claimId!==admitted.job.claim?.claimId||current.claim?.instanceId!==admitted.job.claim?.instanceId)throw new OperationStoppedError();
          }}:{})
        },execution!, (input.windowTokens??64000)-(input.outputReserve??8000));
        extracted=intake.completionsUsed===1;
        if(intake.receipt.workId!==null) input.workId=intake.receipt.workId; else delete input.workId;
        if(intake.receipt.outcome==='clarify')teachingReply=intake.receipt.question!;
        explorationEnabled=browserAvailable();
        if(input.workId&&teachingHold(this.store.state(input.workspaceId),input.workId))teachingReply??=teachingMessage('clarification');
      } catch { teachingReply=taskMessage('rejected'); }
    }
    if (!continuityEnabled && teachingEnabled && input.workId) {
      const before = this.store.state(input.workspaceId);
      if (!before.teachingMemory) throw new Error(teachingMessage('upgrade'));
      const sourceText = (id:string):string => {
        const r=this.store.record(input.workspaceId,id);
        if(r.event.type!=='message.received'||r.event.data.senderRole!=='owner'||r.event.data.senderId!==input.ownerId) throw new Error('Invalid teaching source');
        return this.store.readArtifact(input.workspaceId,r.event.data.artifactId);
      };
      try {
        extracted = true;
        const result = await extractTeachings(this.gateway,input.model,{
          currentOwnerText:sourceText(ownerRecord.id),
          teachings:Object.values(before.teachingMemory.teachings).filter(t=>t.workId===input.workId&&t.status==='active').map(t=>({id:t.id,revision:t.revision,sourceQuote:t.sourceQuote,sourceText:sourceText(t.sourceRecordId)})),
          clarifications:Object.values(before.teachingMemory.clarifications).filter(t=>t.workId===input.workId&&t.status==='open').map(t=>({id:t.id,sourceQuote:t.sourceQuote,sourceText:sourceText(t.sourceRecordId)}))
        },execution!, (input.windowTokens ?? 64000)-(input.outputReserve ?? 8000));
        teachingEvents.push(...prepareTeachingEvents(this.store,{workspaceId:input.workspaceId,ownerId:input.ownerId,workId:input.workId,ownerRecordId:ownerRecord.id,expectedWorkRevision:before.works[input.workId]!.revision},result));
        if(result.outcome==='clarify') teachingReply=teachingMessage('clarification')+' '+result.question;
        else if(result.outcome==='apply') teachingReply=teachingMessage('saved');
        else if(teachingHold(before,input.workId)) teachingReply=teachingMessage('clarification');
      } catch {
        teachingEvents.length=0; teachingReply=teachingMessage('rejected');
      }
    }

    const request = {
      model: input.model,
      system: AGENT_SYSTEM + (continuityEnabled ? '\nTask selection and owner memory have already been processed by intake. Continue the owner request using the committed context. Return empty workProposals and factProposals; never create work or revise owner teachings in this phase.\n'+PROGRESS_PROTOCOL : ''),
      prompt: '',
      sessionHint: `${input.workspaceId}:${input.threadId}`
    };
    const binding = { workspaceId: input.workspaceId, ownerId: input.ownerId,
      ...(continuityEnabled?{recall:{workspaceId:input.workspaceId,ownerId:input.ownerId,threadId:input.threadId,...(input.workId?{workId:input.workId}:{})}}:{}),
      ...(execution ? {executionContext:execution,maxCompletions:extracted?7:8} : {}),
      ownerRecordId: ownerRecord.id, inputBudgetBytes: (input.windowTokens ?? 64000) - (input.outputReserve ?? 8000),
      ...(admitted ? { capability: 'prepare_only' as const, executionContext: {
        signal: admitted.fence.signal, deadline: execution?.deadline ?? admitted.fence.deadline,
        assertCurrent: () => admitted.fence.assertCurrent()
      } } : {}),
      ...(input.workId ? { workId: input.workId } : {}) };
    const context = buildContext(this.store, {
      workspaceId: input.workspaceId,
      ownerId: input.ownerId,
      threadId: input.threadId,
      currentRecordId: ownerRecord.id,
      historyMode: continuityEnabled ? 'task' : 'legacy_thread',
      ...(input.workId ? { workId: input.workId } : {}),
      windowTokens: input.windowTokens ?? 64000,
      outputReserve: input.outputReserve ?? 8000,
      ...(this.#loop ? this.#loop.contextBudget(request, binding) : {})
    });

    request.prompt = context.text;
    const reasoningWorkRevision=input.workId?this.store.state(input.workspaceId).works[input.workId]?.revision:undefined;
    const reasoningProgressRevision=input.workId?this.store.state(input.workspaceId).taskContinuity?.progress[input.workId]?.revision??0:0;
    const continuityCommitGuard=(progressAlreadyAppended=false)=>{
      if(!continuityEnabled||!input.workId||teachingReply!==undefined)return;
      const work=this.store.state(input.workspaceId).works[input.workId];
      if(!work||work.revision!==reasoningWorkRevision||(this.store.state(input.workspaceId).taskContinuity?.progress[input.workId]?.revision??0)!==reasoningProgressRevision+(progressAlreadyAppended?1:0)||['done','cancelled'].includes(work.phase))throw new OperationStoppedError();
    };
    const completeFinal = async (context?:OperationExecutionContext) => {
      if(continuityEnabled&&Buffer.byteLength(JSON.stringify(request),'utf8')>Math.min(binding.inputBudgetBytes,196608))throw new Error('Task reasoning input budget exceeded');
      const response=continuityEnabled ? await runRecallLoop(this.store,this.gateway,request,binding.recall!,context!,extracted?7:8,binding.inputBudgetBytes) :
        await withinExecution(()=>this.gateway.complete(context?.signal?{...request,signal:context.signal}:request),context);
      if(continuityEnabled&&(Buffer.byteLength(response.text,'utf8')>65536||(response.diagnosticText!==undefined&&Buffer.byteLength(response.diagnosticText,'utf8')>65536)))throw new Error('Task reasoning output budget exceeded');
      return response;
    };
    let result: OperationLoopResult;
    let browserOutcome:BrowserExplorationResult|undefined;
    if (teachingReply !== undefined) result = {turn:{reply:teachingReply,workProposals:[],factProposals:[]},applicationAuthored:true,deadline:execution!.deadline};
    else if (explorationEnabled) {
      if(!input.workId)throw new Error('Focus an explicitly linked work item before browsing');
      const state=this.store.state(input.workspaceId);
      if(!state.browserMemory)throw new Error(browserMessage('upgrade'));
      const browserBinding={workspaceId:input.workspaceId,ownerId:input.ownerId,workId:input.workId,ownerRecordId:ownerRecord.id,expectedWorkRevision:state.works[input.workId]!.revision};
      browserCommitGuard=()=>{try{const current=assertBrowserWork(this.store,browserBinding);if(teachingHold(current,browserBinding.workId))throw new Error('Clarification pending');}catch{throw new OperationStoppedError();}};
      const browserResult=await runBrowserExploration(this.store,this.gateway,request,
        browserBinding,
        execution!,this.features.browser,extracted?7:8,binding.inputBudgetBytes,context.includedBrowserSourceIds);
      browserOutcome=browserResult;
      this.#browserCleanupPending=!(browserResult.cleanupConfirmed===true||browserResult.leaseRetired===true);
      browserEvents.push(...browserResult.events);result=browserResult;
    }
    else if (this.#loop) result = await this.#loop.run(this.gateway, request, binding);
    else if (!admitted) {
      try {
        const response=await completeFinal(execution);
        result={turn:parseAgentTurn(response.text),applicationAuthored:false,...(execution?{deadline:execution.deadline}:{}),...(response.providerResponseId?{providerResponseId:response.providerResponseId}:{})};
      } catch(error) { if(continuityEnabled)throw new Error(taskMessage('interrupted'));
        if(hasNotes)result={turn:{reply:browserMessage('stopped'),workProposals:[],factProposals:[]},applicationAuthored:true,stopReason:'invalid_model_result'};
        else throw error; }
    }
    else {
      const context: OperationExecutionContext = { signal: admitted.fence.signal, deadline: execution?.deadline ?? admitted.fence.deadline,
        assertCurrent: () => admitted.fence.assertCurrent() };
      try {
        const response = await completeFinal(context);
        result = { turn: parseAgentTurn(response.text), applicationAuthored: false, deadline: context.deadline,
          ...(response.providerResponseId ? { providerResponseId: response.providerResponseId } : {}) };
      } catch (error) {
        if (!(error instanceof OperationStoppedError)) {if(continuityEnabled)throw new Error(taskMessage('interrupted'));throw error;}
        result = { turn: { reply: 'Service inference stopped before a model result was committed.',
          workProposals: [], factProposals: [] }, applicationAuthored: true, deadline: context.deadline,
          stopReason: executionDeadlineReached(context, error) ? 'deadline' : 'cancelled' };
      }
    }
    // Application-authored loop stops also share the intake deadline. Their
    // result may omit it, but a progress checkpoint is still a guarded mutation.
    if(execution)result.deadline=Math.min(result.deadline??Infinity,execution.deadline);
    let turn = result.turn;
    let applicationAuthored = result.applicationAuthored;
    let stopReason: ServiceStopReason = result.stopReason ?? 'completed';
    const stopReply=(fallback:string)=>{
      if(this.features.browser?.mode!=='live'||!input.workId)return fallback;
      const unresolved=unresolvedBrowserActions(this.store.state(input.workspaceId),input.workId);
      return unresolved.length?unresolvedBrowserMessage(unresolved)+(this.#browserCleanupPending?' '+liveMessage('cleanupPending'):''):fallback;
    };

    const current = this.store.state(input.workspaceId);
    const proposedWorkIds = new Set<string>();
    const events: DomainEvent[] = [...teachingEvents,...browserEvents];
    let hasProgress=false;
    const rejectFinal = async (error:unknown, fallback:string, terminal=false) => {
      events.length=0;hasProgress=false;applicationAuthored=true;stopReason='invalid_model_result';
      if(this.features.browser?.mode==='live'&&browserOutcome){
        let code:BrowserStopCode='final/settlement_rejected';
        try{assertExecutionActive(execution);await execution?.assertCurrent?.();assertExecutionActive(execution);browserCommitGuard?.();continuityCommitGuard();}
        catch{code=execution&&executionDeadlineReached(execution,error)?'lifecycle/deadline':execution?.signal?.aborted?'lifecycle/cancelled':'lifecycle/authority_unavailable';}
        let disposition=browserOutcome.sessionDisposition;
        if((terminal||code.startsWith('lifecycle/'))&&browserOutcome.closeSession){
          let confirmed=false;try{confirmed=(await browserOutcome.closeSession()).confirmed;}catch{/* No raw cleanup error in the journal. */}
          this.#browserCleanupPending=!confirmed;disposition=confirmed?'closed':undefined;
        }
        stopReason=code==='lifecycle/deadline'?'deadline':code==='lifecycle/cancelled'?'cancelled':'invalid_model_result';
        fallback=browserStopMessage(code,disposition,this.#browserCleanupPending?'cleanup/cleanup_unconfirmed':undefined);
      }
      turn={reply:stopReply(fallback),workProposals:[],factProposals:[]};
    };

    try {
      if ((continuityEnabled || hasNotes) && turn.workProposals.length) throw new Error('Task creation requires owner intake');
      if (teachingEnabled && turn.factProposals.length) throw new Error('Task teaching mode does not accept legacy facts');
      if ((!applicationAuthored || (teachingEvents.length>0 || browserEvents.length>0 || hasProgress)) && result.deadline !== undefined && Date.now() >= result.deadline)
        throw new Error('Run deadline');
      for (const proposal of turn.workProposals) {
        if (Object.hasOwn(current.works, proposal.id) || proposedWorkIds.has(proposal.id))
          throw new Error(`Work already exists: ${proposal.id}`);
        proposedWorkIds.add(proposal.id);
        events.push({ type: 'work.created', data: { ...proposal, threadId: input.threadId } });
      }

      const proposedFactIds = new Set<string>();
      for (const proposal of turn.factProposals) {
        if (Object.hasOwn(current.facts, proposal.id) || proposedFactIds.has(proposal.id))
          throw new Error(`Fact already exists: ${proposal.id}`);
        proposedFactIds.add(proposal.id);
        if (proposal.supersedes && !Object.hasOwn(current.facts, proposal.supersedes))
          throw new Error(`Superseded fact not found: ${proposal.supersedes}`);
        for (const [label, timestamp] of [['validFrom', proposal.validFrom], ['validTo', proposal.validTo]] as const) {
          if (timestamp !== undefined && timestamp !== null && !input.text.includes(timestamp))
            throw new Error(`${label} timestamp must appear exactly in the current owner input`);
        }
        const fact: Fact = {
          id: proposal.id,
          subject: proposal.subject,
          predicate: proposal.predicate,
          value: proposal.value,
          validFrom: proposal.validFrom,
          validTo: proposal.validTo ?? null,
          observedAt: ownerRecord.recordedAt,
          sourceRecordId: ownerRecord.id,
          ...(proposal.supersedes ? { supersedes: proposal.supersedes } : {})
        };
        events.push({ type: 'fact.recorded', data: { fact } });
      }

      if(continuityEnabled&&input.workId&&teachingReply===undefined&&!this.#browserCleanupPending) {
        const previous=current.taskContinuity?.progress[input.workId];
        const report=turn.progress??(applicationAuthored?(previous?{summary:previous.summary,nextStep:previous.nextStep,blocker:previous.blocker,references:previous.references}:{summary:taskMessage('stoppedSummary'),nextStep:taskMessage('stoppedNextStep'),blocker:null,references:[]}):undefined);
        if(report) {
          assertExecutionActive(execution);continuityCommitGuard();
          events.push(prepareProgressEvent(this.store,{workspaceId:input.workspaceId,ownerId:input.ownerId,workId:input.workId,ownerRecordId:ownerRecord.id,expectedWorkRevision:reasoningWorkRevision!},report,stopReason,
            turn.progress?reasoningWorkRevision:previous?.workRevision??reasoningWorkRevision));hasProgress=true;
        }
      }
      if(!applicationAuthored||hasProgress)continuityCommitGuard();
      let preview = current;
      for (const event of events) preview = reduce(preview, event, preview.version + 1);
      if ((!applicationAuthored || (teachingEvents.length>0 || browserEvents.length>0 || hasProgress)) && result.deadline !== undefined && Date.now() >= result.deadline)
        throw new Error('Run deadline');
    } catch (error) {
      if (!this.#loop && !teachingEnabled) throw error;
      await rejectFinal(error,'Operation run stopped: final proposals were rejected or the run deadline elapsed. No final proposals were committed. Inspect /actions for independently recorded operation outcomes.');
    }

    const assistantExternalId = result.providerResponseId ?? `agent-${randomUUID()}`;
    if (admitted) {
      try {
      const version = this.store.state(input.workspaceId).version;
      const completed = this.store.completeOwnerTurnJob(input.workspaceId, admitted.job.claim!, {
        ownerRecordId: ownerRecord.id, expectedVersion: version, events,
        reply: { text: turn.reply, source: applicationAuthored ? 'agent:application' : 'agent:model',
          externalId: assistantExternalId, threadId: input.threadId },
        status: stopReason === 'completed' || stopReason === 'prepared_for_review' ? 'finished' : 'stopped',
        reason: stopReason, at: this.#clock()
      }, () => {
        admitted.fence.assertSettlementCurrent?.();
        if(!applicationAuthored||hasProgress)continuityCommitGuard(hasProgress);
        if(!applicationAuthored || browserEvents.length>0)browserCommitGuard?.();
        if (!applicationAuthored || (teachingEvents.length>0 || browserEvents.length>0 || hasProgress) || !admitted.fence.assertSettlementCurrent)
          assertExecutionActive({ signal: admitted.fence.signal, deadline: execution?.deadline ?? admitted.fence.deadline });
      });
      const assistantRecord = completed.records.find((record): record is JournalRecord =>
        record.event.type === 'message.received' && record.event.data.senderRole === 'agent');
      if (!assistantRecord) throw new Error('Assistant message was not committed');
      return { ownerRecordId: ownerRecord.id, assistantRecordId: assistantRecord.id, context, turn, ...(input.workId?{workId:input.workId}:{}) };
      } catch(error) {
        // A revoked service fence cannot authorize another settlement. Close the
        // browser before the worker handles the failed claim; never bypass it.
        if(browserOutcome)await rejectFinal(error,'',true);
        throw error;
      }
    }

    let committed: JournalRecord[];
    const guarded=!!browserOutcome||!applicationAuthored||teachingEvents.length>0||browserEvents.length>0||hasProgress;
    try {
    const assistantArtifactId = this.store.putArtifact(input.workspaceId, turn.reply);
    const assistantEvent: DomainEvent = {
      type: 'message.received',
      data: {
        source: applicationAuthored ? 'agent:application' : 'agent:model',
        externalId: assistantExternalId,
        threadId: input.threadId,
        senderId: 'agent',
        senderRole: 'agent',
        artifactId: assistantArtifactId
      }
    };
    events.push(assistantEvent);
    const finalVersion = this.store.state(input.workspaceId).version;
    // Check before entry and after SQLite obtains its writer lock; lock waits may exceed the deadline.
    const finalGuard=guarded&&result.deadline!==undefined?()=>{
      assertExecutionActive({deadline:result.deadline!,...(execution?.signal?{signal:execution.signal}:{})});
      if(!applicationAuthored||hasProgress||browserOutcome)continuityCommitGuard();
      if(!applicationAuthored||browserEvents.length>0||browserOutcome)browserCommitGuard?.();
    }:undefined;
    finalGuard?.();
      committed = this.store.completeInbox(input.workspaceId, ownerRecord.id, finalVersion, events,
        finalGuard);
    } catch (error) {
      if (!(error instanceof OperationStoppedError) || !guarded) {
        if(browserOutcome)await rejectFinal(error,'',true);
        throw error;
      }
      await rejectFinal(error,'Operation run stopped at its deadline before final reply/proposal commit. Inspect /actions for independently recorded operation outcomes.',true);
      const artifactId=this.store.putArtifact(input.workspaceId,turn.reply);
      // Only the fixed application stop may settle after lifecycle rejection.
      committed = this.store.completeInbox(input.workspaceId, ownerRecord.id, this.store.state(input.workspaceId).version,
        [{type:'message.received',data:{source:'agent:application',externalId:`agent-${randomUUID()}`,threadId:input.threadId,senderId:'agent',senderRole:'agent',artifactId}}]);
    }
    const assistantRecord = committed.find((record): record is JournalRecord => record.event.type === 'message.received' && record.event.data.senderRole === 'agent');
    if (!assistantRecord)
      throw new Error('Assistant message was not committed');

    return { ownerRecordId: ownerRecord.id, assistantRecordId: assistantRecord.id, context, turn, ...(input.workId?{workId:input.workId}:{}) };
    } finally { clearTimeout(timer); controller?.abort(); }
  }
}
