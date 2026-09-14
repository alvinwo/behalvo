# Protected Model State Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Provide usable opt-in authenticated encryption and cross-process updates for Pi credentials and saved model selections.

**Architecture:** Keep plaintext compatibility in the existing adapters. A purpose-bound document codec and private file transaction helper own protected persistence; credential/settings stores own their schemas and Pi contracts. The agent and explicit live-evaluation entry points configure those adapters and preflight protection before downstream activity.

**Tech Stack:** TypeScript with strict/exact optional property checking, Node.js 22.19.0+ crypto/fs APIs, `node:test`, existing `PayloadCipher` and private-key helpers, pinned `@earendil-works/pi-ai` 0.85.1; no new dependency.

**Spec:** `docs/superpowers/specs/2026-09-14-private-model-state-design.md` (accepted in commit `d7fee83`). Read it and `.superpowers/sdd/2026-09-14-private-model-state/integration-notes.md` before implementation.

## Global Constraints

- All implementation and acceptance material must be synthetic.
- The kernel, journal, prepared operations, owner-control routes, SQLite format, and provider APIs do not change.
- Add `--model-state-key-file PATH` and `BEHALVO_MODEL_STATE_KEY_FILE`; the explicit flag wins. Reject empty configured values, duplicates, missing separate values, and `--model-state-key-file=` syntax. There is no legacy environment alias and no raw-key command argument.
- Explicit model-state flags are errors in agent offline and evaluation scripted/list/help modes. New environment configuration is ignored completely in offline/scripted/list/help/no-argument-help paths.
- Preserve existing model/auth precedence and existing plaintext formats/defaults. No key-file fallback, implicit import, key generation, migration, or mode conversion is allowed.
- Outer format is `behalvo-private-model-state`, version `1`, purpose `pi-credentials` or `model-settings`, canonical lowercase UUID v4 document ID, and a string `PayloadCipher` envelope. Authenticated context is `['behalvo/private-model-state/v1', expectedPurpose, 1]`.
- Reuse AES-256-GCM with a random 32-byte root key, fresh 12-byte IV, full 16-byte tag, and existing HKDF derivation. Do not alter existing cipher labels or SQLite envelopes.
- Protected bounds are 2 MiB for the outer file and 1 MiB for serialized plaintext. Credential maps allow at most 256 providers and settings at most 1,024 workspaces. Identifier strings allow 1..512 UTF-16 code units and no C0/DEL controls. Extra OAuth fields allow maximum container nesting depth 32.
- Protected lock suffix is `.behalvo-model-state-lock`; poll at 10 ms intervals for at most 5,000 ms using a monotonic elapsed clock. Never steal a lock based on PID, age, timeout, or caller cancellation.
- Protected operations require POSIX. New directories use `0700`, new data/staging/lock files `0600`; library reads allow existing data `0400`/`0600`, mutations and writer preflight require `0600`. Existing unsafe paths are not chmod-repaired.
- Expected-purpose authentication is separate from filesystem identity. No pathname is in AAD. Same-purpose copying and rollback remain possible with the matching key. Provider credentials are shared by the selected auth file, not isolated per workspace.
- The same key may explicitly serve SQLite/model state; it is never borrowed automatically. Reject every key-to-data/lock collision, including database and synthetic sidecar families, while allowing intentional key-to-key equality.
- Cancellation stops lock waiting and prevents a callback that has not started. Once started, await the callback and publish a valid result without an early lock release. Storage publication is not a transaction with a provider; failures must not cause callback retry or rollback claims.
- New storage errors have fixed messages and no raw causes. Protected gateway errors also sanitize returned Pi `errorMessage`. Trusted credential callback rejection preserves its Pi contract; supported protected user-facing paths sanitize it.
- No real account, live model call, remote identity, deployment, rotation, erasure, retention, coordinated backup, or readiness claim is included. CI gates are Node 22.19.0 and 24.x; scripted evidence remains non-live.

The three tasks are sequential review gates. Execute with the already-authorized
subagent-driven workflow; do not ask for an execution-mode choice. Use high effort
for this security-sensitive implementation/review. Each task owns its tests,
small required scaffolding, and relevant documentation comments.

## File responsibilities

| File | Responsibility | Owner task |
| --- | --- | --- |
| `src/storage/model-state-codec.ts` | Shared option/error/limit definitions and purpose-bound text envelopes | 1 |
| `src/storage/private-model-state-file.ts` | Private JSON read/preflight/update, canonical path resolution, non-reentrant lock, guarded publication | 1 |
| `src/storage/private-files.ts` | Additive validated descriptor snapshot helper; preserve existing callers | 1 |
| `src/model/pi-auth-store.ts` | Pi credential schemas, protected adapter, legacy adapter, metadata-only list | 2 |
| `src/cli/model-settings.ts` | Per-workspace settings schema and protected/legacy adapter | 2 |
| `src/model/pi-gateway.ts` | Protection-aware loader construction and optional fixed-error gateway boundary | 2 |
| `src/index.ts` | Export the shared adapter option type alongside existing Pi exports | 2 |
| `src/cli/model-state-config.ts` | Flag/environment resolution, complete path collision set, configured key loading | 3 |
| `src/cli/main.ts`, `src/evaluation/main.ts` | Startup ordering, shared options, offline isolation, lifecycle cleanup | 3 |
| Existing operational/status guides and verification record | User setup, boundaries, actual acceptance evidence | 3 |

### Task 1: Protected document codec and private file transactions

**Files:**

- Create `src/storage/model-state-codec.ts` and `src/storage/private-model-state-file.ts`.
- Modify `src/storage/private-files.ts` only for the additive descriptor snapshot API below.
- Create `tests/model-state-codec.test.mjs`, `tests/private-model-state-file.test.mjs`, and `tests/private-model-state-fault-child.mjs`.
- Modify `.gitignore` to include `*.behalvo-model-state-lock` and `.behalvo-model-state-stage-*/`.

