import { assertExecutionActive, OperationStoppedError } from '../operations/execution-context.js';
import { OperationLoop, type OperationLoopOptions, type OperationLoopResult } from './operation-loop.js';
import { randomUUID } from 'node:crypto';
import type { DomainEvent, Fact, JournalRecord } from '../kernel/types.js';
import { reduce } from '../kernel/reducer.js';
import { assertOwner } from '../kernel/policy.js';
import { buildContext, type ContextPacket } from '../memory/context.js';
import type { AgentTurn, ModelGateway, ModelRef } from '../model/types.js';
import { parseAgentTurn } from '../model/validation.js';
import { Operator } from './operator.js';
import type { SqliteStore } from '../storage/sqlite-store.js';

const AGENT_SYSTEM = `You are the reasoning component of Behalvo.
The application's journal and projected state are authoritative. Never claim you executed an external action.
Return exactly one JSON object with only these fields:
{"reply": string, "workProposals": [{"id": string, "title": string, "goal": string}], "factProposals": [{"id": string, "subject": string, "predicate": string, "value": string, "validFrom"?: UTC_ISO_STRING|null, "validTo"?: UTC_ISO_STRING|null, "supersedes"?: string}]}
Use null or omit validFrom when the onset is unknown. A validity timestamp is supported only as YYYY-MM-DDTHH:mm:ssZ or YYYY-MM-DDTHH:mm:ss.sssZ and when that exact string appears verbatim in the CURRENT OWNER INPUT. Do not infer, normalize, or backdate dates from phrases such as "today", month/day text, or ordinary preference statements.
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
}

/**
 * Trusted application boundary between untrusted model output and durable domain state.
 * The model receives a projection/context view and can only return validated proposals.
 */
export class AgentService {
  readonly #operator: Operator;
  readonly #loop: OperationLoop | undefined;
  readonly #workspaceId: string | undefined;

  constructor(
    private readonly store: SqliteStore,
    private readonly gateway: ModelGateway,
    clock: () => string = () => new Date().toISOString(),
    operations?: OperationLoopOptions
  ) {
    this.#operator = new Operator(store, clock);
    this.#workspaceId = operations?.workspaceId;
    this.#loop = operations ? new OperationLoop(store, operations) : undefined;
  }

  async runOwnerTurn(input: OwnerTurnInput): Promise<AgentTurnResult> {
    if (this.#workspaceId !== undefined && input.workspaceId !== this.#workspaceId)
      throw new Error('Agent service workspace binding mismatch');
    const initial = this.store.state(input.workspaceId);
    assertOwner(initial, input.ownerId);

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
      if (!work.threadIds.includes(input.threadId))
        this.#operator.linkThread(input.workspaceId, input.ownerId, input.workId, input.threadId);
    }

    const request = {
      model: input.model,
      system: AGENT_SYSTEM,
      prompt: '',
      sessionHint: `${input.workspaceId}:${input.threadId}`
    };
    const binding = { workspaceId: input.workspaceId, ownerId: input.ownerId,
      ownerRecordId: ownerRecord.id, inputBudgetBytes: (input.windowTokens ?? 64000) - (input.outputReserve ?? 8000),
      ...(input.workId ? { workId: input.workId } : {}) };
    const context = buildContext(this.store, {
      workspaceId: input.workspaceId,
      ownerId: input.ownerId,
      threadId: input.threadId,
      currentRecordId: ownerRecord.id,
      ...(input.workId ? { workId: input.workId } : {}),
      windowTokens: input.windowTokens ?? 64000,
      outputReserve: input.outputReserve ?? 8000,
      ...(this.#loop ? this.#loop.contextBudget(request, binding) : {})
    });

    request.prompt = context.text;
    const result: OperationLoopResult = this.#loop
      ? await this.#loop.run(this.gateway, request, binding)
      : await this.gateway.complete(request).then(response => ({ turn: parseAgentTurn(response.text),
          applicationAuthored: false, ...(response.providerResponseId ? { providerResponseId: response.providerResponseId } : {}) }));
    let turn = result.turn;
    let applicationAuthored = result.applicationAuthored;

    const current = this.store.state(input.workspaceId);
    const proposedWorkIds = new Set<string>();
    const events: DomainEvent[] = [];

    try {
      if (result.deadline !== undefined && Date.now() >= result.deadline) throw new Error('Run deadline');
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

      let preview = current;
      for (const event of events) preview = reduce(preview, event, preview.version + 1);
      if (result.deadline !== undefined && Date.now() >= result.deadline) throw new Error('Run deadline');
    } catch (error) {
      if (!this.#loop) throw error;
      events.length = 0;
      applicationAuthored = true;
      turn = { reply: 'Operation run stopped: final proposals were rejected or the run deadline elapsed. No final proposals were committed. Inspect /actions for independently recorded operation outcomes.',
        workProposals: [], factProposals: [] };
    }

    const assistantArtifactId = this.store.putArtifact(input.workspaceId, turn.reply);
    const assistantExternalId = result.providerResponseId ?? `agent-${randomUUID()}`;
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

    const deadlineStop = () => {
      applicationAuthored = true;
      turn = { reply: 'Operation run stopped at its deadline before final reply/proposal commit. Inspect /actions for independently recorded operation outcomes.',
        workProposals: [], factProposals: [] };
      events.length = 0;
      assistantEvent.data.source = 'agent:application';
      assistantEvent.data.externalId = `agent-${randomUUID()}`;
      assistantEvent.data.artifactId = this.store.putArtifact(input.workspaceId, turn.reply);
      events.push(assistantEvent);
    };
    const finalVersion = this.store.state(input.workspaceId).version;
    // Check before entry and after SQLite obtains its writer lock; lock waits may exceed the deadline.
    if (!applicationAuthored && result.deadline !== undefined && Date.now() >= result.deadline) deadlineStop();
    let committed: JournalRecord[];
    try {
      committed = this.store.completeInbox(input.workspaceId, ownerRecord.id, finalVersion, events,
        !applicationAuthored && result.deadline !== undefined ? () => assertExecutionActive({ deadline: result.deadline! }) : undefined);
    } catch (error) {
      if (!(error instanceof OperationStoppedError) || applicationAuthored) throw error;
      deadlineStop();
      committed = this.store.completeInbox(input.workspaceId, ownerRecord.id, this.store.state(input.workspaceId).version, events);
    }
    const assistantRecord = committed.find((record): record is JournalRecord => record.event.type === 'message.received' && record.event.data.senderRole === 'agent');
    if (!assistantRecord)
      throw new Error('Assistant message was not committed');

    return { ownerRecordId: ownerRecord.id, assistantRecordId: assistantRecord.id, context, turn };
  }
}
