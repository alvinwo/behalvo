import { randomUUID } from 'node:crypto';
import { toUSVString } from 'node:util';
import { PrivateEncryptedJsonFile } from '../storage/private-encrypted-json-file.js';
import {
  loginOrigin, loginReference, loginValue, syntheticLoginAuthority, vaultError, vaultObject, vaultScope, vaultText,
  type LoginBytes, type LoginInput, type LoginMetadata, type LoginReference, type VaultOperationOptions, type VaultScope
} from './types.js';

interface Entry extends LoginMetadata, VaultScope { username?: string; password?: string }
interface Document { version: 1; initialized: boolean; entries: Entry[] }
const noop = (): void => {};
const schema = {
  empty: (): Document => ({ version: 1, initialized: false, entries: [] }),
  validate(value: unknown): asserts value is Document {
    vaultObject(value, ['version', 'initialized', 'entries']);
    if (value.version !== 1 || typeof value.initialized !== 'boolean' || !Array.isArray(value.entries) ||
        value.entries.length > 128 || !value.initialized && value.entries.length) throw vaultError();
    const ids = new Set<string>();
    for (const item of value.entries) {
      const active = item?.status === 'active';
      vaultObject(item, ['id', 'label', 'origin', 'revision', 'status', 'workspaceId', 'ownerId',
        ...(active ? ['username', 'password'] : [])]);
      const ref = loginReference({ id: item.id, revision: item.revision, origin: item.origin });
      vaultScope({ workspaceId: item.workspaceId, ownerId: item.ownerId }); vaultText(item.label, 128);
      if ((!active && item.status !== 'removed') || ids.has(ref.id)) throw vaultError();
      ids.add(ref.id);
      if (active) {
        storedValue(item.username, 1024); storedValue(item.password, 16384);
      }
    }
  }
};
function storedValue(value: unknown, max: number): asserts value is string {
  if (typeof value !== 'string' || !value.length || toUSVString(value) !== value ||
      Buffer.byteLength(value, 'utf8') > max) throw vaultError();
}
function metadata(entry: Entry): LoginMetadata {
  return { id: entry.id, label: entry.label, origin: entry.origin, revision: entry.revision, status: entry.status };
}
function sameScope(a: VaultScope, b: VaultScope): boolean { return a.workspaceId === b.workspaceId && a.ownerId === b.ownerId; }
function initialized(document: Document): void { if (!document.initialized) throw vaultError(); }
function entry(document: Document, scope: VaultScope, id: string, revision: number): Entry {
  initialized(document);
  const found = document.entries.find(item => item.id === id && sameScope(item, scope));
  if (!found || found.status !== 'active' || found.revision !== revision) throw vaultError();
  return found;
}
function capture(input: LoginInput, authority?: typeof syntheticLoginAuthority) {
  vaultObject(input, ['label', 'origin', 'username', 'password']); vaultText(input.label, 128);
  const origin = loginOrigin(input.origin, authority === syntheticLoginAuthority);
  return { label: input.label, origin, username: loginValue(input.username, 1024), password: loginValue(input.password, 16384) };
}