**Consumes:** Existing `PayloadCipher(key: Uint8Array, databaseId: string)`,
`seal(text, context): string`, `open(envelope, context): string`,
`ensurePrivateDirectory(path): void`, `validatePrivateFile(path, options?): void`,
and the current private-file descriptor validation behavior. Read their source
and existing tests; do not weaken `publishPrivateFile`'s no-replacement contract.

**Produces — exact cross-task interfaces:**

```ts
// src/storage/model-state-codec.ts
export interface ModelStateProtectionOptions { encryptionKey?: Uint8Array }
export interface ModelStateOperationOptions { signal?: AbortSignal }
export interface ModelStatePreflightOptions extends ModelStateOperationOptions {
  writable?: boolean;
}
export type ModelStatePurpose = 'pi-credentials' | 'model-settings';
export type ModelStateErrorCode =
  'configuration' | 'key' | 'unavailable' | 'busy' | 'cancelled' | 'update';
export declare class ModelStateError extends Error {
  readonly code: ModelStateErrorCode;
  constructor(code: ModelStateErrorCode);
}
export const MODEL_STATE_LIMITS = {
  outerBytes: 2_097_152, plaintextBytes: 1_048_576,
  providers: 256, workspaces: 1_024, identifierUnits: 512,
  extensionDepth: 32, lockWaitMs: 5_000, lockPollMs: 10
} as const;
export declare function copyModelStateKey(key: Uint8Array): Uint8Array;
export declare function validModelStateIdentifier(value: unknown): value is string;
export declare class ModelStateCodec {
  constructor(key: Uint8Array, purpose: ModelStatePurpose);
  seal(plaintext: string, documentId?: string): { documentId: string; bytes: Buffer };
  open(bytes: Uint8Array): { documentId: string; plaintext: string };
}

// src/storage/private-files.ts; @internal, not exported from src/index.ts
export declare function readPrivateFileSnapshot(
  path: string, maximumBytes: number, options?: { readOnly?: boolean }
): { bytes: Buffer; device: bigint; inode: bigint };

// src/storage/private-model-state-file.ts
export interface ModelStateFileSchema<T> {
  empty(): T;
  validate(value: unknown): asserts value is T;
}
export interface ModelStateFileUpdate<T, R> {
  next: T | undefined;
  result: R;
}
export declare function resolveModelStatePath(path: string): string;
export declare class PrivateModelStateFile<T> {
  constructor(path: string, purpose: ModelStatePurpose,
    key: Uint8Array, schema: ModelStateFileSchema<T>);
  preflight(options?: ModelStatePreflightOptions): Promise<void>;
  read(options?: ModelStateOperationOptions): Promise<T>;
  update<R>(change: (current: T) => Promise<ModelStateFileUpdate<T, R>>,
    options?: ModelStateOperationOptions): Promise<R>;
}
```

`ModelStateError` maps its codes to these exact messages, without a cause:

| Code | Message |
| --- | --- |
| `configuration` | `Invalid private model state configuration.` |
| `key` | `Private model state key is unavailable.` |
| `unavailable` | `Private model state is unavailable.` |
| `busy` | `Private model state is busy.` |
| `cancelled` | `Private model state operation cancelled.` |
| `update` | `Private model state update failed.` |

`resolveModelStatePath` performs metadata-only canonicalization without creating
anything: reject invalid/root-only/NUL paths and a symlink immediate parent;
realpath an existing parent, or the nearest existing ancestor plus the missing
suffix. Leaf existence is not required. It does not validate database permission
modes or read file contents. The protected file class separately prepares private
parents and validates its own leaf, owner, modes, and identities.

`readPrivateFileSnapshot` reads through one validated `O_NOFOLLOW | O_NONBLOCK`
descriptor, returning that descriptor's device/inode. Use `fstat({bigint:true})`
and bounded reads. Default/read-only mode accepts `0400`/`0600`; `readOnly:false`
requires `0600`. Refactor existing `readPrivateFile` to return this helper's
`bytes`, preserving its current errors/limits and every existing key-file test.

- [ ] **Step 1: Write codec and first-file RED tests.** Use temporary `0700`
  directories and generated/fixed synthetic keys. The codec example is a
  complete test, with no provider import:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { ModelStateCodec } from '../dist/storage/model-state-codec.js';

