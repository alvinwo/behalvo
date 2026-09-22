# Task 6 report — protected private browser connections

## Result

Task 6 is implemented as a callback-scoped secret boundary, a synthetic CI provider, a fail-closed macOS native-helper transport contract, and local private-profile custody/disconnect controls. It does not include a signed helper binary, real credentials, real Keychain access, a live portal connection, or any Task 7 visa adapter behavior.

## Delivered

- A generic `SecretProvider` with exact service/connection/purpose/account scope, deterministic opaque references, `put`, callback-only `withSecret`, `delete`, and metadata-only `list`. There is no plaintext getter. Input objects reject unknown fields, errors are fixed, and temporary byte buffers are zeroed where JavaScript permits.
- A deterministic in-memory synthetic provider for CI. Stored values are private; callback copies, replacements, and deleted values are zeroed.
- A macOS-only Keychain-provider adapter through a native helper contract. Secret input uses a bounded stdin frame; secret output uses a dedicated file descriptor. The helper receives one fixed argument and a fixed minimal environment. Stdout carries bounded metadata only.
- Helper executable identity checks before and after every operation, with one timeout/cancellation budget covering identity lookup, invocation, and final recheck. Identity change, cancellation, timeout, malformed or operation-inappropriate output, nonzero exit, oversize data, and unavailable/locked behavior fail with a fixed error.
- Dedicated-profile validation: canonical absolute real path, no symlink, owner-only profile and immediate parent, outside Git/recognized cloud-sync/support/backup paths, no Chrome Singleton markers, one exclusive private filesystem custody claim across processes, pinned profile device/inode, macOS plus explicit full-disk-encryption acknowledgment for live mode, and cross-platform synthetic mode.
- Ordered durable disconnect: revoke the exact journaled connection generation, shut matching browser sessions, revoke matching native secret brokers, durably terminalize matching grants/monitors/jobs, delete only explicitly selected known secret purposes, release profile custody, and offer separate profile removal. Append-only phase records and a private completion receipt make identical retry/restart/lost-acknowledgement recovery idempotent without restoring authority or recursively deleting the profile.
- Exact native-host secret access constrained to registered purpose-bound references, plus authenticated control status/API/UI that projects connection metadata and explicit delete choices without account IDs, opaque references, secret values, or raw provider errors.
- Accurate README/security boundaries: no signed helper executable, real Keychain exercise, secure-erasure guarantee, credential collection, or live acceptance is claimed.

## TDD evidence

The initial focused RED loaded the four new Task 6 suites and failed all 4 because the new exports did not exist. Subsequent focused RED/GREEN slices covered exact provider objects, purpose binding, callback-error redaction, callback-buffer zeroing, helper identity replacement, timeout/cancellation, helper framing, disconnect ordering, profile custody, authenticated control projection, UI choices, and runtime-random leakage canaries.

Self-review added independent REDs before their fixes for:

- a helper identity lookup that could outlive the operation timeout;
- secret-channel bytes emitted during non-read helper operations;
- branded cloud paths such as `OneDrive - Example Org`;
- a canonical profile path being re-registered after its directory inode was replaced; and
- an unknown secret deletion purpose being silently accepted.

Final focused/control/browser/monitor command:

`npm run build && node --test --test-reporter=spec tests/secret-provider.test.mjs tests/keychain-contract.test.mjs tests/private-connection.test.mjs tests/secret-leakage.test.mjs tests/service-control.test.mjs tests/owner-control-ui.test.mjs tests/service-http.test.mjs tests/browser-session.test.mjs tests/monitoring-service.test.mjs`

- 187 passed, 0 failed, 3 environment-dependent skips. The real Unix-domain-socket fixture skips on `EPERM`; two foreign-UID stage fixtures skip because the filesystem rejects `chown` with `EINVAL`. Dangling symlink, live symlink, hardlink, unsafe mode, and regular Singleton entries are exercised; production still checks the current effective UID and uses file-type-independent `lstat` existence.

