import { randomUUID } from 'node:crypto';
import { TextDecoder, toUSVString } from 'node:util';
import { PayloadCipher } from './payload-cipher.js';

export interface ModelStateProtectionOptions { encryptionKey?: Uint8Array }
export interface ModelStateOperationOptions { signal?: AbortSignal }
export interface ModelStatePreflightOptions extends ModelStateOperationOptions { writable?: boolean }
export type ModelStatePurpose = 'pi-credentials' | 'model-settings';
export type ModelStateErrorCode =
  'configuration' | 'key' | 'unavailable' | 'busy' | 'cancelled' | 'update';

const MESSAGES: Record<ModelStateErrorCode, string> = {
  configuration: 'Invalid private model state configuration.',
  key: 'Private model state key is unavailable.',
  unavailable: 'Private model state is unavailable.',
  busy: 'Private model state is busy.',
  cancelled: 'Private model state operation cancelled.',
  update: 'Private model state update failed.'
};

export class ModelStateError extends Error {
  readonly code: ModelStateErrorCode;

  constructor(code: ModelStateErrorCode) {
    super(MESSAGES[code]);
    this.name = 'ModelStateError';
    this.code = code;
  }
}
export const MODEL_STATE_LIMITS = {
  outerBytes: 2_097_152,
  plaintextBytes: 1_048_576,
  providers: 256,
  workspaces: 1_024,
  identifierUnits: 512,
  extensionDepth: 32,
  lockWaitMs: 5_000,
  lockPollMs: 10
} as const;

const FORMAT = 'behalvo-private-model-state';
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const OUTER_KEYS = ['documentId', 'format', 'payload', 'purpose', 'version'] as const;

export function copyModelStateKey(key: Uint8Array): Uint8Array {
  if (!(key instanceof Uint8Array) || key.byteLength !== 32)
    throw new ModelStateError('configuration');
  return Uint8Array.from(key);
}

export function validModelStateIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 &&
    value.length <= MODEL_STATE_LIMITS.identifierUnits && !/[\u0000-\u001f\u007f]/u.test(value);
}

function validPurpose(value: unknown): value is ModelStatePurpose {
  return value === 'pi-credentials' || value === 'model-settings';
}

export class ModelStateCodec {
  readonly #key: Uint8Array;
  readonly #purpose: ModelStatePurpose;

  constructor(key: Uint8Array, purpose: ModelStatePurpose) {
    if (!validPurpose(purpose)) throw new ModelStateError('configuration');
    this.#key = copyModelStateKey(key);
    this.#purpose = purpose;
  }

  seal(plaintext: string, documentId?: string): { documentId: string; bytes: Buffer } {
    try {
      if (typeof plaintext !== 'string' || toUSVString(plaintext) !== plaintext ||
          Buffer.byteLength(plaintext, 'utf8') > MODEL_STATE_LIMITS.plaintextBytes)
        throw new Error('invalid plaintext');
      const id = documentId ?? randomUUID();
      if (!UUID_V4.test(id)) throw new Error('invalid document id');
      const cipher = new PayloadCipher(this.#key, id);
      const payload = cipher.seal(plaintext, ['behalvo/private-model-state/v1', this.#purpose, 1]);
      const bytes = Buffer.from(JSON.stringify({
        format: FORMAT,
        version: 1,
        purpose: this.#purpose,
        documentId: id,
        payload
      }) + '\n', 'utf8');
      if (bytes.byteLength > MODEL_STATE_LIMITS.outerBytes) throw new Error('outer document too large');
      return { documentId: id, bytes };
    } catch {
      throw new ModelStateError('update');
    }
  }

  open(bytes: Uint8Array): { documentId: string; plaintext: string } {
    try {
      if (!(bytes instanceof Uint8Array) || bytes.byteLength > MODEL_STATE_LIMITS.outerBytes)
        throw new Error('invalid bytes');
      const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
      const parsed: unknown = JSON.parse(text);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
        throw new Error('invalid outer document');
      const document = parsed as Record<string, unknown>;
      const keys = Object.keys(document).sort();
      if (keys.length !== OUTER_KEYS.length || keys.some((key, index) => key !== OUTER_KEYS[index]) ||
          document.format !== FORMAT || document.version !== 1 || document.purpose !== this.#purpose ||
          typeof document.documentId !== 'string' || !UUID_V4.test(document.documentId) ||
          typeof document.payload !== 'string')
        throw new Error('invalid outer document');
      const cipher = new PayloadCipher(this.#key, document.documentId);
      const plaintext = cipher.open(document.payload,
        ['behalvo/private-model-state/v1', this.#purpose, 1]);
      if (Buffer.byteLength(plaintext, 'utf8') > MODEL_STATE_LIMITS.plaintextBytes)
        throw new Error('plaintext too large');
      return { documentId: document.documentId, plaintext };
    } catch {
      throw new ModelStateError('unavailable');
    }
  }
}
