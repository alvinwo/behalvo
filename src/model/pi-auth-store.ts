import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  MODEL_STATE_LIMITS,
  ModelStateError,
  validModelStateIdentifier,
  type ModelStateOperationOptions,
  type ModelStatePreflightOptions,
  type ModelStateProtectionOptions
} from '../storage/model-state-codec.js';
import { PrivateModelStateFile } from '../storage/private-model-state-file.js';

export type PiCredential =
  | { type: 'api_key'; key?: string; env?: Record<string, string> }
  | { type: 'oauth'; access: string; refresh: string; expires: number; [key: string]: unknown };

export interface PiCredentialInfo {
  providerId: string;
  type: PiCredential['type'];
}

type AuthFile = Record<string, PiCredential>;

function clone<T>(value: T): T {
  return structuredClone(value);
}

function ownDataEntries(value: object): [string, unknown][] {
  if (Object.getOwnPropertySymbols(value).length !== 0) throw new Error('symbol key');
  const entries: [string, unknown][] = [];
  for (const key of Object.getOwnPropertyNames(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable)
      throw new Error('non-data property');
    entries.push([key, descriptor.value]);
  }
  return entries;
}

function plainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validateJsonExtension(root: unknown): void {
  if (root === null || typeof root === 'string' || typeof root === 'boolean') return;
  if (typeof root === 'number') {
    if (!Number.isFinite(root)) throw new Error('non-finite number');
    return;
  }
  if (typeof root !== 'object') throw new Error('unsupported JSON value');

  type Frame = { value: object; depth: number; leave: boolean };
  const active = new WeakSet<object>();
  const stack: Frame[] = [{ value: root, depth: 1, leave: false }];
  while (stack.length) {
    const frame = stack.pop()!;
    if (frame.leave) {
      active.delete(frame.value);
      continue;
    }
    if (frame.depth > MODEL_STATE_LIMITS.extensionDepth || active.has(frame.value))
      throw new Error('invalid JSON graph');
    active.add(frame.value);
    stack.push({ ...frame, leave: true });
    let children: unknown[];
    if (Array.isArray(frame.value)) {
      if (Object.getOwnPropertySymbols(frame.value).length !== 0) throw new Error('symbol key');
      const names = Object.getOwnPropertyNames(frame.value);
      if (names.length !== frame.value.length + 1 || names.at(-1) !== 'length')
        throw new Error('sparse or extended array');
      children = [];
      for (let index = 0; index < frame.value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(frame.value, String(index));
        if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable)
          throw new Error('sparse or accessor array');
        children.push(descriptor.value);
      }
    } else {
      if (!plainObject(frame.value)) throw new Error('non-plain object');
      children = ownDataEntries(frame.value).map(([, value]) => value);
    }
    for (const child of children) {
      if (child === null || typeof child === 'string' || typeof child === 'boolean') continue;
      if (typeof child === 'number') {
        if (!Number.isFinite(child)) throw new Error('non-finite number');
      } else if (typeof child === 'object') {
        stack.push({ value: child, depth: frame.depth + 1, leave: false });
      } else {
        throw new Error('unsupported JSON value');
      }
    }
  }
}

function validateCredential(providerId: string, value: unknown): asserts value is PiCredential {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`Invalid auth.json credential for provider "${providerId}"`);
  const credential = value as Record<string, unknown>;
  if (credential.type === 'api_key') {
    if (credential.key !== undefined && typeof credential.key !== 'string')
      throw new Error(`Invalid auth.json credential for provider "${providerId}"`);
    if (credential.env !== undefined) {
      if (!credential.env || typeof credential.env !== 'object' || Array.isArray(credential.env))
        throw new Error(`Invalid auth.json credential for provider "${providerId}"`);
      if (!Object.values(credential.env).every(entry => typeof entry === 'string'))
        throw new Error(`Invalid auth.json credential for provider "${providerId}"`);
    }
    return;
  }
  if (
    credential.type === 'oauth' &&
    typeof credential.access === 'string' &&
    typeof credential.refresh === 'string' &&
    typeof credential.expires === 'number' &&
    Number.isFinite(credential.expires)
  ) return;
  throw new Error(`Invalid auth.json credential for provider "${providerId}"`);
}

function validateProtectedCredential(value: unknown): asserts value is PiCredential {
  if (!plainObject(value)) throw new Error('invalid credential');
  const entries = ownDataEntries(value);
  const fields = Object.fromEntries(entries) as Record<string, unknown>;
  if (fields.type === 'api_key') {
    if (entries.some(([key]) => key !== 'type' && key !== 'key' && key !== 'env'))
      throw new Error('invalid api-key field');
    if (fields.key !== undefined && typeof fields.key !== 'string')
      throw new Error('invalid api key');
    if (fields.env !== undefined) {
      if (!plainObject(fields.env)) throw new Error('invalid env');
      for (const [, entry] of ownDataEntries(fields.env))
        if (typeof entry !== 'string') throw new Error('invalid env');
    }
    return;
  }
  if (fields.type !== 'oauth' || typeof fields.access !== 'string' ||
      typeof fields.refresh !== 'string' || typeof fields.expires !== 'number' ||
      !Number.isFinite(fields.expires))
    throw new Error('invalid oauth credential');
  for (const [key, extension] of entries) {
    if (key === 'type' || key === 'access' || key === 'refresh' || key === 'expires') continue;
    validateJsonExtension(extension);
  }
}