test('model-state ciphertext binds purpose and ID while preserving key capture', () => {
  const callerKey = Buffer.alloc(32, 7);
  const recoveryKey = Buffer.from(callerKey);
  const codec = new ModelStateCodec(callerKey, 'pi-credentials');
  callerKey.fill(0);
  const plaintext = '{"synthetic-provider":{"type":"api_key","key":"secret-canary"}}';
  const first = codec.seal(plaintext);
  const second = codec.seal(plaintext, first.documentId);
  assert.equal(codec.open(first.bytes).plaintext, plaintext);
  assert.notDeepEqual(first.bytes, second.bytes);
  assert.equal(first.bytes.includes(Buffer.from('secret-canary')), false);
  assert.throws(() => new ModelStateCodec(recoveryKey, 'model-settings').open(first.bytes));
  const changed = JSON.parse(first.bytes.toString('utf8'));
  changed.documentId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  assert.throws(() => codec.open(Buffer.from(JSON.stringify(changed))));
  assert.equal(new ModelStateCodec(recoveryKey, 'pi-credentials').open(first.bytes).plaintext, plaintext);
});
```

Add table-driven envelope cases: unknown/extra fields, wrong `format`/`version`/
`purpose`, uppercase/non-v4 ID, invalid UTF-8, altered inner IV/tag/data, wrong
key, >2,097,152 outer bytes, and >1,048,576 plaintext bytes. Assert exact safe
messages and absent causes. Test accepted exact byte limits. A valid JSON string
with a leading BOM inside its value must survive; arbitrary non-JSON plaintext
is a codec concern only and must be rejected by the file schema/JSON layer.

In the file test use this schema and exercise missing read, writable preflight,
first write, reopen, and missing-after-observation:

```js
const schema = {
  empty: () => ({ count: 0 }),
  validate(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        Object.keys(value).length !== 1 || !Number.isSafeInteger(value.count))
      throw new Error('synthetic-schema-secret');
  }
};
const file = new PrivateModelStateFile(path, 'model-settings', key, schema);
await file.preflight({ writable: true });
assert.equal(existsSync(path), false);
assert.deepEqual(await file.read(), { count: 0 });
await file.update(async current => ({ next: { count: current.count + 1 }, result: 'saved' }));
assert.deepEqual(await file.read(), { count: 1 });
await unlink(path);
await assert.rejects(() => file.read(), { message: 'Private model state is unavailable.' });
```

Here `path` is `join(await mkdtemp(join(tmpdir(), 'behalvo-private-file-')), 'nested', 'state.json')`,
`key` is `Buffer.alloc(32, 8)`, and the test imports `PrivateModelStateFile`,
`existsSync`, `mkdtemp`, `unlink`, `rm`, `tmpdir`, and `join`; register parent
directory removal with `t.after`. No fixture depends on the checkout's `data/`.

- [ ] **Step 2: Run RED.** Run `npm run build` followed by
  `node --test tests/model-state-codec.test.mjs tests/private-model-state-file.test.mjs`.
  Confirm failures are missing APIs/protection behavior, not malformed test syntax.

- [ ] **Step 3: Implement the envelope and schema boundary.** Copy keys eagerly;
  generate IDs only when sealing a new document. Validate exact outer fields and
  byte limits, decode outer UTF-8 with a fatal decoder, call the unchanged cipher,
  and check plaintext UTF-8 byte size before returning it. Core binding:

```ts
const id = documentId ?? randomUUID();
const cipher = new PayloadCipher(this.key, id);
const payload = cipher.seal(plaintext,
  ['behalvo/private-model-state/v1', this.purpose, 1]);
