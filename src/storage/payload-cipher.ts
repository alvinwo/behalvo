import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes
} from 'node:crypto';
import { TextDecoder, toUSVString } from 'node:util';

const ENCRYPTION_LABEL = 'behalvo/storage/v1/encryption';
const LOOKUP_LABEL = 'behalvo/storage/v1/lookup';
const AAD_LABEL = 'behalvo/storage/v1';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

type ContextValue = string | number | null;

function decodeBase64(value: unknown, length?: number): Buffer {
  if (typeof value !== 'string' || !BASE64.test(value))
    throw new Error('invalid base64');
  const decoded = Buffer.from(value, 'base64');
  if (decoded.toString('base64') !== value || (length !== undefined && decoded.byteLength !== length))
    throw new Error('invalid base64');
  return decoded;
}

function validateContext(context: readonly ContextValue[]): void {
  if (!Array.isArray(context)) throw new Error('invalid context');
  for (const value of context) {
    if (value === null || typeof value === 'string') continue;
    if (typeof value !== 'number' || !Number.isFinite(value) || Object.is(value, -0))
      throw new Error('invalid context');
  }
}

function aad(databaseId: string, context: readonly ContextValue[]): Buffer {
  validateContext(context);
  return Buffer.from(JSON.stringify([AAD_LABEL, databaseId, ...context]), 'utf8');
}

export class PayloadCipher {
  readonly #databaseId: string;
  readonly #encryptionKey: Buffer;
  readonly #lookupKey: Buffer;

  constructor(key: Uint8Array, databaseId: string) {
    try {
      if (!(key instanceof Uint8Array) || key.byteLength !== 32 || typeof databaseId !== 'string' || !UUID.test(databaseId))
        throw new Error('invalid configuration');
      const rootKey = Buffer.from(key);
      try {
        const salt = Buffer.from(databaseId, 'utf8');
        this.#databaseId = databaseId;
        this.#encryptionKey = Buffer.from(hkdfSync('sha256', rootKey, salt, ENCRYPTION_LABEL, 32));
        this.#lookupKey = Buffer.from(hkdfSync('sha256', rootKey, salt, LOOKUP_LABEL, 32));
      } finally {
        rootKey.fill(0);
      }
    } catch {
      throw new Error('Invalid payload cipher configuration.');
    }
  }

  seal(value: string, context: readonly ContextValue[]): string {
    try {
      // UTF-8 encoding replaces lone UTF-16 surrogates; reject instead of changing the payload.
      if (typeof value !== 'string' || toUSVString(value) !== value) throw new Error('invalid plaintext');
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', this.#encryptionKey, iv, { authTagLength: 16 });
      cipher.setAAD(aad(this.#databaseId, context));
      const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
      const tag = cipher.getAuthTag();
      return JSON.stringify({
        v: 1,
        iv: iv.toString('base64'),
        tag: tag.toString('base64'),
        data: data.toString('base64')
      });
    } catch {
      throw new Error('Unable to seal encrypted payload.');
    }
  }

  open(value: string, context: readonly ContextValue[]): string {
    try {
      if (typeof value !== 'string') throw new Error('invalid envelope');
      const parsed: unknown = JSON.parse(value);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
        throw new Error('invalid envelope');
      const envelope = parsed as Record<string, unknown>;
      const keys = Object.keys(envelope).sort();
      if (keys.length !== 4 || keys[0] !== 'data' || keys[1] !== 'iv' || keys[2] !== 'tag' || keys[3] !== 'v' || envelope.v !== 1)
        throw new Error('invalid envelope');
      const iv = decodeBase64(envelope.iv, 12);
      const tag = decodeBase64(envelope.tag, 16);
      const data = decodeBase64(envelope.data);
      const decipher = createDecipheriv('aes-256-gcm', this.#encryptionKey, iv, { authTagLength: 16 });
      decipher.setAAD(aad(this.#databaseId, context));
      decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([decipher.update(data), decipher.final()]);
      return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(plaintext);
    } catch {
      throw new Error('Unable to open encrypted payload.');
    }
  }

  lookup(purpose: string, workspaceId: string, values: readonly string[]): string {
    try {
      if (typeof purpose !== 'string' || purpose.length === 0 || typeof workspaceId !== 'string' || workspaceId.length === 0 ||
          !Array.isArray(values) || !values.every(value => typeof value === 'string'))
        throw new Error('invalid lookup context');
      const input = JSON.stringify([LOOKUP_LABEL, purpose, workspaceId, ...values]);
      return createHmac('sha256', this.#lookupKey).update(input, 'utf8').digest('base64url');
    } catch {
      throw new Error('Unable to create lookup token.');
    }
  }
}
