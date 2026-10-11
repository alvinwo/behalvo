import { TextDecoder, toUSVString } from 'node:util';

export const VAULT_ERROR = 'Credential vault unavailable.';
export const SYNTHETIC_LOGIN_ORIGIN = 'http://127.0.0.1:43118';
export interface VaultScope { workspaceId: string; ownerId: string }
export interface LoginMetadata {
  id: string; label: string; origin: string; revision: number; status: 'active' | 'removed';
}
export interface LoginReference { id: string; revision: number; origin: string }
export interface LoginInput { label: string; origin: string; username: Uint8Array; password: Uint8Array }
export interface LoginBytes { username: Uint8Array; password: Uint8Array }
export interface VaultOperationOptions { signal?: AbortSignal; assertCurrent(): void }

export function vaultError(): Error { return new Error(VAULT_ERROR); }
export function vaultObject(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
      Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) throw vaultError();
}
export function vaultText(value: unknown, maximum: number): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || toUSVString(value) !== value ||
      /[\u0000-\u001f\u007f-\u009f]/u.test(value) || Buffer.byteLength(value, 'utf8') > maximum) throw vaultError();
}
export function vaultScope(value: unknown): VaultScope {
  vaultObject(value, ['workspaceId', 'ownerId']);
  vaultText(value.workspaceId, 128); vaultText(value.ownerId, 128);
  return { workspaceId: value.workspaceId, ownerId: value.ownerId };
}
export function loginOrigin(value: unknown, synthetic = false): string {
  vaultText(value, 2048);
  const url = new URL(value);
  if (url.origin !== value || url.username || url.password || url.hash || url.search ||
      url.hostname.includes('*') || !(url.protocol === 'https:' || synthetic && value === SYNTHETIC_LOGIN_ORIGIN)) throw vaultError();
  return value;
}
export function loginReference(value: unknown): LoginReference {
  vaultObject(value, ['id', 'revision', 'origin']);
  if (typeof value.id !== 'string' || !/^login_[0-9a-f-]{36}$/.test(value.id) ||
      !Number.isSafeInteger(value.revision) || Number(value.revision) < 1) throw vaultError();
  return { id: value.id, revision: Number(value.revision), origin: loginOrigin(value.origin, true) };
}
export function loginValue(value: unknown, maximum: number): string {
  if (!(value instanceof Uint8Array) || value.byteLength === 0 || value.byteLength > maximum) throw vaultError();
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(value);
}

/** Application-only authority. It must be supplied by the owned compiled fixture. */
export const syntheticLoginAuthority: unique symbol = Symbol('owned synthetic login fixture');