const bytes = Buffer.from(JSON.stringify({
  format: 'behalvo-private-model-state', version: 1,
  purpose: this.purpose, documentId: id, payload
}) + '\n', 'utf8');
```

Keep schema validation out of the cipher: the private file class JSON-parses
authenticated plaintext, calls its typed schema validator, and maps malformed
existing data to `unavailable`. Validate/serialize a proposed replacement before
sealing; encoding/validation failure after a modifier returns is `update`.
The schema must establish JSON safety before `JSON.stringify`; Task 2 owns the
credential-specific traversal. Do not cache decoded documents between calls.

- [ ] **Step 4: Implement the private transaction lifecycle.** Use one physical
  exclusive file lock for all same-path operations, including different objects
  in the same process; no refcounted reentrancy. Use a `performance.now()` deadline
  and asynchronous waits. Create mode `0600` using exclusive/no-follow flags,
  validate descriptor UID/link count/mode/device/inode, and write only
  `{version:1,pid:process.pid,instanceId:randomUUID()}` metadata. Pin the canonical
  parent identity and owned lock identity. Existing unsafe locks fail; existing
  safe locks wait up to the global deadline. Honor abort before `change` begins,
  returning fixed `cancelled` without using `signal.reason` in an error.

Use this transaction ordering; `change` is intentionally outside storage-error
rewriting so trusted callback rejections preserve their original identity:

```ts
// The concrete helper owns descriptor and identity cleanup in finally.
const snapshot = await loadValidatedSnapshotUnderOwnedLock();
throwIfCancelledBeforeCallback(options?.signal);
const changed = await change(snapshot.value);
// Do not inspect cancellation again after the callback has started.
if (changed.next !== undefined) {
  schema.validate(changed.next);
  const encoded = codec.seal(JSON.stringify(changed.next), snapshot.documentId);
  await publishCiphertextWithOwnedIdentities(encoded.bytes, snapshot);
}
return changed.result;
```

The three names in this algorithm are private methods of
`PrivateModelStateFile`: `loadValidatedSnapshotUnderOwnedLock` returns the freshly
validated value, optional document ID, and pinned parent/target/lock identities;
`throwIfCancelledBeforeCallback(signal?: AbortSignal): void` throws only the
fixed cancellation error; `publishCiphertextWithOwnedIdentities(bytes: Buffer,
snapshot): Promise<void>` implements the guarded publication below. Keep them
private; later tasks depend only on the declared class API.

For publication use a `0700` same-parent directory prefixed
`.behalvo-model-state-stage-` and exclusively created `0600` payload. Write only
ciphertext; fsync it and its directory. Before publication revalidate the parent,
lock, and original target identity; reject a replaced/unsafe target. An absent
target uses no-replace link publication; an existing validated target uses atomic
rename. Fsync the destination parent. Preserve existing `publishPrivateFile`
semantics; its helpers can be reused only where their cleanup/identity contract
fits. Cleanup must check held device/inode before removing a lock or staging
entry; if ownership was replaced, preserve the replacement and fail safely.
Do not recursively delete an unverified replacement directory.

Missing initial data returns `schema.empty()` without creating the data file;
private parent preparation is allowed. Missing data with somebody else's lock,
empty/corrupt data, and later disappearance after observation are unavailable.
Read/list snapshots need no write lock; updates load under their own lock and
allow their own lock alongside a never-created file. `preflight({writable:true})`
validates schema and writable modes without changing document bytes or acquiring
a long-lived lock. `0400` read succeeds but mutation/preflight fails before the
callback. Never retry a callback after publication failure, including fsync after
rename; a rejected update may already be visible.

- [ ] **Step 5: Complete failure/interleaving tests and run focused GREEN.**
  Add real filesystem tests for each row; use callback barriers, not guessed
  sleeps, to interpose replacement/cancellation at a known boundary.

| Case | Required observation |
| --- | --- |
| Two `PrivateModelStateFile` objects update one path | Second callback reads the first committed count; both increments remain |
| `next: undefined` | Byte-for-byte unchanged file and unchanged document ID |
| Abort while waiting / safe lock remains 5 seconds | Callback count zero; fixed cancelled/busy; existing lock untouched |
| Abort after entering callback | Lock remains owned until callback returns; valid result is persisted |
| Callback throws a synthetic Error object | Same object rejects trusted API; prior bytes unchanged; next valid update succeeds |
| Lock, target, or parent replaced during held callback | Publication rejected; foreign replacement preserved; no duplicate callback |
| Existing empty/malformed/wrong-purpose file | Unavailable; original bytes and permissions unchanged |
| Missing data plus leftover lock / observed file later deleted | Unavailable; no reseeding |
| `0400` data / `0755` parent / leaf symlink / hard link / foreign owner | Reads and writes follow exact mode/ownership rules; unsafe paths preserved |
| Payload stages / forced writer or publication failure | Only ciphertext staged; no plaintext canary; owned cleanup only |
| Protected Windows execution | Fixed failure; mark POSIX-specific tests skipped on Windows, and add a Windows-only refusal assertion |

For post-rename failure, use the existing synchronous `node:fs` publication
style for short bounded file operations; waiting and the modifier remain async.
In the dedicated test-only child fixture, import default `node:fs` and
`syncBuiltinESMExports` from `node:module`. Wrap `renameSync` to record successful
replacement of the synthetic destination, and wrap `fsyncSync` to throw one
synthetic EIO only on the subsequent destination-directory descriptor. Call
`syncBuiltinESMExports()` before dynamically importing the compiled file helper.
The child must assert the update rejects with the fixed update error, the modifier
ran once, a fresh read sees the newly published value, and owned lock/staging
paths were cleaned. It returns a fixed success marker and exits; parent tests
bound/reap the child. No public or private production constructor test seam is
added. This exercises actual post-rename uncertainty rather than a mock publisher
that merely pretends to have written. Existing owned-file identity checks remain
in force through the injected fault.
Run `npm run build`, the two new files, `tests/storage-key-file.test.mjs`,
`tests/payload-cipher.test.mjs`, and `git diff --check`.

- [ ] **Step 6: Self-review and commit this independently testable core.** Check
  descriptor ownership, asynchronous cleanup, no callback retry, strict byte
  bounds, no raw causes, and unchanged existing key/cipher behavior. Stage only
  this task's files and commit `feat: add protected model-state file transactions`.
  Report exact producer interfaces to the Task 2 implementer.

### Task 2: Protected credential/settings adapters and safe Pi errors

**Files:**

- Modify `src/model/pi-auth-store.ts`, `src/cli/model-settings.ts`, `src/model/pi-gateway.ts`, and `src/index.ts`.
- Create `tests/private-model-stores.test.mjs` and `tests/private-model-state-child.mjs`.
- Extend `tests/pi-auth-store.test.mjs`, `tests/model-settings.test.mjs`, and `tests/pi-gateway.test.mjs` for compatibility and sanitized integration.
- Add `*.settings.json` to `.gitignore`.

**Consumes:** `ModelStateProtectionOptions`, `ModelStateOperationOptions`,
`ModelStatePreflightOptions`, `MODEL_STATE_LIMITS`, `ModelStateError`,
`copyModelStateKey`, and `validModelStateIdentifier` from Task 1. Construct
`PrivateModelStateFile<T>(path, purpose, key, {empty, validate})`; call
`preflight(options?): Promise<void>`, `read(options?): Promise<T>`, and
`update<R>(fn: (current:T) => Promise<{next:T|undefined;result:R}>, options?): Promise<R>`.

**Produces — preserve old signatures while adding these options/methods:**

```ts
// Keep the current PiCredential union and preserve JSON-safe OAuth extensions.
export interface PiCredentialInfo {
  providerId: string;
  type: PiCredential['type'];
}
export declare class PiCredentialFileStore {
  readonly path: string;
  constructor(path: string, options?: ModelStateProtectionOptions);
  preflight(options?: ModelStatePreflightOptions): Promise<void>;
  read(providerId: string, options?: ModelStateOperationOptions): Promise<PiCredential | undefined>;
  list(options?: ModelStateOperationOptions): Promise<readonly PiCredentialInfo[]>;
  modify(providerId: string,
    fn: (current: PiCredential | undefined) => Promise<PiCredential | undefined>,
    options?: ModelStateOperationOptions): Promise<PiCredential | undefined>;
  delete(providerId: string, options?: ModelStateOperationOptions): Promise<void>;
}
export declare class ModelSettingsStore {
  readonly path: string;
  constructor(path: string, options?: ModelStateProtectionOptions);
  preflight(options?: ModelStatePreflightOptions): Promise<void>;
  read(workspaceId: string): Promise<ModelRef | undefined>;
  write(workspaceId: string, selection: ModelRef): Promise<void>;
}
// Existing PiModuleImporter type and second-position injection remain intact.
export declare function createPiRuntimeLoader(authPath: string,
  importer?: PiModuleImporter, options?: ModelStateProtectionOptions): PiRuntimeLoader;