/** Trusted local credential custody. Never pass this object to model tools or untrusted plugins. */
export class LocalCredentialVault {
  #file: PrivateEncryptedJsonFile<Document> | undefined;
  #epoch = 0;
  #controller = new AbortController();
  readonly #borrowed = new Set<Uint8Array>();
  constructor(private readonly config: { path: string; loadKey(): Uint8Array }) {}
  get epoch(): number { return this.#epoch; }
  get isUnlocked(): boolean { return this.#file !== undefined; }

  #newFile(): PrivateEncryptedJsonFile<Document> {
    const key = this.config.loadKey();
    try { return new PrivateEncryptedJsonFile(this.config.path, 'credential-vault', key, schema); }
    finally { key.fill(0); }
  }
  #invalidate(): void {
    this.#epoch++; this.#cancelUses();
  }
  #cancelUses(): void {
    this.#controller.abort(); this.#controller = new AbortController();
    for (const bytes of this.#borrowed) bytes.fill(0);
  }
  lock(): void { this.#invalidate(); this.#file?.dispose(); this.#file = undefined; }

  async initialize(scope: VaultScope): Promise<void> {
    let file: PrivateEncryptedJsonFile<Document> | undefined;
    try {
      vaultScope(scope); if (this.#file) throw vaultError();
      const epoch = this.#epoch; file = this.#newFile();
      await file.update(async current => {
        if (current.initialized) throw vaultError();
        return { next: { ...current, initialized: true }, result: undefined };
      }, { beforePublish: () => { if (this.#epoch !== epoch) throw vaultError(); } });
      if (this.#epoch !== epoch) throw vaultError();
      this.#file = file; file = undefined;
    } catch { throw vaultError(); }
    finally { file?.dispose(); }
  }
  async unlock(): Promise<void> {
    let file: PrivateEncryptedJsonFile<Document> | undefined;
    try {
      this.lock(); const epoch = this.#epoch; file = this.#newFile();
      initialized(await file.read());
      if (this.#epoch !== epoch) throw vaultError();
      this.#file = file; file = undefined;
    } catch { throw vaultError(); }
    finally { file?.dispose(); }
  }
  #operation(options: VaultOperationOptions = { assertCurrent: noop }) {
    const file = this.#file, epoch = this.#epoch, stopped = this.#controller.signal;
    if (!file || !options || typeof options.assertCurrent !== 'function' ||
        options.signal !== undefined && !(options.signal instanceof AbortSignal)) throw vaultError();
    const signal = options.signal ? AbortSignal.any([stopped, options.signal]) : stopped;
    const check = () => {
      if (signal.aborted || this.#epoch !== epoch || this.#file !== file) throw vaultError();
      options.assertCurrent();
    };
    check(); return { file, check, signal };
  }
  async list(rawScope: VaultScope): Promise<LoginMetadata[]> {
    try {
      const scope = vaultScope(rawScope), op = this.#operation();
      const document = await op.file.read({ signal: op.signal }); op.check(); initialized(document);
      return document.entries.filter(item => item.status === 'active' && sameScope(item, scope)).map(metadata);
    } catch { throw vaultError(); }
  }
  async add(rawScope: VaultScope, input: LoginInput, options: VaultOperationOptions,
    authority?: typeof syntheticLoginAuthority): Promise<LoginMetadata> {
    try {
      const scope = vaultScope(rawScope), values = capture(input, authority), op = this.#operation(options);
      return await op.file.update(async current => {
        op.check(); initialized(current); if (current.entries.length >= 128) throw vaultError();
        const saved: Entry = { ...scope, ...values, id: `login_${randomUUID()}`, revision: 1, status: 'active' };
        return { next: { ...current, entries: [...current.entries, saved] }, result: metadata(saved) };
      }, { signal: op.signal, beforePublish: op.check });
    } catch { throw vaultError(); }
  }
  async replace(rawScope: VaultScope, id: string, expectedRevision: number, input: LoginInput,
    options: VaultOperationOptions, authority?: typeof syntheticLoginAuthority): Promise<LoginMetadata> {
    try {
      const scope = vaultScope(rawScope), values = capture(input, authority);
      this.#cancelUses(); const op = this.#operation(options);
      return await op.file.update(async current => {
        op.check(); const old = entry(current, scope, id, expectedRevision);
        // Origin changes create a new entry rather than silently rebind an existing account.
        if (old.origin !== values.origin || old.revision >= Number.MAX_SAFE_INTEGER) throw vaultError();
        const saved: Entry = { ...old, ...values, revision: old.revision + 1 };
        return { next: { ...current, entries: current.entries.map(item => item.id === id ? saved : item) }, result: metadata(saved) };
      }, { signal: op.signal, beforePublish: op.check });
    } catch { throw vaultError(); }
  }
  async remove(rawScope: VaultScope, id: string, expectedRevision: number): Promise<void> {
    try {
      const scope = vaultScope(rawScope); this.#cancelUses(); const op = this.#operation();
      await op.file.update(async current => {
        op.check(); const old = entry(current, scope, id, expectedRevision);
        if (old.revision >= Number.MAX_SAFE_INTEGER) throw vaultError();
        const saved: Entry = { ...scope, ...metadata(old), revision: old.revision + 1, status: 'removed' };
        return { next: { ...current, entries: current.entries.map(item => item.id === id ? saved : item) }, result: undefined };
      }, { signal: op.signal, beforePublish: op.check });
    } catch { throw vaultError(); }
  }
  async withLogin<T>(rawScope: VaultScope, rawReference: LoginReference,
    use: (login: LoginBytes, assertCurrent: () => void) => Promise<T> | T, options: VaultOperationOptions): Promise<T> {
    let username: Buffer | undefined, password: Buffer | undefined;
    try {
      const scope = vaultScope(rawScope), reference = loginReference(rawReference), op = this.#operation(options);
      if (typeof use !== 'function') throw vaultError();
      return await op.file.update(async current => {
        op.check(); const found = entry(current, scope, reference.id, reference.revision);
        if (found.origin !== reference.origin) throw vaultError();
        username = Buffer.from(found.username!, 'utf8'); password = Buffer.from(found.password!, 'utf8');
        this.#borrowed.add(username); this.#borrowed.add(password);
        op.check(); const result = await use({ username, password }, op.check); op.check();
        return { next: undefined, result };
      }, { signal: op.signal, beforePublish: op.check });
    } catch { throw vaultError(); }
    finally {
      for (const bytes of [username, password]) if (bytes) { bytes.fill(0); this.#borrowed.delete(bytes); }
    }
  }
}
