import { chmod, mkdir, open, readFile, rename, rm, writeFile, type FileHandle } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import type { ModelRef } from '../model/types.js';

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

export function settingsPathForDatabase(dbPath: string): string {
  return `${dbPath}.settings.json`;
}

export class ModelSettingsStore {
  #chain: Promise<void> = Promise.resolve();

  constructor(readonly path: string) {}

  async #load(): Promise<SettingsFile> {
    let text: string;
    try {
      text = await readFile(this.path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, workspaces: {} };
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

  async read(workspaceId: string): Promise<ModelRef | undefined> {
    const workspaces = (await this.#load()).workspaces;
    const selection = Object.hasOwn(workspaces, workspaceId) ? workspaces[workspaceId] : undefined;
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