## Canary leakage evidence

The leakage test creates runtime-random username, password, and security-answer values, stores them only through the synthetic provider, and zeroes the caller buffers. It scans raw, hex, and base64url forms against journal records, service-job records, private-connection/control metadata, browser/model simulated surfaces, fixed error stacks, process argv/environment, the complete generated temporary tree (including profile custody, SQLite, backup, and verification files), and the repository's actual `data/verification` tree. No canary form was found.

The native-helper contract separately captures a runtime-random secret and proves it is present only in the bounded stdin frame and absent from argv, the fixed environment, and metadata stdout. Production capability scans found no console/log emission or general secret getter in the new secret/connection/native-host surface.

## Verification

- Final full `npm test`: 883 tests; 878 passed, 0 failed, 5 environment-dependent skips. The final verification runner independently repeated these same full-suite counts.
- Final `npm run verify`: all five steps passed: typecheck/full test, offline demo, synthetic operations demo, owner-control demo, and diff check. Demos reported zero real external effects.
- Verification fingerprints were identical before and after: `9a9e811861a74bb27ad1bcac7cc7288a61efedbe4c28768a9cb06abdb309cb4d`.
- Evidence: `data/verification/2026-09-21T17-50-35.945Z-b5309791-7536-4e03-bb17-49cbaccdd80c/summary.json`; dirty pre-commit tree on `966286c`, Node 24.19.0. Only evidence-report/ledger edits followed verification.
- Post-verification runtime-canary gate: 2 passed, 0 failed, 0 skipped; raw/hex/base64url scans include the actual new verification directory.
- `git diff --check`: passed after production and test edits; a final post-report check is recorded in the ledger.
- The only emitted warning is npm's pre-existing unknown `http-proxy` environment-config warning.

## Independent review fix round 1

All nine findings in `task-6-review.md` were verified against the implementation and specification before edits; all were valid. The two P1 findings were addressed first under RED/GREEN tests.

- The default local-service composition now refuses missing authority and wires the private manager to durable connection-generation revocation, matching browser-session shutdown, native broker revocation (including held callbacks), and durable grant/monitor/job terminalization. A real SQLite restart regression proves the authority remains revoked after successful disconnect.
- Process-local ownership was replaced by a private `0700` exclusive sibling custody directory with a `0600` flushed journal, pinned profile identity, PID and random custody identity. Concurrent subprocess registration, path replacement, Chrome ownership markers, stale-process takeover, malformed/duplicate journals, completed-checkpoint recovery, and receipt replay are covered. Explicit stale recovery never uses recursive deletion.
- Disconnect journals each monotonic cleanup phase and selected deletion, reconciles ambiguous deletion by exact metadata absence, shares concurrent identical attempts, retries only incomplete work, and replays completed receipts across restart. Failure never restores drained authority.
- The native helper launcher consumes early stdin failure and late events without uncaught `EPIPE`; a real `/usr/bin/true` subprocess regression exits normally with only the fixed public error. Final-identity cancellation and late results cannot enter the callback. Retained response and stream buffers are zeroed on rejection, timeout, identity, oversize, callback, cancellation, copy, and failure paths where owned bytes remain accessible.
- Keychain list results must be bounded, unique, and match the requested service, connection, account, optional purpose, and derived reference. Cloud path coverage includes Apple Mobile Documents/CloudDocs and Box Sync forms. Every destructive UI checkbox now has a unique associated visible label, starts unchecked, and failed cleanup exposes an explicit retry action.
- Runtime-random raw, hex, and base64url canaries are scanned across the generated temporary tree (including custody/SQLite/backup/verification artifacts) and the repository's actual `data/verification` tree. No literal canary is committed.

Focused review evidence and final full/verification evidence are recorded in the SDD ledger.

## Independent review fix round 2

All four remaining findings in the updated `task-6-review.md` were verified against the implementation before edits and reproduced under RED tests.