export interface PiGatewayOptions { sanitizeErrors?: boolean }
// PiModelGateway's existing methods remain; constructor becomes:
// constructor(loader?: PiRuntimeLoader, options?: PiGatewayOptions)
```

Export `ModelStateProtectionOptions` from `src/index.ts`; Pi helper metadata/error
option types may be exported alongside existing Pi types. Do not export the
private file transaction API at the package root.

- [ ] **Step 1: Write protected adapter RED tests.** This example fixes the Pi
  no-change, defensive-copy, provider-extension, and safe-key-name behavior:

```js
const options = { encryptionKey: Buffer.alloc(32, 9) };
const store = new PiCredentialFileStore(authPath, options);
const credential = {
  type: 'oauth', access: 'synthetic-access-canary',
  refresh: 'synthetic-refresh-canary', expires: 123,
  account: { label: 'synthetic-account-canary', scopes: ['synthetic'] }
};
await store.modify('__proto__', async () => credential);
const before = await readFile(authPath);
const unchanged = await store.modify('__proto__', async current => {
  current.access = 'mutated-copy';
  return undefined;
});
assert.equal(unchanged.access, 'synthetic-access-canary');
assert.deepEqual(await readFile(authPath), before);
assert.deepEqual(await store.list(), [{ providerId: '__proto__', type: 'oauth' }]);
assert.equal(await store.read('constructor'), undefined);
await store.modify('constructor', async () => ({ type: 'api_key', env: { REGION: 'synthetic' } }));
await store.delete('__proto__');
assert.equal(await store.read('__proto__'), undefined);
assert.deepEqual((await store.read('constructor')).env, { REGION: 'synthetic' });
```

Use temporary `0700` paths with `t.after` cleanup. Add protected settings tests
for two workspaces, `__proto__`/`toString`, unchanged credentials-free plaintext
schema after decryption, `read`/`write` copies, same-purpose file copy/reopen, and
wrong-key/purpose/schema rejection. Assert auth/provider/workspace/model canaries
are absent from raw files. Add legacy/protected mismatch tests in both directions
that compare bytes after rejected reads and writes.

For credential extension validation, build nested arrays iteratively: 32
containers in one extension value must pass, 33 must fail. Depth starts at 1 for
the extension value's first array/object; provider-map and credential containers
do not count toward this extension limit. Reject cycles, sparse array holes,
`undefined`, functions, symbols, bigint, non-finite numbers, accessors, and
non-plain objects that could transform through `toJSON`. Scalars/null are valid;
required OAuth/API-key fields retain their existing types. Test 256/257 providers,
1,024/1,025 workspaces, 512/513 code-unit identifiers, controls, and serialized
1-MiB boundaries; do not retrofit these bounds into plaintext mode.

- [ ] **Step 2: Run RED.** Run `npm run build`, then
  `node --test tests/private-model-stores.test.mjs tests/pi-auth-store.test.mjs tests/model-settings.test.mjs tests/pi-gateway.test.mjs`.
  Confirm ignored encryption options and absent methods are the expected failures.

- [ ] **Step 3: Implement the two schema-owned adapters.** Choose protected mode
  only with `options.encryptionKey !== undefined`; do not use a truthiness check.
  Constructors synchronously capture a key through the protected file class.
  Retain the current plaintext serialization and lock paths. Apply own-property
  access/safe assignment in both modes; leave new protected bounds and POSIX rules
  confined to protected mode. Implement `list` from a validated snapshot without
  provider resolution. Plaintext `preflight` validates the existing load format;
  protected preflight delegates to the private file with the provided options.

Protected `modify` must preserve the authoritative pre-callback credential when
the callback mutates its copy and returns no change:

```ts
return this.protectedFile.update(async data => {
  const original = Object.hasOwn(data, providerId)
    ? structuredClone(data[providerId]!) : undefined;
  const candidate = await fn(original === undefined ? undefined : structuredClone(original));
  if (candidate === undefined) return { next: undefined, result: original };
  try {
    validateProtectedCredential(candidate);
    Object.defineProperty(data, providerId, {
      value: structuredClone(candidate), enumerable: true, configurable: true, writable: true
    });
    return { next: data, result: structuredClone(candidate) };
  } catch {
    throw new ModelStateError('update');
  }
}, options);
```

`validateProtectedCredential(value: unknown): asserts value is PiCredential` and
`validateProtectedAuthFile(value: unknown): asserts value is AuthFile` are private
functions in `pi-auth-store.ts`. Validate required fields with existing logic,
then iteratively inspect own data properties for JSON safety; no recursive walk
that can overflow on hostile nesting. Settings reuse the current strict allowed
field checks plus protected bounds. `delete` updates under the same whole-file
lock and returns `next:undefined` when absent. A fresh empty map uses a null
prototype or safe own-property writes; never resolve an inherited property.

Do not catch a provider callback exception and mislabel it as a storage failure.
Catch validation of the *returned* candidate separately and map it to fixed
`update`; the file helper covers document schema/serialization/publication errors.

- [ ] **Step 4: Prove process coordination with synthetic children.** The new
  child fixture is an IPC worker launched with `fork`; all requests contain
  synthetic file/key paths, never raw key bytes in argv. Load keys with
  `loadStorageKeyFile` and choose these bounded commands:

```ts
type ChildCommand =
  | { kind: 'auth-refresh'; authPath: string; keyPath: string; provider: string; hold: boolean }
  | { kind: 'auth-add'; authPath: string; keyPath: string; provider: string }
  | { kind: 'auth-delete'; authPath: string; keyPath: string; provider: string }
  | { kind: 'settings-write'; settingsPath: string; keyPath: string; workspace: string }
  | { kind: 'release' };
