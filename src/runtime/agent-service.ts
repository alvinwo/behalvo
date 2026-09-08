import { randomUUID } from 'node:crypto';
import type { DomainEvent, Fact, JournalRecord } from '../kernel/types.js';
import { assertOwner } from '../kernel/policy.js';
import { buildContext, type ContextPacket } from '../memory/context.js';
import type { AgentTurn, ModelGateway, ModelRef } from '../model/types.js';
import { parseAgentTurn } from '../model/validation.js';
import { Operator } from './operator.js';
import type { SqliteStore } from '../storage/sqlite-store.js';

const AGENT_SYSTEM = `You are the reasoning component of Behalvo.
The application's journal and projected state are authoritative. Never claim you executed an external action.
Return exactly one JSON object with only these fields:
{"reply": string, "workProposals": [{"id": string, "title": string, "goal": string}], "factProposals": [{"id": string, "subject": string, "predicate": string, "value": string, "validFrom": UTC_ISO_STRING, "validTo"?: UTC_ISO_STRING|null, "supersedes"?: string}]}
Use empty arrays when there are no proposals. Do not include commands, tool calls, provenance IDs, credentials, markdown fences, or extra fields.`;

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

  constructor(
    private readonly store: SqliteStore,
    private readonly gateway: ModelGateway,
    clock: () => string = () => new Date().toISOString()
  ) {
    this.#operator = new Operator(store, clock);
  }

  async runOwnerTurn(input: OwnerTurnInput): Promise<AgentTurnResult> {
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

    const context = buildContext(this.store, {
      workspaceId: input.workspaceId,
      ownerId: input.ownerId,
      threadId: input.threadId,
      currentRecordId: ownerRecord.id,
      ...(input.workId ? { workId: input.workId } : {}),
      windowTokens: input.windowTokens ?? 64000,
      outputReserve: input.outputReserve ?? 8000
    });

    const response = await this.gateway.complete({
      model: input.model,
      system: AGENT_SYSTEM,
      prompt: context.text,
      sessionHint: `${input.workspaceId}:${input.threadId}`
    });
    const turn = parseAgentTurn(response.text);

    const current = this.store.state(input.workspaceId);
    const proposedWorkIds = new Set<string>();
    const events: DomainEvent[] = [];

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
      const fact: Fact = {
        id: proposal.id,
        subject: proposal.subject,
        predicate: proposal.predicate,
        value: proposal.value,
        validFrom: proposal.validFrom,
        validTo: proposal.validTo ?? null,
        sourceRecordId: ownerRecord.id,
        ...(proposal.supersedes ? { supersedes: proposal.supersedes } : {})
      };
      events.push({ type: 'fact.recorded', data: { fact } });
    }

    const assistantArtifactId = this.store.putArtifact(input.workspaceId, turn.reply);
    const assistantExternalId = response.providerResponseId ?? `agent-${randomUUID()}`;
    const assistantEvent: DomainEvent = {
      type: 'message.received',
      data: {
        source: 'agent:model',
        externalId: assistantExternalId,
        threadId: input.threadId,
        senderId: 'agent',
        senderRole: 'agent',
        artifactId: assistantArtifactId
      }
    };
    events.push(assistantEvent);

    const committed = this.store.completeInbox(input.workspaceId, ownerRecord.id, this.store.state(input.workspaceId).version, events);
    const assistantRecord = committed.find((record): record is JournalRecord => record.event.type === 'message.received' && record.event.data.senderRole === 'agent');
    if (!assistantRecord)
      throw new Error('Assistant message was not committed');

    return { ownerRecordId: ownerRecord.id, assistantRecordId: assistantRecord.id, context, turn };
  }
}
