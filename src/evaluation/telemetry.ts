import type { ModelGateway, ModelInfo, ModelRequest, ModelResponse, ModelUsage } from '../model/types.js';

const MAX_CALLS = 2400;
const MAX_DURATION_MS = 3_600_000;
const DEFAULT_CALL_TIMEOUT_MS = 45_000;
const REQUESTED_OUTPUT_TOKENS = 2048;
const MAX_RESPONSE_BYTES = 65_536;
const MAX_EXCERPT_BYTES = 8_000;

export type ModelCallStatus = 'ok' | 'suite_deadline' | 'call_timeout' | 'provider_error' | 'response_size';
export type ModelCallErrorCode = Exclude<ModelCallStatus, 'ok'> | 'call_budget';

export interface ModelCallRecord {
  provider: string;
  model: string;
  latencyMs: number;
  requestBytes: number;
  responseBytes: number;
  status: ModelCallStatus;
  usage: ModelUsage | null;
  responseExcerpt: string;
  responseTruncated: boolean;
}

export interface BudgetedModelGatewayOptions {
  maxCalls: number;
  maxDurationMs: number;
  callTimeoutMs?: number;
  clock?: () => number;
}

export class BudgetedModelError extends Error {
  constructor(readonly code: ModelCallErrorCode) {
    super(code);
    this.name = 'BudgetedModelError';
  }
}

function boundedInteger(value: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum)
    throw new Error(`Invalid ${label}`);
  return value;
}

function bytePrefix(text: string, maximum: number): string {
  let bytes = 0;
  let result = '';
  for (const character of text) {
    const size = Buffer.byteLength(character, 'utf8');
    if (bytes + size > maximum) break;
    result += character;
    bytes += size;
  }
  return result;
}

function validToken(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) && value >= 0
    ? value
    : null;
}