```

For refresh, emit `{kind:'entered',access:current.access}` only after its modifier
has acquired the store lock. If `hold`, wait for `release`; return current unchanged
with `undefined` when `expires === 2`, otherwise return the same credential with
`access:'synthetic-refreshed', refresh:'synthetic-rotated', expires:2`. Emit
`{kind:'done'}` only after durable store completion. Other writes emit done only
after completion. Fixture errors print a fixed synthetic-test diagnostic.

Seed an expired synthetic OAuth entry with `expires:1`. Hold child A after entered,
start child B, then release A. Assert B's entered snapshot is already refreshed,
the final refresh token is rotated once, and no unrelated provider disappeared.
Run multiple auth-add/settings-write children with distinct keys and assert every
successful entry remains. Coordinate delete behind a held modify and verify the
serialized final absence. Kill a held child; assert its lock remains and another
update rejects busy without entering its callback. Give test-side IPC readiness/
exit deadlines and always terminate/reap children in `t.after`; timeouts are test
failures, never permission to delete a production lock.

- [ ] **Step 5: Wire loader capture and fixed-error gateway behavior.** Copy
  `options.encryptionKey` when creating the loader, before returning its async
  closure. The importer remains argument two; call `builtinModels` with exactly
  the configured `PiCredentialFileStore`. Keep one runtime promise per gateway.
  Add optional `sanitizeErrors` without changing the legacy default. Keep runtime
  initialization outside each method's provider-error catch, so its installation
  guidance is not relabeled as login/catalog/completion failure:

```ts
const runtime = await this.#getRuntime();
try {
  return await runtime.login(providerId, type, interaction);
} catch (error) {
  if (this.options.sanitizeErrors) throw new Error('Pi login failed.');
  throw error;
}
```

Apply this pattern to the existing private `#getRuntime`/method structure rather
than adding a second cache. Initialization's fixed message is
`Unable to load bundled Pi model support (@earendil-works/pi-ai). Use Node >=22.19 and run npm ci.`;
catalog is `Pi model catalog is unavailable.`; completion is
`Pi provider request failed.`. Include model lookup, provider execution, and
`textFrom` inside the completion boundary so returned `errorMessage` cannot leak.
Create no cause in the fixed branch. Login URL/code/prompt callbacks retain their
existing behavior.

Test an injected importer storing synthetic credentials after the caller key was
zeroed, plus secret-bearing importer, login, catalog, thrown completion, and
returned-error-message failures. Assert exact messages/no causes in sanitized
mode and existing compatibility tests in default mode. Exercise synthetic
credential refresh through an injected runtime; no real login or provider call.

- [ ] **Step 6: Run focused GREEN, then `npm run check` and `git diff --check`.**
  Verify provider/settings process cases, legacy tests, key capture, bounds, and
  no-secret errors. Self-review the installed Pi 0.85.1 callback declarations
  against method signatures, then commit
  `feat: protect Pi credentials and saved model settings`. Return the exact APIs
  and verification to Task 3.

### Task 3: CLI/evaluation integration, operational documentation, and acceptance

**Files:**

- Create `src/cli/model-state-config.ts` and `tests/model-state-config.test.mjs`.
- Modify `src/cli/main.ts`, `src/evaluation/main.ts`, `tests/cli-main.test.mjs`, and `tests/evaluation-cli.test.mjs`.
- Update `README.md`, `SECURITY.md`, `docs/ROADMAP.md`, `docs/PRIVATE_STORAGE.md`, `docs/local-mvp.md`, and `docs/AGENT_EVALUATION.md`.
- Create `docs/verification/2026-09-14-private-model-state.md` with evidence actually obtained.

**Consumes:** Task 1 `resolveModelStatePath(path): string`, `ModelStateError`, and
`ModelStateProtectionOptions`; existing `loadStorageKeyFile(path): Uint8Array`;
Task 2 stores with `preflight({writable:true}): Promise<void>`,
`createPiRuntimeLoader(authPath, importer?, protectionOptions?)`, and
`new PiModelGateway(loader, {sanitizeErrors:true})`.

**Produces — exact integration interfaces:**

```ts
// src/cli/model-state-config.ts
export interface ModelStatePathConfiguration {
  modelStateKeyPath: string;
  authPath: string;
  settingsPath?: string;
  dbPath?: string;
  storageKeyPath?: string;
  syntheticOperations?: boolean;
}
export declare function resolveModelStateKeyPath(
  explicitValue: string | undefined, environmentValue: string | undefined,
  cwd: string, enabled: boolean
): string | undefined;
export declare function assertModelStatePathSeparation(
  config: Readonly<ModelStatePathConfiguration>
): void;
export declare function loadModelStateProtection(
  config: Readonly<ModelStatePathConfiguration>
): ModelStateProtectionOptions;

// Add to existing CliArgs and evaluation run command:
// modelStateKeyPath?: string
// Extend existing EvaluationCliDependencies member:
// createLiveGateway?: (authPath: string,
//   protectionOptions: Readonly<ModelStateProtectionOptions>) => ModelGateway
```

No new flag or API for changing the derived settings path, generating a key,
turning protection off after selecting it, migrating, or enabling live inference.

- [ ] **Step 1: Write argument and collision RED tests.** Extend the evaluation
  value-flag set with the new option before using the resolver. Existing strict
  parsing rejects duplicate/missing/equals syntax; agent parsing adds the same
  targeted validation without rewriting older flag precedence. Resolver tests:

```js
assert.equal(resolveModelStateKeyPath(undefined, 'environment.key', cwd, true), join(cwd, 'environment.key'));
assert.equal(resolveModelStateKeyPath('flag.key', '', cwd, true), join(cwd, 'flag.key'));
assert.throws(() => resolveModelStateKeyPath(undefined, '', cwd, true));
assert.equal(resolveModelStateKeyPath(undefined, '/missing/key', cwd, false), undefined);
assert.equal(resolveModelStateKeyPath(undefined, '', cwd, false), undefined);
assert.throws(() => resolveModelStateKeyPath('flag.key', undefined, cwd, false));
```