function validateProtectedAuthFile(value: unknown): asserts value is AuthFile {
  if (!plainObject(value)) throw new Error('invalid auth root');
  const entries = ownDataEntries(value);
  if (entries.length > MODEL_STATE_LIMITS.providers) throw new Error('too many providers');
  for (const [providerId, credential] of entries) {
    if (!validModelStateIdentifier(providerId)) throw new Error('invalid provider');
    validateProtectedCredential(credential);
  }
}

function emptyAuthFile(): AuthFile {
  return Object.create(null) as AuthFile;
}

export class PiCredentialFileStore {
  #chain: Promise<unknown> = Promise.resolve();
  readonly #protectedFile?: PrivateModelStateFile<AuthFile>;

  constructor(readonly path: string, options: ModelStateProtectionOptions = {}) {
    if (options.encryptionKey !== undefined) {
      this.#protectedFile = new PrivateModelStateFile(path, 'pi-credentials', options.encryptionKey, {
        empty: emptyAuthFile,
        validate: validateProtectedAuthFile
      });
    }
  }

  async #load(): Promise<AuthFile> {
    let text: string;
    try {
      text = await readFile(this.path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyAuthFile();
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new Error(`Invalid auth.json at ${this.path}: JSON parse failed`, { cause: error });
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      throw new Error(`Invalid auth.json at ${this.path}: root must be an object`);
    for (const [providerId, credential] of Object.entries(parsed))
      validateCredential(providerId, credential);
    return parsed as AuthFile;
  }

  async #save(data: AuthFile): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temp = `${this.path}.${randomUUID()}.tmp`;
    await writeFile(temp, `${JSON.stringify(data, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(temp, this.path);
    if (process.platform !== 'win32') await chmod(this.path, 0o600);
  }

  async preflight(options: ModelStatePreflightOptions = {}): Promise<void> {
    if (this.#protectedFile) return this.#protectedFile.preflight(options);
    await this.#load();
  }

  async read(providerId: string, options: ModelStateOperationOptions = {}): Promise<PiCredential | undefined> {
    const data = this.#protectedFile ? await this.#protectedFile.read(options) : await this.#load();
    const value = Object.hasOwn(data, providerId) ? data[providerId] : undefined;
    return value === undefined ? undefined : clone(value);
  }

  async list(options: ModelStateOperationOptions = {}): Promise<readonly PiCredentialInfo[]> {
    const data = this.#protectedFile ? await this.#protectedFile.read(options) : await this.#load();
    return Object.entries(data).map(([providerId, credential]) => ({ providerId, type: credential.type }));
  }

  async modify(
    providerId: string,
    fn: (current: PiCredential | undefined) => Promise<PiCredential | undefined>,
    options: ModelStateOperationOptions = {}
  ): Promise<PiCredential | undefined> {
    if (this.#protectedFile) {
      if (!validModelStateIdentifier(providerId) || typeof fn !== 'function') throw new ModelStateError('update');
      return this.#protectedFile.update(async data => {
        const original = Object.hasOwn(data, providerId) ? clone(data[providerId]!) : undefined;
        const candidate = await fn(original === undefined ? undefined : clone(original));
        if (candidate === undefined) return { next: undefined, result: original };
        try {
          validateProtectedCredential(candidate);
          const stored = clone(candidate);
          Object.defineProperty(data, providerId, {
            value: stored, enumerable: true, configurable: true, writable: true
          });
          return { next: data, result: clone(stored) };
        } catch {
          throw new ModelStateError('update');
        }
      }, options);
    }

    let resolveResult!: (value: PiCredential | undefined) => void;
    let rejectResult!: (reason: unknown) => void;
    const result = new Promise<PiCredential | undefined>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    const previous = this.#chain;
    const operation = (async () => {
      await previous.catch(() => undefined);
      try {
        const data = await this.#load();
        const current = Object.hasOwn(data, providerId) ? clone(data[providerId]!) : undefined;
        const next = await fn(current === undefined ? undefined : clone(current));
        if (next === undefined) {
          resolveResult(current);
          return;
        }
        validateCredential(providerId, next);
        Object.defineProperty(data, providerId, {
          value: clone(next), enumerable: true, configurable: true, writable: true
        });
        await this.#save(data);
        resolveResult(clone(next));
      } catch (error) {
        rejectResult(error);
        throw error;
      }
    })();
    this.#chain = operation.catch(() => undefined);
    return result;
  }

  async delete(providerId: string, options: ModelStateOperationOptions = {}): Promise<void> {
    if (this.#protectedFile) {
      if (!validModelStateIdentifier(providerId)) throw new ModelStateError('update');
      await this.#protectedFile.update(async data => {
        if (!Object.hasOwn(data, providerId)) return { next: undefined, result: undefined };
        delete data[providerId];
        return { next: data, result: undefined };
      }, options);
      return;
    }
    const previous = this.#chain;
    const operation = (async () => {
      await previous.catch(() => undefined);
      const data = await this.#load();
      if (!Object.hasOwn(data, providerId)) return;
      delete data[providerId];
      await this.#save(data);
    })();
    this.#chain = operation.catch(() => undefined);
    await operation;
  }
}
