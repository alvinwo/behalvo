import { randomUUID } from 'node:crypto';
import type { ModelGateway, ModelInfo, ModelRequest, ModelResponse, ModelUsage } from './types.js';
import { PiCredentialFileStore, type PiCredential } from './pi-auth-store.js';
import { copyModelStateKey, type ModelStateProtectionOptions } from '../storage/model-state-codec.js';

export interface PiModelDescriptor {
  provider: string;
  id: string;
  name?: string;
  contextWindow?: number;
}

export interface PiTextContent {
  type: 'text';
  text: string;
  textSignature?: string;
}

export interface PiAssistantMessage {
  content: readonly ({ type: string; text?: string; textSignature?: string } | PiTextContent)[];
  responseId?: string;
  stopReason?: string;
  errorMessage?: string;
  usage?: Readonly<{
    input?: unknown;
    output?: unknown;
    cacheRead?: unknown;
    cacheWrite?: unknown;
    totalTokens?: unknown;
    cost?: Readonly<{ total?: unknown }>;
  }>;
}

export type PiAuthType = 'oauth' | 'api_key';

export type PiAuthPrompt =
  | { type: 'text' | 'secret' | 'manual_code'; message: string; placeholder?: string; signal?: AbortSignal }
  | { type: 'select'; message: string; options: readonly { id: string; label: string; description?: string }[]; signal?: AbortSignal };

export type PiAuthEvent =
  | { type: 'auth_url'; url: string; instructions?: string }
  | { type: 'device_code'; userCode: string; verificationUri: string; intervalSeconds?: number; expiresInSeconds?: number }
  | { type: 'progress'; message: string };

export interface PiAuthInteraction {
  signal?: AbortSignal;
  prompt(prompt: PiAuthPrompt): Promise<string>;
  notify(event: PiAuthEvent): void;
}

export interface PiRuntime {
  getModels(provider?: string): readonly PiModelDescriptor[];
  getModel(provider: string, id: string): PiModelDescriptor | undefined;
  login?(providerId: string, type: PiAuthType, interaction: PiAuthInteraction): Promise<PiCredential>;
  completeSimple(
    model: PiModelDescriptor,
    context: Readonly<{
      systemPrompt?: string;
      messages: readonly Readonly<{ role: 'user'; content: string; timestamp: number }>[];
    }>,
    options?: Readonly<{
      sessionId?: string;
      signal?: AbortSignal;
      maxRetries?: number;
      maxTokens?: number;
    }>
  ): Promise<PiAssistantMessage>;
}

export type PiRuntimeLoader = () => Promise<PiRuntime>;

const PI_PACKAGE = '@earendil-works/pi-ai';

export type PiModuleImporter = (specifier: string) => Promise<Record<string, unknown>>;

export interface PiGatewayOptions {
  sanitizeErrors?: boolean;
}

const defaultImporter: PiModuleImporter = new Function('specifier', 'return import(specifier)') as PiModuleImporter;

export function createPiRuntimeLoader(
  authPath: string,
  importer: PiModuleImporter = defaultImporter,
  options: ModelStateProtectionOptions = {}
): PiRuntimeLoader {
  const protectedOptions = options.encryptionKey === undefined
    ? undefined
    : { encryptionKey: copyModelStateKey(options.encryptionKey) };
  return async () => {
    const module = await importer(`${PI_PACKAGE}/providers/all`);
    const builtinModels = module.builtinModels;
    if (typeof builtinModels !== 'function')
      throw new Error('pi-ai providers/all does not export builtinModels()');
    const runtime = (builtinModels as (options: { credentials: PiCredentialFileStore }) => PiRuntime)({
      credentials: new PiCredentialFileStore(authPath, protectedOptions)
    });
    return {
      getModels: provider => runtime.getModels(provider),
      getModel: (provider, id) => runtime.getModel(provider, id),
      ...(runtime.login ? { login: runtime.login.bind(runtime) } : {}),
      async completeSimple(model, context, controls) {
        // Each completion owns its provider resources, even when callers share a hint.
        // The full prompt is supplied each time; no provider session is domain state.
        const core = await importer(PI_PACKAGE);
        if (typeof core.cleanupSessionResources !== 'function')
          throw new Error('Pi session cleanup is unavailable');
        const cleanup = core.cleanupSessionResources as (sessionId: string) => void;
        const sessionId = randomUUID();
        try { return await runtime.completeSimple(model, context, { ...controls, sessionId }); }
        finally { cleanup(sessionId); }
      }
    };
  };
}

async function defaultPiRuntimeLoader(): Promise<PiRuntime> {
  return createPiRuntimeLoader('data/pi-auth.json')();
}