Set `cwd` to a synthetic temporary directory and import the resolver/`join`.
Construct two valid generated key files and distinct database/auth/settings paths.
Use this literal collision set for the ordinary/synthetic agent:

```js
const reservedDatabasePaths = [
  db, `${db}-wal`, `${db}-shm`, `${db}-journal`, `${db}.behalvo-lock`,
  `${db}.synthetic.sqlite`, `${db}.synthetic.sqlite-wal`,
  `${db}.synthetic.sqlite-shm`, `${db}.synthetic.sqlite-journal`
];
for (const path of reservedDatabasePaths) {
  assert.throws(() => assertModelStatePathSeparation({
    modelStateKeyPath: keyPath, authPath: path,
    settingsPath: `${db}.settings.json`, dbPath: db, syntheticOperations: true
  }), { message: 'Invalid private model state configuration.' });
}
assert.doesNotThrow(() => assertModelStatePathSeparation({
  modelStateKeyPath: keyPath, storageKeyPath: keyPath,
  authPath, settingsPath: `${db}.settings.json`, dbPath: db
}));
```

Also test auth/settings equality, either data path equaling either model-state
lock, either key equaling any data/lock/sidecar path, `.`/`..` spellings, permitted
trusted-ancestor aliases, rejected immediate symlink parents, and existing inode
aliases/hard links. Assert collision checking changes no file bytes or modes.

- [ ] **Step 2: Write startup integration RED cases.** In agent subprocess tests
  always use explicit synthetic `--db`/`--auth` paths; extend the helper to accept
  controlled environment overrides. A missing/malformed key, corrupted protected
  auth/settings, wrong key, existing plaintext, `0400` writer destination, and each
  reserved-path collision must fail before creation of an absent database or its
  sidecars. Repeat corrupted settings with explicit `--model` to prevent the
  nullish-selection shortcut from bypassing preflight. Use `/quit` for valid
  startup/catalog tests and `/model` commands for selection persistence; do not
  submit a chat completion or real login.

Offline subprocesses must ignore ambient missing/empty model-state key values,
leave auth/settings/key paths untouched, and reject the explicit new flag before
database creation. Test this independently from the existing storage-key flag,
which still applies to offline SQLite encryption.

For evaluation, use its existing dependency injection to prove invalid protection
causes no gateway construction and no report, then prove successful option
forwarding with a copied key captured by a one-shot synthetic factory:

```js
let factoryCalls = 0;
let capturedKey;
const dependencies = {
  cwd: dir, env: {}, writeStdout() {}, writeStderr() {},
  createLiveGateway(receivedAuthPath, options) {
    factoryCalls++;
    assert.equal(receivedAuthPath, authPath);
    capturedKey = Buffer.from(options.encryptionKey);
    return {
      async listModels() { return [{ provider: 'synthetic', model: 'test' }]; },
      async complete() { throw new Error('synthetic-provider-secret'); }
    };
  }
};
const code = await runEvaluationCli([
  '--live', '--model', 'synthetic/test', '--auth', authPath,
  '--model-state-key-file', keyPath, '--out', reportPath,
  '--case', 'capabilities', '--repeats', '1'
], dependencies);
assert.equal(factoryCalls, 1);
assert.deepEqual(capturedKey, loadStorageKeyFile(keyPath));
assert.equal(code, 1);
assert.equal((await readFile(reportPath, 'utf8')).includes('synthetic-provider-secret'), false);
```

This test uses a generated synthetic key, an absent or valid protected auth file,
and a temporary report destination; its `--live` parser route does not represent
live evidence because the gateway is injected. Keep the existing malformed-auth,
plaintext ambient resolution, output refusal, and report-sanitization tests.

- [ ] **Step 3: Run RED, then implement configuration and collision checking.**
  Run `npm run build` and the three changed/new CLI test files to record missing
  behavior. Resolve an enabled new key path with `explicitValue ?? environmentValue`;
  disabled mode ignores the environment and rejects an explicit value. Load with
  the existing key helper, translating its failure to `ModelStateError('key')`.
  Check canonical reserved paths before preparing model-state directories or
  opening the database. Clear loaded bytes if checking fails.

Use labeled sets rather than one undifferentiated uniqueness check:

```ts
const data = [config.authPath,
  ...(config.settingsPath === undefined ? [] : [config.settingsPath])];
const locks = data.map(path => `${path}.behalvo-model-state-lock`);
const keys = [config.modelStateKeyPath,
  ...(config.storageKeyPath === undefined ? [] : [config.storageKeyPath])];
const database = config.dbPath;
const reserved = database === undefined ? [] : [database,
  `${database}-wal`, `${database}-shm`, `${database}-journal`, `${database}.behalvo-lock`];
if (database !== undefined && config.syntheticOperations === true) {
  const synthetic = `${database}.synthetic.sqlite`;
  reserved.push(synthetic, `${synthetic}-wal`, `${synthetic}-shm`, `${synthetic}-journal`);
}
```

Canonicalize all entries using `resolveModelStatePath`. Require uniqueness across
`data`, `locks`, and `reserved`; reject every key overlap with those groups but
allow equal keys. For existing leaves also reject symlinks/non-regular or linked
files and compare device/inode identities so textual aliasing cannot hide a
collision. Database/SQLite companion modes are validated by their existing
owners, not by model-state `0600` data checks. Do not create absent reserved files.