- Explicit stale recovery now keeps the exclusive custody directory continuously present, takes one private exclusive recovery claim, pins the observed custody-directory identity, owner-state identity, and source digest, rereads them immediately before atomic owner-state replacement, and rejects every delayed loser. Ten repeated real-subprocess runs exercised three held-snapshot races each: 30/30 produced exactly one winner and preserved that winner's live custody.
- Chrome `SingletonLock`, `SingletonCookie`, and `SingletonSocket` are rejected on any `lstat`-visible directory entry, including dangling symlinks. A real socket fixture is included and reports the one environment-dependent skip where the sandbox denies socket creation.
- Custody checkpoints are transactional: a complete logical event history is flushed to a private file, validated, atomically replaced, and directory-synced before authoritative in-memory progress advances. The completion receipt is privately flushed and atomically published; custody release is no longer swallowed. Thirteen in-process fault cases and nine process-restart cases cover every cleanup checkpoint, secret deletion, completion, receipt publication, and release, including partial/post-write completion and receipt failures. Every first attempt remains `disconnect_failed`, retains recoverable custody, and no retry returns success without the exact receipt and released custody.
- Native helper output ownership now spans both streams: if metadata or fd 3 overflows, fails, or is cancelled after its peer completed, the completed aggregate and every collected chunk are zeroed. Real helper regressions cover secret-first metadata overflow, metadata-first secret overflow, and cancellation after both aggregates assemble.

The expanded focused/control/browser/monitor gate passed 143 with 0 failures and the single socket-fixture skip. The full suite, verification runner, post-verification runtime-canary scan, and final diff check all passed; exact evidence is recorded above and in the SDD ledger.

## Independent review fix round 3

The final two P2 findings in the updated `task-6-review.md` were verified against the implementation and reproduced with real abrupt-exit subprocesses before production edits.

- Recovery claims are now written to a PID/claim-specific private stage and atomically published with the claimant PID/ID, custody ID, registration digest, source custody-directory identity, source owner-state identity, and exact source digest. Deterministic hard-link election generations admit one claimant for an exact stale source. A live elected claimant blocks every competitor; a dead claimant can be explicitly superseded without removing the exclusive custody directory. The winner rereads the exact source and election identity immediately before atomic owner publication.
- Recovery-crash coverage exits immediately after claim publication, owner staging, owner publication, and before claim cleanup, then starts two competing real recovery processes. Ten stress runs exercised eight crash/concurrency cases each (80/80), always producing exactly one owner. The earlier held-snapshot regression also passed 30/30. The stress gate exposed and then closed a partial-claim visibility/disappearing-loser race by atomically publishing claim files and tolerating only `ENOENT` for concurrently withdrawn losing artifacts.
- Disconnect finalization now uses one exact fixed receipt stage, validates and reconciles its hard-link identity, and directory-syncs both receipt publication and custody removal. Restart can finish an exact orphan checkpoint stage, a published receipt with its staging link, an owner-unlinked custody directory, and an already-removed custody directory whose parent sync was interrupted. Same-process retry recognizes only its own already-removed custody transition. Only bounded private staging/claim artifacts with the exact custody/registration identity are removed; malformed or foreign artifacts remain and fail closed.
- Real killpoint subprocesses exit after each checkpoint-stage write, receipt link, owner unlink, and custody `rmdir`. Ten stress runs covered all four boundaries (40/40), plus ten same-process parent-fsync uncertainty retries (10/10). Every successful replay ends with the exact receipt, no custody directory, no receipt staging name, and a parent-directory sync; no profile contents are recursively removed.

The final expanded focused/control/browser/monitor gate passed 147 with 0 failures and the one socket-fixture skip. Full, verification, post-verification canary, and diff evidence is recorded above and in the ledger.

## Independent review fix round 4

