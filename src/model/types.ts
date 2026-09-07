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
}

export interface ModelResponse {
  text: string;
  providerResponseId?: string;
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
  validFrom: string;
  validTo?: string | null;
  supersedes?: string;
}

export interface AgentTurn {
  reply: string;
  workProposals: WorkProposal[];
  factProposals: FactProposal[];
}