- [ ] **Step 4: Implement ordered agent/evaluation wiring.** In the online agent,
  load the configured key and construct both stores with that one options object.
  Preflight both as writers, always, before `openLocalAgent` or Pi import. Retain
  the same `ModelSettingsStore` for startup read/write and `onModelSelected`.
  Construct the runtime loader eagerly enough to capture the key; configure its
  gateway's fixed-error policy only when model-state protection is selected:

```ts
const loader = createPiRuntimeLoader(args.authPath, undefined, protection);
const pi = new PiModelGateway(loader,
  protection.encryptionKey === undefined ? {} : { sanitizeErrors: true });
```

Keep `protection` as `{}` in plaintext mode. Use `finally` to clear the caller's
loaded buffer after stores/loader capture it and on every startup failure. Do not
clear it before creating the lazy loader. Avoid constructing Pi, creating auth
parents, or reading model settings in offline mode. Leave SQLite storage-key
loading and encrypted/synthetic rejection intact. All optional objects must use
omitted properties rather than explicit `undefined` where required by
`exactOptionalPropertyTypes`.

Move protected file/key failures outside the existing saved-model-selection
recovery catch. Retain generic saved-catalog recovery guidance and the current
in-session unsaved-selection warning. Never turn a protection error into advice
to remove a file. An explicit startup model changes the chosen model, not the
requirement to validate the existing protected settings document.

In evaluation, retain immediate help/list/scripted returns. Only explicit live
mode loads model-state configuration. Preflight protected credentials as writable
before calling the factory; plaintext mode retains the current `read(provider)`
preflight. Pass the identical options to the factory, whose default creates the
loader and sanitized gateway as above. Capture key bytes synchronously in that
factory before the caller clears them. Report creation and inference stay after
preflight/model validation; no settings lookup or login is added. Preserve the
existing fixed evaluation startup/runtime messages and exit codes.

- [ ] **Step 5: Complete operational copy with the implemented behavior.** Update
  the existing guides/status tables using these concrete facts, and include the
  synthetic example commands from the accepted design:

| Documentation | Required change |
| --- | --- |
| README implementation table and setup | Protected Pi credentials/settings are available only with the new option; evaluation reports and production privacy remain incomplete |
| SECURITY | Separate opt-in boundaries, shared per-provider auth, ambient sources outside protection, trusted process/UID, fixed errors and no readiness claim |
| ROADMAP | Record this prerequisite's delivery without completing issue 04, M1.1 live/manual acceptance, or remote/mobile owner control |
| PRIVATE_STORAGE | SQLite backups still exclude model state; describe separate key/file custody and stale-token restore risk |
| local MVP | Exact key creation/path option, fresh destinations, explicit mismatch failure, writer modes, lock wait/manual exclusive recovery, truthful `/model` save warning |
| Agent evaluation | New live-only option/precedence, preflight failures before reports/inference, ambient credential caveat, unchanged plaintext report format and non-live test evidence |

State that unknown custom auth paths are not automatically ignored by git, old
plaintext copies are not erased, restoring rotated credentials may require
provider reauthentication, and locks are removed manually only after exclusive
operator inspection. Do not add an automated lock-removal, migration, or rotation
command. Production retention/erasure, authenticated owner control, live/manual
acceptance, real-provider correctness and deployment review remain open.

- [ ] **Step 6: Run final acceptance and commit the complete integration.** First
  run focused GREEN for the changed CLI tests. Then execute each command once,
  recording actual counts, platform skips, failures, and resulting fixes:

```sh
npm run check
npm run demo
npm run mvp:demo
npm run operations:demo
npm run owner-control:demo
npm run eval:agent -- --scripted
git diff --check
```

The scripted evaluation output stays in ignored private runtime data; do not add
its raw report to git. Write `docs/verification/2026-09-14-private-model-state.md`
with the tested commit/tree, Node version, executed commands/results, synthetic
fixture scope, and gates not executed. Do not describe configured CI or genuine
live-model acceptance as passed. Commit
`feat: wire private model state into agent and evaluation` after task self-review.

## Final review and handoff

The controller reviews each task against both this plan and the accepted spec,
then runs the authorized independent security/code whole-branch reviews. Resolve
concrete findings and re-review fixes before publication. Verify actual CI for
the reviewed final head on Node 22.19.0 and 24.x before the authorized merge.
No account access or deployment is part of this handoff.

## Plan self-review

| Accepted requirement | Owning evidence |
| --- | --- |
| Purpose-bound whole documents, limits, format, no mode fallback | Task 1 codec/file tests; Task 2 schema/mismatch tests |
| Separate key configuration, full path collision family, offline isolation | Task 3 config matrix and entry-point subprocess/dependency tests |
| POSIX private identity, mutable preflight, bounded lock, owned cleanup | Task 1 filesystem/interleaving tests; Task 3 ordering tests |
| Pi undefined/copy/list/delete semantics and cross-process refresh | Task 2 adapter tests and coordinated children |
| No early release/retry after callback starts; uncertain publication | Task 1 cancellation/fault tests and Task 2 killed-child test |
| Loader importer compatibility, key capture, safe protected errors | Task 2 injected Pi tests and Task 3 factory tests |
| Shared auth/workspace-scoped selection, backup and remaining limits | Task 2 behavior; Task 3 operational copy/status tables |
| Existing compatibility, actual full verification, independent review | Task 3 commands/evidence and controller final gate |

Interface names, option property names, exact error strings, byte/cardinality/
depth/lock values, and producer-consumer calls were checked across all three
tasks. Work is scoped to the accepted protected model-state increment.

Controller self-review completed after the draft handoff: aligned the gateway
example with existing `#getRuntime`; chose a real child-process post-rename fsync
fault fixture without a production test seam; made returned-candidate validation
map to the fixed update error while leaving the provider callback outside that
catch. All three task interfaces and the collision/key-sharing exception agree
with the accepted spec. Planning is complete; runtime implementation is next.