function textFrom(message: PiAssistantMessage): { text: string; diagnosticText?: string } {
  if (message.stopReason === 'error')
    throw new Error(message.errorMessage || 'Pi provider returned an error');
  if (message.stopReason !== undefined && message.stopReason !== 'stop')
    throw new Error('Pi provider completion is incomplete');
  const blocks = message.content.filter((part): part is PiTextContent =>
    part.type === 'text' && typeof part.text === 'string');
  const phases = blocks.map(part => {
    if (!part.textSignature?.startsWith('{')) return undefined;
    let signature: unknown;
    try { signature = JSON.parse(part.textSignature); } catch { throw new Error('Invalid Pi text signature'); }
    const value = signature as { v?: unknown; id?: unknown; phase?: unknown } | null;
    if (!value || value.v !== 1 || typeof value.id !== 'string' ||
        (value.phase !== undefined && value.phase !== 'commentary' && value.phase !== 'final_answer'))
      throw new Error('Invalid Pi text signature');
    return value.phase === undefined ? undefined : { id: value.id, phase: value.phase };
  });
  if (blocks.reduce((total, part) => total + Buffer.byteLength(part.text, 'utf8'), 0) > 65536)
    throw new Error('Pi provider text exceeds the response limit');
  const diagnosticText = blocks.map(part => part.text).join('');
  if (!diagnosticText) throw new Error('Pi provider returned no text content');
  if (!phases.some(Boolean)) return { text: diagnosticText };
  if (phases.some(phase => phase === undefined)) throw new Error('Ambiguous Pi text phases');
  const finals = blocks.filter((_part, i) => phases[i]?.phase === 'final_answer');
  const finalIds = new Set(phases.filter(phase => phase?.phase === 'final_answer').map(phase => phase!.id));
  if (finalIds.size !== 1 || !finals.length) throw new Error('Ambiguous Pi final answer');
  const text = finals.map(part => part.text).join('');
  if (!text) throw new Error('Pi provider returned no final text');
  return { text, diagnosticText };
}

function nonnegativeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) && value >= 0
    ? value
    : null;
}

function nonnegativeNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function usageFrom(message: PiAssistantMessage): ModelUsage | undefined {
  if (!message.usage) return undefined;
  const tokens = {
    inputTokens: nonnegativeInteger(message.usage.input),
    outputTokens: nonnegativeInteger(message.usage.output),
    cacheReadTokens: nonnegativeInteger(message.usage.cacheRead),
    cacheWriteTokens: nonnegativeInteger(message.usage.cacheWrite),
    totalTokens: nonnegativeInteger(message.usage.totalTokens)
  };
  const estimatedCostUsd = nonnegativeNumber(message.usage.cost?.total);
  const reported = [...Object.values(tokens), estimatedCostUsd].some(value => value !== null && value > 0);
  if (!reported) {
    return {
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      totalTokens: null,
      estimatedCostUsd: null,
      source: 'pi-sdk'
    };
  }
  return { ...tokens, estimatedCostUsd, source: 'pi-sdk' };
}

export class PiModelGateway implements ModelGateway {
  #runtime: Promise<PiRuntime> | null = null;

  constructor(
    private readonly loader: PiRuntimeLoader = defaultPiRuntimeLoader,
    private readonly options: PiGatewayOptions = {}
  ) {}

  static fromRuntime(runtime: PiRuntime): PiModelGateway {
    return new PiModelGateway(async () => runtime);
  }

  async #getRuntime(): Promise<PiRuntime> {
    if (!this.#runtime) {
      // Share initialization as well as the loaded runtime: each loader owns a
      // credential store whose serialized writes must not be split across calls.
      this.#runtime = Promise.resolve().then(() => this.loader()).catch(error => {
        this.#runtime = null;
        if (this.options.sanitizeErrors)
          throw new Error('Unable to load bundled Pi model support (@earendil-works/pi-ai). Use Node >=22.19 and run npm ci.');
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(
          `Unable to load bundled Pi model support (${PI_PACKAGE}). Use Node >=22.19 and run npm ci. Configure provider credentials only before inference. Loader error: ${detail}`,
          { cause: error }
        );
      });
    }
    return this.#runtime;
  }

  async login(providerId: string, type: PiAuthType, interaction: PiAuthInteraction): Promise<PiCredential> {
    const runtime = await this.#getRuntime();
    try {
      if (!runtime.login)
        throw new Error('Loaded Pi runtime does not support provider login');
      return await runtime.login(providerId, type, interaction);
    } catch (error) {
      if (this.options.sanitizeErrors) throw new Error('Pi login failed.');
      throw error;
    }
  }

  async listModels(): Promise<readonly ModelInfo[]> {
    const runtime = await this.#getRuntime();
    try {
      return runtime.getModels().map(model => ({
        provider: model.provider,
        model: model.id,
        ...(model.name ? { label: model.name } : {}),
        ...(typeof model.contextWindow === 'number' ? { contextWindow: model.contextWindow } : {})
      }));
    } catch (error) {
      if (this.options.sanitizeErrors) throw new Error('Pi model catalog is unavailable.');
      throw error;
    }
  }

  async complete(request: Readonly<ModelRequest>): Promise<ModelResponse> {
    const runtime = await this.#getRuntime();
    try {
      const model = runtime.getModel(request.model.provider, request.model.model);
      if (!model)
        throw new Error(`Pi model not found: ${request.model.provider}/${request.model.model}`);

      const options = {
        ...(request.sessionHint ? { sessionId: request.sessionHint } : {}),
        ...(request.signal ? { signal: request.signal } : {}),
        ...(request.maxRetries !== undefined ? { maxRetries: request.maxRetries } : {}),
        ...(request.maxOutputTokens !== undefined ? { maxTokens: request.maxOutputTokens } : {})
      };
      const result = await runtime.completeSimple(
        model,
        {
          systemPrompt: request.system,
          messages: [{ role: 'user', content: request.prompt, timestamp: 0 }]
        },
        Object.keys(options).length ? options : undefined
      );

      const usage = usageFrom(result);
      return {
        ...textFrom(result),
        ...(result.responseId ? { providerResponseId: result.responseId } : {}),
        ...(usage ? { usage } : {})
      };
    } catch (error) {
      if (this.options.sanitizeErrors) throw new Error('Pi provider request failed.');
      throw error;
    }
  }
}
