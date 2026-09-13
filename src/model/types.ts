export interface ModelRef {
  provider: string;
  model: string;
}

export interface ModelInfo extends ModelRef {
  label?: string;
  contextWindow?: number;
}

export interface ModelRequest {
  model: ModelRef;
  system: string;
  prompt: string;
  sessionHint?: string;
  signal?: AbortSignal;
  maxRetries?: number;
  maxOutputTokens?: number;
}

/** Provider-reported token counts and Pi catalog cost estimate; never a billing record. */
export interface ModelUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  totalTokens: number | null;
  estimatedCostUsd: number | null;
  source: 'pi-sdk';
}

export interface ModelResponse {
  text: string;
  providerResponseId?: string;
  usage?: ModelUsage;
}

export interface ModelGateway {
  listModels(): Promise<readonly ModelInfo[]>;
  complete(request: Readonly<ModelRequest>): Promise<ModelResponse>;
}

export interface WorkProposal {
  id: string;
  title: string;
  goal: string;
}

export interface FactProposal {
  id: string;
  subject: string;
  predicate: string;
  value: string;
  /** Exact UTC timestamp copied from the current owner input; null when onset is unknown. */
  validFrom: string | null;
  validTo?: string | null;
  supersedes?: string;
}

export interface AgentTurn {
  reply: string;
  workProposals: WorkProposal[];
  factProposals: FactProposal[];
}
