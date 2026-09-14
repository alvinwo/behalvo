import { chmod, mkdir, open, readFile, rename, rm, writeFile, type FileHandle } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import type { ModelRef } from '../model/types.js';
import {
  MODEL_STATE_LIMITS,
  ModelStateError,
  validModelStateIdentifier,
  type ModelStatePreflightOptions,
  type ModelStateProtectionOptions
} from '../storage/model-state-codec.js';
import { PrivateModelStateFile } from '../storage/private-model-state-file.js';

interface SettingsFile {
  version: 1;
  workspaces: Record<string, ModelRef>;
}

function malformed(path: string): Error {
  return new Error(`Model settings are malformed at ${path}; remove that settings file and select again with /model <provider> <model>.`);
}

function validText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\u0000-\u001f\u007f]/.test(value);
}

function validate(path: string, value: unknown): asserts value is SettingsFile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw malformed(path);
  const root = value as Record<string, unknown>;
  if (Object.keys(root).some(key => key !== 'version' && key !== 'workspaces') || root.version !== 1 ||
      !root.workspaces || typeof root.workspaces !== 'object' || Array.isArray(root.workspaces)) throw malformed(path);
  for (const [workspace, selection] of Object.entries(root.workspaces as Record<string, unknown>)) {
    if (!validText(workspace) || !selection || typeof selection !== 'object' || Array.isArray(selection)) throw malformed(path);
    const entry = selection as Record<string, unknown>;
    if (Object.keys(entry).some(key => key !== 'provider' && key !== 'model') ||
        !validText(entry.provider) || !validText(entry.model)) throw malformed(path);
  }
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

function protectedSelection(value: unknown): ModelRef {
  if (!plainObject(value)) throw new Error('invalid selection');
  const entries = ownDataEntries(value);
  if (entries.length !== 2 || entries.some(([key]) => key !== 'provider' && key !== 'model'))
    throw new Error('invalid selection');
  const provider = entries.find(([key]) => key === 'provider')?.[1];
  const model = entries.find(([key]) => key === 'model')?.[1];
  if (!validModelStateIdentifier(provider) || !validModelStateIdentifier(model))
    throw new Error('invalid selection');
  return { provider, model };
}

function validateProtectedSettings(value: unknown): asserts value is SettingsFile {
  if (!plainObject(value)) throw new Error('invalid settings root');
  const rootEntries = ownDataEntries(value);
  if (rootEntries.length !== 2 || rootEntries.some(([key]) => key !== 'version' && key !== 'workspaces'))
    throw new Error('invalid settings root');
  const version = rootEntries.find(([key]) => key === 'version')?.[1];
  const workspaces = rootEntries.find(([key]) => key === 'workspaces')?.[1];
  if (version !== 1 || !plainObject(workspaces)) throw new Error('invalid settings root');
  const entries = ownDataEntries(workspaces);
  if (entries.length > MODEL_STATE_LIMITS.workspaces) throw new Error('too many workspaces');
  for (const [workspace, selection] of entries) {
    if (!validModelStateIdentifier(workspace)) throw new Error('invalid workspace');
    protectedSelection(selection);
  }
}

function emptySettings(): SettingsFile {
  return { version: 1, workspaces: Object.create(null) as Record<string, ModelRef> };
}

export function settingsPathForDatabase(dbPath: string): string {
  return `${dbPath}.settings.json`;
}

export class ModelSettingsStore {
  #chain: Promise<void> = Promise.resolve();
  readonly #protectedFile?: PrivateModelStateFile<SettingsFile>;

  constructor(readonly path: string, options: ModelStateProtectionOptions = {}) {
    if (options.encryptionKey !== undefined) {
      this.#protectedFile = new PrivateModelStateFile(path, 'model-settings', options.encryptionKey, {
        empty: emptySettings,
        validate: validateProtectedSettings
      });
    }
  }

  async #load(): Promise<SettingsFile> {
    let text: string;
    try {
      text = await readFile(this.path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptySettings();
      throw error;
    }
    try {
      const parsed: unknown = JSON.parse(text);
      validate(this.path, parsed);
      return parsed;
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Model settings are malformed')) throw error;
      throw malformed(this.path);
    }
  }

  async preflight(options: ModelStatePreflightOptions = {}): Promise<void> {
    if (this.#protectedFile) return this.#protectedFile.preflight(options);
    await this.#load();
  }

  async read(workspaceId: string): Promise<ModelRef | undefined> {
    const data = this.#protectedFile ? await this.#protectedFile.read() : await this.#load();
    const selection = Object.hasOwn(data.workspaces, workspaceId) ? data.workspaces[workspaceId] : undefined;
    return selection ? structuredClone(selection) : undefined;
  }

  async #acquireWriteLock(): Promise<FileHandle> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const lockPath = `${this.path}.lock`;
    const deadline = Date.now() + 5000;
    for (;;) {
      try {
        return await open(lockPath, 'wx', 0o600);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST')
          throw new Error(`Unable to lock model settings at ${lockPath}; selection was not saved.`);
        if (Date.now() >= deadline)
          throw new Error(`Timed out locking model settings at ${lockPath}; selection was not saved. Remove the lock only when no Behalvo process is using these settings.`);
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    }
  }

  async write(workspaceId: string, selection: ModelRef): Promise<void> {
    if (this.#protectedFile) {
      let stored: ModelRef;
      try {
        if (!validModelStateIdentifier(workspaceId)) throw new Error('invalid workspace');
        stored = protectedSelection(selection);
      } catch {
        throw new ModelStateError('update');
      }
      await this.#protectedFile.update(async data => {
        Object.defineProperty(data.workspaces, workspaceId, {
          value: structuredClone(stored), enumerable: true, configurable: true, writable: true
        });
        return { next: data, result: undefined };
      });
      return;
    }
    if (!validText(workspaceId) || !validText(selection.provider) || !validText(selection.model)) throw malformed(this.path);
    const operation = this.#chain.catch(() => undefined).then(async () => {
      const lock = await this.#acquireWriteLock();
      const lockPath = `${this.path}.lock`;
      let temp: string | undefined;
      try {
        const data = await this.#load();
        Object.defineProperty(data.workspaces, workspaceId, {
          value: { provider: selection.provider, model: selection.model },
          enumerable: true, configurable: true, writable: true
        });
        temp = `${this.path}.${randomUUID()}.tmp`;
        await writeFile(temp, `${JSON.stringify(data, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
        await rename(temp, this.path);
        temp = undefined;
        if (process.platform !== 'win32') await chmod(this.path, 0o600);
      } finally {
        try {
          if (temp) await rm(temp, { force: true });
        } finally {
          try {
            await lock.close();
          } finally {
            await rm(lockPath, { force: true });
          }
        }
      }
    });
    this.#chain = operation;
    await operation;
  }
}
