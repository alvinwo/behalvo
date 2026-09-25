import {
  parseSecretCallOptions,
  parseSecretListQuery,
  parseSecretPut,
  parseSecretReference,
  safeSecretCallbackError,
  safeSecretError,
  secretMetadata,
  type SecretCallOptions,
  type SecretListQuery,
  type SecretMetadata,
  type SecretProvider,
  type SecretPut,
  type SecretReference
} from './types.js';

export class SyntheticSecretProvider implements SecretProvider {
  readonly #clock: () => number;
  readonly #values = new Map<string, { metadata: SecretMetadata; value: Buffer }>();

  constructor(options: { clock?: () => number } = {}) { this.#clock = options.clock ?? Date.now; }

  async put(input: SecretPut, options?: SecretCallOptions): Promise<SecretMetadata> {
    try {
      const checked = parseSecretPut(input); this.#active(options);
      const metadata = secretMetadata(checked, 'synthetic', new Date(this.#clock()).toISOString());
      const previous = this.#values.get(metadata.reference);
      previous?.value.fill(0);
      this.#values.set(metadata.reference, { metadata, value: Buffer.from(checked.value) });
      return metadata;
    } catch { throw safeSecretError(); }
  }

  async withSecret<T>(input: SecretReference, use: (secret: Uint8Array) => Promise<T> | T,
    options?: SecretCallOptions): Promise<T> {
    let borrowed: Buffer | undefined;
    try {
      const checked = parseSecretReference(input); this.#active(options);
      if (typeof use !== 'function') throw safeSecretError();
      const stored = this.#values.get(checked.reference);
      if (!stored || !sameScope(stored.metadata, checked)) throw safeSecretError();
      borrowed = Buffer.from(stored.value);
      try { return await use(borrowed); }
      catch { throw safeSecretCallbackError(); }
    } catch (error) {
      if (error instanceof Error && error.message === 'Secret callback failed.') throw error;
      throw safeSecretError();
    } finally { borrowed?.fill(0); }
  }

  async delete(input: SecretReference, options?: SecretCallOptions): Promise<void> {
    try {
      const checked = parseSecretReference(input); this.#active(options);
      const stored = this.#values.get(checked.reference);
      if (!stored || !sameScope(stored.metadata, checked)) throw safeSecretError();
      stored.value.fill(0); this.#values.delete(checked.reference);
    } catch { throw safeSecretError(); }
  }

  async list(input: SecretListQuery, options?: SecretCallOptions): Promise<SecretMetadata[]> {
    try {
      const checked = parseSecretListQuery(input); this.#active(options);
      return [...this.#values.values()].map(item => item.metadata).filter(item =>
        item.service === checked.service && item.connectionId === checked.connectionId &&
        item.accountId === checked.accountId && (checked.purpose === undefined || item.purpose === checked.purpose))
        .sort((left, right) => left.purpose.localeCompare(right.purpose));
    } catch { throw safeSecretError(); }
  }

  #active(options: SecretCallOptions | undefined): void {
    const checked = parseSecretCallOptions(options);
    if (checked.signal?.aborted) throw safeSecretError();
  }
}

function sameScope(left: SecretReference, right: SecretReference): boolean {
  return left.service === right.service && left.connectionId === right.connectionId &&
    left.purpose === right.purpose && left.accountId === right.accountId && left.reference === right.reference;
}
