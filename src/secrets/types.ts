import { createHash, randomBytes } from 'node:crypto';

export const SECRET_ERROR = 'Secret storage operation failed.';
export const SECRET_CALLBACK_ERROR = 'Secret callback failed.';
export const MAXIMUM_SECRET_BYTES = 16 * 1024;

export interface SecretScope {
  service: string;
  connectionId: string;
  purpose: string;
  accountId: string;
}

export interface SecretReference extends SecretScope {
  reference: string;
}

export interface SecretMetadata extends SecretReference {
  provider: 'synthetic' | 'keychain';
  createdAt: string;
}

export interface SecretPut extends SecretScope { value: Uint8Array }
export interface SecretListQuery { service: string; connectionId: string; accountId: string; purpose?: string }
export interface SecretCallOptions { signal?: AbortSignal }

export interface SecretProvider {
  put(input: SecretPut, options?: SecretCallOptions): Promise<SecretMetadata>;
  withSecret<T>(input: SecretReference, use: (secret: Uint8Array) => Promise<T> | T,
    options?: SecretCallOptions): Promise<T>;
  delete(input: SecretReference, options?: SecretCallOptions): Promise<void>;
  list(input: SecretListQuery, options?: SecretCallOptions): Promise<SecretMetadata[]>;
}

function fail(): never { throw new Error(SECRET_ERROR); }

function record(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function exactSecretObject(value: unknown, required: readonly string[], optional: readonly string[] = []):
Record<string, unknown> {
  if (!record(value)) fail();
  const keys = Object.keys(value);
  if (required.some(key => !Object.hasOwn(value, key)) ||
      keys.some(key => !required.includes(key) && !optional.includes(key)) ||
      keys.length < required.length || keys.length > required.length + optional.length) fail();
  return value;
}

export function secretIdentifier(value: unknown): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 128 ||
      !/^[A-Za-z0-9._:-]+$/.test(value)) fail();
  return value;
}

export function parseSecretScope(value: unknown): SecretScope {
  const item = exactSecretObject(value, ['service', 'connectionId', 'purpose', 'accountId']);
  return { service: secretIdentifier(item.service), connectionId: secretIdentifier(item.connectionId),
    purpose: secretIdentifier(item.purpose), accountId: secretIdentifier(item.accountId) };
}

export function parseSecretReference(value: unknown): SecretReference {
  const item = exactSecretObject(value, ['service', 'connectionId', 'purpose', 'accountId', 'reference']);
  const scope = parseSecretScope({ service: item.service, connectionId: item.connectionId,
    purpose: item.purpose, accountId: item.accountId });
  if (typeof item.reference !== 'string' || !/^secret_[A-Za-z0-9_-]{43}$/.test(item.reference)) fail();
  if (item.reference !== secretReferenceFor(scope)) fail();
  return { ...scope, reference: item.reference };
}

export function parseSecretPut(value: unknown): SecretPut {
  const item = exactSecretObject(value, ['service', 'connectionId', 'purpose', 'accountId', 'value']);
  const scope = parseSecretScope({ service: item.service, connectionId: item.connectionId,
    purpose: item.purpose, accountId: item.accountId });
  if (!(item.value instanceof Uint8Array) || item.value.byteLength < 1 || item.value.byteLength > MAXIMUM_SECRET_BYTES)
    fail();
  return { ...scope, value: item.value };
}

export function parseSecretListQuery(value: unknown): SecretListQuery {
  const item = exactSecretObject(value, ['service', 'connectionId', 'accountId'], ['purpose']);
  return { service: secretIdentifier(item.service), connectionId: secretIdentifier(item.connectionId),
    accountId: secretIdentifier(item.accountId),
    ...(item.purpose === undefined ? {} : { purpose: secretIdentifier(item.purpose) }) };
}

export function parseSecretCallOptions(value: unknown): SecretCallOptions {
  if (value === undefined) return {};
  const item = exactSecretObject(value, [], ['signal']);
  if (item.signal !== undefined && !(item.signal instanceof AbortSignal)) fail();
  return item.signal === undefined ? {} : { signal: item.signal };
}

export function secretReferenceFor(scope: SecretScope): string {
  const body = JSON.stringify([scope.service, scope.connectionId, scope.purpose, scope.accountId]);
  return `secret_${createHash('sha256').update(body, 'utf8').digest('base64url')}`;
}

export function secretMetadata(scope: SecretScope, provider: SecretMetadata['provider'], createdAt: string): SecretMetadata {
  return Object.freeze({ service: scope.service, connectionId: scope.connectionId, purpose: scope.purpose,
    accountId: scope.accountId, reference: secretReferenceFor(scope), provider, createdAt });
}

export function safeSecretError(): Error { return new Error(SECRET_ERROR); }
export function safeSecretCallbackError(): Error { return new Error(SECRET_CALLBACK_ERROR); }

/** @internal Used only to make opaque in-memory ownership tokens. */
export function secretOwnerToken(): string { return randomBytes(32).toString('base64url'); }
