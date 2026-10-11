# Local Credential Vault Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. The primary agent is the sole implementation writer; independent specialists review the completed branch.

**Goal:** Store website logins privately and let the agent request a trusted, origin-bound synthetic login without seeing credentials.

**Architecture:** Keep encrypted credential custody outside task/domain storage. Reuse the private encrypted-file primitive and existing hidden terminal I/O. A dedicated synthetic browser port returns recognized, secret-free status and closes within a single-use credential callback.

**Tech Stack:** TypeScript, Node.js 22.19+, existing AES-256-GCM/HKDF storage and pinned Playwright 1.63.0; no new runtime dependency.

**Spec:** [approved design](../specs/2026-10-11-credential-vault-design.md).

## Global Constraints

- Synthetic accounts only; no actual maintainer account enters a test.
- Secrets never enter journal, model prompts/results, ordinary terminal history, argv or environment.
- POSIX private files only; explicit independent key configuration, no plaintext fallback.
- HTTPS exact origins; synthetic HTTP only for the owned compiled fixture at `http://127.0.0.1:43118`.
- Storage bounds: 128 entries, 1024-byte username, 16384-byte password, 128-byte label.
- Keep existing private model-state formats and behavior compatible; vault operations opt into stricter publication guards.
- Use existing English message catalogs for new terminal copy.
- No live browser/portal, external manager discovery, TOTP, payments, background login or persistent authenticated sessions.

## Review Focus

- A removed vault file after process restart must not silently become an empty vault: existing-only facade plus explicit creation tests in task 1.
- Cancellation after hidden capture or while waiting for the file lock must not persist data: publication guard tests in tasks 1 and 2.
- Trailing pasted credentials must never become a chat message: I/O reset and REPL canary tests in task 2.
- A replaced account or changed document while confirmation is pending must invalidate use: version/scope and browser-race tests in tasks 1 and 3.
- Unknown dispatch cannot be retried by a second model tool call: terminal-port test in task 3.

### Task 1: Shared encrypted file and scoped vault

**Files:** add `src/storage/private-encrypted-json-file.ts`, `src/vault/types.ts`, `src/vault/local-vault.ts`; adapt `src/storage/private-model-state-file.ts`, `src/storage/model-state-codec.ts`, `src/storage/payload-cipher.ts`; add `tests/credential-vault.test.mjs`.

**Interfaces:**
- `PrivateEncryptedJsonFile<T>` preserves the current private-file constructor/read/preflight/update contract. Add `dispose()` and optional `beforePublish(): void` on update options; old calls retain their post-callback cancellation semantics. Export compatibility aliases from the original module.
- `VaultScope = {workspaceId, ownerId}`; `LoginMetadata = {id, label, origin, revision, status}`. Internal entries also bind scope and protected username/password; tombstones retain no secret values.
- `LocalCredentialVault({path, loadKey})`: `initialize(scope)`, `unlock()`, `lock()`, `list(scope)`, `add(scope, input, options)`, `replace(scope, id, expectedRevision, input, options)`, `remove(scope, id, expectedRevision)`, `withLogin(scope, reference, use, options)`. `reference` includes exact origin, ID and revision. Mutations require unlocked state except explicit initialization/unlock. `options` carries cancellation and `assertCurrent` guards; synthetic origin authorization is an internal, trusted fixture capability.
- `withLogin` yields `{username: Uint8Array, password: Uint8Array}` only to the trusted callback with a synchronous guard. It returns the callback's non-secret result, holds the file lock through callback closure, clears owned bytes, and converts thrown details to fixed vault errors. There is no model-facing secret read API.

- [ ] Write tests asserting encrypted persistence/restart, no canary in file or metadata, cross-workspace/owner/origin denial, wrong purpose/key/tamper denial, tombstone/version behavior, explicit initialize and missing-file refusal.
- [ ] Run the new tests; observe failure because vault exports are missing.
- [ ] Extract the existing encrypted-file implementation with compatibility exports; extend authenticated purpose, disposal and opt-in publication guard, preserving old format/semantics.
- [ ] Implement strict bounded vault validation, locked updates and callback-only borrowing. Add/remove/replace use one document transaction. Lock/remove cancels active same-process uses; remove's authority takes effect at committed mutation.
- [ ] Add/observe RED and fix tests for pending prompt epoch, cancellation after callback/before publish, stale revision, mutation waiting behind a borrowed secret, error sanitization, symlink/hardlink/mode faults and disposal.
- [ ] Run `npm run build` and focused vault/private-state tests; record logs and commit.

### Task 2: Private capture and usable CLI

