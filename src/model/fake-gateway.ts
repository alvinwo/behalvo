import type { ModelGateway, ModelInfo, ModelRequest, ModelResponse } from './types.js';

type Responder = (request: Readonly<ModelRequest>) => ModelResponse | Promise<ModelResponse>;

export class FakeModelGateway implements ModelGateway {
  readonly requests: ModelRequest[] = [];

  constructor(
    private readonly models: readonly ModelInfo[],
    private readonly responder: Responder
  ) {}

  async listModels(): Promise<readonly ModelInfo[]> {
    return this.models.map(model => structuredClone(model));
  }

  async complete(request: Readonly<ModelRequest>): Promise<ModelResponse> {
    if (!this.models.some(model => model.provider === request.model.provider && model.model === request.model.model))
      throw new Error(`Model is not in gateway catalog: ${request.model.provider}/${request.model.model}`);
    this.requests.push(structuredClone(request));
    return structuredClone(await this.responder(request));
  }
}