The sole remaining P2 finding, R3.1, was confirmed against canonical-state and
staging-file reads before edits. Seven initial abrupt-exit cases failed because
the restart attempted to parse an uncommitted partial checkpoint/receipt as a
complete authoritative document. A further three RED cases reproduced the same
problem during recovery's own staged owner write, and a legacy complete-header /
partial-event regression failed before its narrow compatibility fix.

- Ordinary checkpoint writes now use one exact custody-bound staging filename.
  Private directory, owner UID/mode, regular-file/single-link checks, and the
  canonical identity establish ownership even before the first byte. Available
  header bytes must exactly match the expected owner, profile, and registration;
  staged event bytes never advance progress.
- An elected stale-owner replacement removes only validated dead-owner stages,
  after rereading the canonical directory/state identities and source digest and
  checking the exact election. It retains the entire claim/election chain until
  owner publication, preserving exclusion of competing live claimants.
- Recovery-owned partial stages are bound to the exact published claim ID, PID,
  custody/registration identity, and canonical source inode/digest. A complete
  legacy random-stage header can establish its binding independently of a partial
  event tail. Headerless legacy random stages remain deliberately fail-closed.
- The fixed receipt stage can be reconciled only by the exclusive completed
  canonical owner, with exact cleanup selections and only an exact prefix of the
  expected receipt. It is never adopted as cleanup evidence. Published receipt
  link-count validation, custody release, and parent-directory sync remain gates.
- Real subprocesses exit after zero bytes, partial headers, complete ownership
  headers, and partial event/body writes for checkpoint and receipt stages.
  Tests repeat restart and recovery-stage process death, preserve foreign/unsafe
  files and mismatched claim provenance, and hold live writers and elected
  claimants while a competitor attempts recovery. Exclusive-create failure
  preserves a preexisting fixed staging file.
- Ten repeated stress runs passed all 200 selected test invocations, including
  80 ordinary partial-stage exits, 80 interrupted recovery-stage writes, 40 new
  recovery winner races, the prior 80 crashed-claim races and 30 held-snapshot
  races, 40 complete-write finalization boundaries, and 10 release-fsync retries.
- Real foreign-UID fixtures are present but explicitly skip where this
  filesystem rejects `chown` with `EINVAL`; the existing socket fixture also
  skips. These are not represented as executed UID/socket acceptance.

Final full-suite, verification, and post-verification canary results are recorded
in the verification section and SDD ledger. Focused evidence is in
`task-6-round4-focused-final.log`; `task-6-round4-repeat-1.log` through
`task-6-round4-repeat-10.log` record the stress runs. The earlier overlapping
focused log lacks a terminal summary and is not used as final evidence; the
standalone final rerun records all 190 test results and its terminal summary.

## Self-review

- Confirmed all public secret requests use exact objects, deterministic purpose-bound references, fixed safe errors, bounded values, and no `get()`-style plaintext API.
- Confirmed the native process launch has one fixed argument, a minimal fixed environment, ignored stderr, bounded metadata stdout, a separate bounded secret descriptor, executable pinning, and fail-closed timeout/cancellation/identity behavior.
- Confirmed connection state contains only metadata and references; owner-control sanitizes even an injected manager that returns extra account/reference/raw-error fields.
- Confirmed disconnect authority is revoked before monitors and secret deletion, unknown purposes fail before state mutation, and the dedicated profile is never automatically removed.
- Confirmed no credential collection, Keychain command, browser installation, portal access, external network operation, or Task 7 adapter was introduced.

## Remaining concerns

No Task 6 synthetic/contract blocker is known. Live mode remains intentionally unavailable in practice: the repository does not ship an installed signed native helper, code-signature/Keychain ACL acceptance has not been exercised on the owner laptop, and no real Chrome profile or portal login has been validated. The full-disk-encryption gate is an explicit owner acknowledgment rather than an OS attestation. Name-based cloud exclusions cannot detect arbitrary configured sync/backup roots, and same-UID/root code remains trusted. Those live checks require separate supervised setup and acceptance; no live readiness claim is made here.
