import type { ModelGateway, ModelInfo, ModelRef, ModelRequest, ModelResponse } from './types.js';

function key(ref: ModelRef): string {
  return `${ref.provider}\u0000${ref.model}`;
}

export class ModelRegistry implements ModelGateway {
  #selected: ModelRef | null = null;
  #routes = new Map<string, ModelGateway>();

  constructor(private readonly gateways: readonly ModelGateway[]) {
    if (gateways.length === 0)
      throw new Error('At least one model gateway is required');
  }

  async listModels(): Promise<readonly ModelInfo[]> {
    const routes = new Map<string, ModelGateway>();
    const models: ModelInfo[] = [];
    for (const gateway of this.gateways) {
      for (const model of await gateway.listModels()) {
        const routeKey = key(model);
        if (routes.has(routeKey))
          throw new Error(`Duplicate or ambiguous model route: ${model.provider}/${model.model}`);
        routes.set(routeKey, gateway);
        models.push(structuredClone(model));
      }
    }
    this.#routes = routes;
    return models;
  }

  selected(): ModelRef | null {
    return this.#selected ? structuredClone(this.#selected) : null;
  }

  async select(provider: string, model: string): Promise<ModelRef> {
    await this.listModels();
    const ref = { provider, model };
    if (!this.#routes.has(key(ref)))
      throw new Error(`Model not found: ${provider}/${model}`);
    this.#selected = ref;
    return structuredClone(ref);
  }

  async complete(request: Readonly<ModelRequest>): Promise<ModelResponse> {
    if (!this.#routes.size)
      await this.listModels();
    const route = this.#routes.get(key(request.model));
    if (!route)
      throw new Error(`No gateway found for model: ${request.model.provider}/${request.model.model}`);
    return route.complete(request);
  }
}