**Files:** add `src/vault/login-broker.ts`, `src/cli/vault-{commands,config,messages}.ts`; adapt `src/cli/{main,repl,node-io,terminal-prompt}.ts`; add `tests/vault-{cli,prompts}.test.mjs`.

**Interfaces:**
- `PrivateCredentialIo` advertises `interactive`, `readLine`, `readSecret`, `discardSensitiveInput`, and `write`. Actual terminal implementations guarantee clearing pending/queued input at vault prompt boundaries.
- `VaultLoginBroker` binds configured vault and owner I/O. `use(scope, challenge, execution, use)` validates the trusted challenge, selects a same-origin saved entry or captures a missing login after confirmation, and returns `{status, value?}`. Status is a fixed enum; one broker request per turn. Every borrow needs a fresh owner confirmation and exact current entry revision/unlock epoch.
- `/vault` or `/vault list`; `/vault init`, `add`, `replace <id>`, `remove <id>`, `lock`, `unlock`. Values enter only private prompts. A multiline `/vault`-prefixed input is refused before normal chat ingest.
- `parseVaultConfiguration(argv, reservedPaths)` requires paired `--vault`/`--vault-key-file`, rejects duplicate/equal/aliased data/key/lock/database paths, never accepts values. Main loads/disposes vault without changing existing provider credential paths.

- [ ] Write tests for metadata-only listing, private add/replace/remove confirmation, exact whitespace values and password-independent output; unknown/extra/multiline arguments never enter chat.
- [ ] Run tests to observe missing vault-command failure; implement catalog/config/commands and main/REPL wiring.
- [ ] Write failing I/O tests for extra pasted lines, Ctrl+C/EOF/abort and hidden username/password; implement prompt reset and interactive-only admission without changing provider-owned login semantics.
- [ ] Test headless refusal, missing/locked vault, two accounts selection, skip, expiry/revision changes during prompt and before publish. Assert canaries absent from messages, journal/artifacts, model requests and console.
- [ ] Run focused CLI, existing auth/editor and vault tests; record logs and commit.

### Task 3: One-shot synthetic login, docs and acceptance

**Files:** add `src/browser/{synthetic-login-fixture,synthetic-login-browser}.ts`; adapt `src/browser/semantic-types.ts`, `src/kernel/{browser-types,browser-contract}.ts`, `src/runtime/browser-exploration.ts`, `src/cli/main.ts`; add `tests/vault-browser.test.mjs`, `tests/vault-browser-acceptance.test.mjs`; update README, SECURITY, local MVP and add `docs/CREDENTIAL_VAULT.md`.

**Interfaces:**
- New `login` control role, action/command `request_login` carrying only observation ID and control ref. Existing browser contracts unchanged for other roles.
- `BrowserExecution` gains an optional trusted login callback supplied by `BrowserExplorationOptions`; it uses the exact runtime binding and current-authority check, never model-supplied scope.
- `SyntheticLoginBrowser` exposes one login control on initial observation, uses broker/private bytes only inside its trusted login callback, and returns a terminal constant recognized observation with no controls. POST body and form policy are exact. Cleanup executes before callback release and the port cannot reopen.
- `--synthetic-browser login` starts the compiled fixed-origin fixture and adapter; a missing vault yields unavailable without secret capture or dispatch. Other fixture paths retain their current policy.

- [ ] Write tests that request_login validates opaque refs, cannot pass URLs/values/selectors, and runtime permits only a final answer after a login attempt. Observe RED, then add minimal contract/runtime support.
- [ ] Write synthetic adapter tests for exact form/action/origin/document, one-use POST admission, foreign/redirect/popup/frame denial, cancellation and unknown result; observe RED and implement the dedicated adapter/fixture.
- [ ] Run visible acceptance with `BEHALVO_VAULT_ACCEPTANCE=1`: capture/login, persisted restart/reconfirm, denial/race/canary checks and confirmed disposable-profile cleanup. No actual accounts, no model-provider charges needed.
- [ ] Document setup, ordinary vs synthetic use, key custody and backups, scope/permission semantics, limits and remaining live-browser gap. Update implementation status accurately and export supported library types.
- [ ] Run focused regression plus `npm run verify`; inspect actual summaries and diff.
- [ ] Request independent Sol/high and Astra/high reviews, fix supported findings with RED/GREEN tests, obtain approval and rerun affected checks/full final verify as needed.
- [ ] Commit final tree, create/attach PR, verify exact-head hosted CI, merge under standing authorization and clean the local feature branch. Report actual verification and remaining limits.
