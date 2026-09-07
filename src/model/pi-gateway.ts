import type { ModelGateway, ModelInfo, ModelRequest, ModelResponse } from './types.js';

export interface PiModelDescriptor {
  provider: string;
  id: string;
  name?: string;
  contextWindow?: number;
}

export interface PiTextContent {
  type: 'text';
  text: string;
}

export interface PiAssistantMessage {
  content: readonly ({ type: string; text?: string } | PiTextContent)[];
  responseId?: string;
  stopReason?: string;
  errorMessage?: string;
}

export interface PiRuntime {
  getModels(provider?: string): readonly PiModelDescriptor[];
  getModel(provider: string, id: string): PiModelDescriptor | undefined;
  completeSimple(
    model: PiModelDescriptor,
    context: Readonly<{
      systemPrompt?: string;
      messages: readonly Readonly<{ role: 'user'; content: string; timestamp: number }>[];
    }>,
    options?: Readonly<{ sessionId?: string }>
  ): Promise<PiAssistantMessage>;
}

export type PiRuntimeLoader = () => Promise<PiRuntime>;

const PI_PACKAGE = '@earendil-works/pi-ai';

async function defaultPiRuntimeLoader(): Promise<PiRuntime> {
  try {
    // Keep pi-ai optional: the core kernel and offline tests do not need it installed.
    const dynamicImport = new Function('specifier', 'return import(specifier)') as (
      specifier: string
    ) => Promise<Record<string, unknown>>;
    const module = await dynamicImport(`${PI_PACKAGE}/providers/all`);
    const builtinModels = module.builtinModels;
    if (typeof builtinModels !== 'function')
      throw new Error('pi-ai providers/all does not export builtinModels()');
    return (builtinModels as () => PiRuntime)();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Pi model support is optional. Install ${PI_PACKAGE} on Node >=22.19 and configure provider credentials before using it. Loader error: ${detail}`,
      { cause: error }
    );
  }
}

function textFrom(message: PiAssistantMessage): string {
  if (message.stopReason === 'error')
    throw new Error(message.errorMessage || 'Pi provider returned an error');
  const text = message.content
    .filter((part): part is PiTextContent => part.type === 'text' && typeof part.text === 'string')
    .map(part => part.text)
    .join('');
  if (!text)
    throw new Error('Pi provider returned no text content');
  return text;
}

export class PiModelGateway implements ModelGateway {
  #runtime: PiRuntime | null = null;

  constructor(private readonly loader: PiRuntimeLoader = defaultPiRuntimeLoader) {}

  static fromRuntime(runtime: PiRuntime): PiModelGateway {
    return new PiModelGateway(async () => runtime);
  }

  async #getRuntime(): Promise<PiRuntime> {
    if (!this.#runtime) {
      try {
        this.#runtime = await this.loader();
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(
          `Pi model support is optional. Install ${PI_PACKAGE} on Node >=22.19 and configure provider credentials before using it. Loader error: ${detail}`,
          { cause: error }
        );
      }
    }
    return this.#runtime;
  }

  async listModels(): Promise<readonly ModelInfo[]> {
    const runtime = await this.#getRuntime();
    return runtime.getModels().map(model => ({
      provider: model.provider,
      model: model.id,
      ...(model.name ? { label: model.name } : {}),
      ...(typeof model.contextWindow === 'number' ? { contextWindow: model.contextWindow } : {})
    }));
  }

  async complete(request: Readonly<ModelRequest>): Promise<ModelResponse> {
    const runtime = await this.#getRuntime();
    const model = runtime.getModel(request.model.provider, request.model.model);
    if (!model)
      throw new Error(`Pi model not found: ${request.model.provider}/${request.model.model}`);

    const result = await runtime.completeSimple(
      model,
      {
        systemPrompt: request.system,
        messages: [{ role: 'user', content: request.prompt, timestamp: 0 }]
      },
      request.sessionHint ? { sessionId: request.sessionHint } : undefined
    );

    return {
      text: textFrom(result),
      ...(result.responseId ? { providerResponseId: result.responseId } : {})
    };
  }
}
