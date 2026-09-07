import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export type PiCredential =
  | { type: 'api_key'; key?: string; env?: Record<string, string> }
  | { type: 'oauth'; access: string; refresh: string; expires: number; [key: string]: unknown };

type AuthFile = Record<string, PiCredential>;

function clone<T>(value: T): T {
  return structuredClone(value);
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

export class PiCredentialFileStore {
  #chain: Promise<unknown> = Promise.resolve();

  constructor(readonly path: string) {}

  async #load(): Promise<AuthFile> {
    let text: string;
    try {
      text = await readFile(this.path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
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

  async read(providerId: string): Promise<PiCredential | undefined> {
    const value = (await this.#load())[providerId];
    return value ? clone(value) : undefined;
  }

  async modify(
    providerId: string,
    fn: (current: PiCredential | undefined) => Promise<PiCredential | undefined>
  ): Promise<PiCredential | undefined> {
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
        const current = data[providerId] ? clone(data[providerId]) : undefined;
        const next = await fn(current);
        if (next === undefined) {
          resolveResult(current);
          return;
        }
        validateCredential(providerId, next);
        data[providerId] = clone(next);
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

  async delete(providerId: string): Promise<void> {
    const previous = this.#chain;
    const operation = (async () => {
      await previous.catch(() => undefined);
      const data = await this.#load();
      if (!(providerId in data)) return;
      delete data[providerId];
      await this.#save(data);
    })();
    this.#chain = operation.catch(() => undefined);
    await operation;
  }
}