function validCost(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function safeUsage(value: ModelUsage | undefined): ModelUsage | null {
  if (!value || value.source !== 'pi-sdk') return null;
  const usage: ModelUsage = {
    inputTokens: validToken(value.inputTokens),
    outputTokens: validToken(value.outputTokens),
    cacheReadTokens: validToken(value.cacheReadTokens),
    cacheWriteTokens: validToken(value.cacheWriteTokens),
    totalTokens: validToken(value.totalTokens),
    estimatedCostUsd: validCost(value.estimatedCostUsd),
    source: 'pi-sdk'
  };
  if (!Object.values(usage).some(item => typeof item === 'number' && item > 0)) {
    usage.inputTokens = null;
    usage.outputTokens = null;
    usage.cacheReadTokens = null;
    usage.cacheWriteTokens = null;
    usage.totalTokens = null;
    usage.estimatedCostUsd = null;
  }
  return usage;
}

function frozenRecord(record: ModelCallRecord): Readonly<ModelCallRecord> {
  const usage = record.usage ? Object.freeze({ ...record.usage }) : null;
  return Object.freeze({ ...record, usage });
}

export class BudgetedModelGateway implements ModelGateway {
  readonly #maxCalls: number;
  readonly #callTimeoutMs: number;
  readonly #clock: () => number;
  readonly #deadline: number;
  readonly #records: ModelCallRecord[] = [];
  #callsStarted = 0;
  #suiteExhausted = false;

  constructor(private readonly gateway: ModelGateway, options: Readonly<BudgetedModelGatewayOptions>) {
    this.#maxCalls = boundedInteger(options.maxCalls, MAX_CALLS, 'model call budget');
    const maxDurationMs = boundedInteger(options.maxDurationMs, MAX_DURATION_MS, 'suite duration');
    this.#callTimeoutMs = boundedInteger(
      options.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS,
      MAX_DURATION_MS,
      'model call timeout'
    );
    this.#clock = options.clock ?? Date.now;
    const startedAt = this.#clock();
    if (!Number.isFinite(startedAt)) throw new Error('Invalid evaluation clock');
    this.#deadline = startedAt + maxDurationMs;
  }

  get records(): readonly Readonly<ModelCallRecord>[] {
    return Object.freeze(this.#records.map(record => frozenRecord(record)));
  }

  get exhausted(): boolean {
    return this.#suiteExhausted || this.#callsStarted >= this.#maxCalls || this.#clock() >= this.#deadline;
  }

  listModels(): Promise<readonly ModelInfo[]> {
    return this.gateway.listModels();
  }

  async complete(request: Readonly<ModelRequest>): Promise<ModelResponse> {
    const startedAt = this.#clock();
    if (this.#suiteExhausted || startedAt >= this.#deadline) {
      this.#suiteExhausted = true;
      throw new BudgetedModelError('suite_deadline');
    }
    if (this.#callsStarted >= this.#maxCalls) throw new BudgetedModelError('call_budget');
    this.#callsStarted++;

    const remainingMs = this.#deadline - startedAt;
    const timeoutMs = Math.min(this.#callTimeoutMs, remainingMs);
    const timeoutCode: 'suite_deadline' | 'call_timeout' = remainingMs <= this.#callTimeoutMs
      ? 'suite_deadline'
      : 'call_timeout';
    const controller = new AbortController();
    const signal = request.signal
      ? AbortSignal.any([request.signal, controller.signal])
      : controller.signal;
    const outbound: ModelRequest = {
      ...request,
      signal,
      maxRetries: 0,
      maxOutputTokens: REQUESTED_OUTPUT_TOKENS
    };
    const requestBytes = Buffer.byteLength(JSON.stringify(request), 'utf8');
    const provider = Promise.resolve()
      .then(() => this.gateway.complete(outbound))
      .then(
        response => ({ kind: 'response' as const, response }),
        () => ({ kind: 'provider_error' as const })
      );
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<{ kind: 'timeout'; code: 'suite_deadline' | 'call_timeout' }>(resolve => {
      timer = setTimeout(() => {
        controller.abort();
        resolve({ kind: 'timeout', code: timeoutCode });
      }, timeoutMs);
    });
    const outcome = await Promise.race([provider, timeout]);
    if (timer !== undefined) clearTimeout(timer);

    if (this.#clock() >= startedAt + timeoutMs) {
      if (timeoutCode === 'suite_deadline') this.#suiteExhausted = true;
      controller.abort();
      this.#record(request, startedAt, requestBytes, timeoutCode, '', undefined);
      throw new BudgetedModelError(timeoutCode);
    }

    if (outcome.kind === 'timeout') {
      if (outcome.code === 'suite_deadline') this.#suiteExhausted = true;
      this.#record(request, startedAt, requestBytes, outcome.code, '', undefined);
      throw new BudgetedModelError(outcome.code);
    }
    if (outcome.kind === 'provider_error') {
      this.#record(request, startedAt, requestBytes, 'provider_error', '', undefined);
      throw new BudgetedModelError('provider_error');
    }
    if (this.#clock() >= this.#deadline) {
      this.#suiteExhausted = true;
      controller.abort();
      this.#record(request, startedAt, requestBytes, 'suite_deadline', '', undefined);
      throw new BudgetedModelError('suite_deadline');
    }

    const responseBytes = Buffer.byteLength(outcome.response.text, 'utf8');
    if (responseBytes > MAX_RESPONSE_BYTES) {
      this.#record(request, startedAt, requestBytes, 'response_size', outcome.response.text, outcome.response.usage);
      throw new BudgetedModelError('response_size');
    }
    this.#record(request, startedAt, requestBytes, 'ok', outcome.response.text, outcome.response.usage);
    return outcome.response;
  }

  #record(
    request: Readonly<ModelRequest>,
    startedAt: number,
    requestBytes: number,
    status: ModelCallStatus,
    responseText: string,
    usage: ModelUsage | undefined
  ): void {
    const responseBytes = Buffer.byteLength(responseText, 'utf8');
    this.#records.push({
      provider: request.model.provider,
      model: request.model.model,
      latencyMs: Math.max(0, this.#clock() - startedAt),
      requestBytes,
      responseBytes,
      status,
      usage: safeUsage(usage),
      responseExcerpt: bytePrefix(responseText, MAX_EXCERPT_BYTES),
      responseTruncated: responseBytes > MAX_EXCERPT_BYTES
    });
  }
}
