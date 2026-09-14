# Verification record — encrypted workspace storage foundation

Date: 2026-09-14.
Local runtime: Linux, Node.js v24.19.0.
Initial independent-review baseline: `1dfb1cb`.

## Scope

This record covers the opt-in encrypted SQLite storage foundation for new
databases: authenticated private payloads and keyed lookup tokens, strict
key-file configuration, fail-closed format/path handling, pure encrypted-snapshot
validation, and exclusive verified backup/restore. It also covers the subsequent
review fix that restores `messageCount`'s existing zero result for an absent
workspace in encrypted mode while retaining authenticated, workspace-scoped
journal decoding when rows exist.

The initial baseline received two independent whole-branch reviews. Astra
reported no findings. Sol reported the encrypted `messageCount` compatibility
regression and the stale current-verification banner; both are addressed in the
tree represented by this record. A controller-owned scoped re-review still
applies to these subsequent review fixes.

This foundation does not complete M1.1 live acceptance or M1.2 owner control. It
does not add a credential vault, remote authentication, retention/erasure, key
rotation, legacy plaintext migration, rollback detection, restored-copy fencing,
or real-data readiness. Payload encryption is not whole-file encryption; the
visible metadata and operating limits are documented in the
[private storage guide](../PRIVATE_STORAGE.md).

## Commands and current local results

The post-fix tree was verified with both npm proxy variables removed per command:

```bash
env -u npm_config_http_proxy -u NPM_CONFIG_HTTP_PROXY npm run check
env -u npm_config_http_proxy -u NPM_CONFIG_HTTP_PROXY npm run demo
env -u npm_config_http_proxy -u NPM_CONFIG_HTTP_PROXY npm run mvp:demo
env -u npm_config_http_proxy -u NPM_CONFIG_HTTP_PROXY npm run operations:demo
env -u npm_config_http_proxy -u NPM_CONFIG_HTTP_PROXY npm run eval:agent -- --scripted
```

Observed results:

- Strict TypeScript typecheck and build: passed.
- Full automated suite: 342 tests counted, 341 passed, 0 failed, 1 existing
  environment-dependent filesystem-capability skip.
- Offline foundation demo: passed with `realMessagesSent: 0`,
  `fakeProviderCalls: 1`, `recoveredUnknownActions: 1`, `dueTimersFired: 1`,
  `secondPollFired: 0`, `rawHistoryRetained: true`, and `replayMatches: true`.
- Restart/cross-thread MVP demo: passed with `actionCount: 0` and 10 journal
  records while preserving the expected durable work, fact, and raw message.
- Synthetic operations demo: passed with `realExternalEffects: 0`, 3 verified
  operations, `unknownBlocked: true`, and `replayMatches: true`.
- Scripted agent evaluation: 60/60 automatic checks passed; each of three
  repetitions passed 20/20, including all 10 critical cases, using 90 scripted
  calls.

The scripted evaluation is deterministic non-live evidence. No live model,
provider login, real account, real external effect, deployment, or personal data
was used. Live-model acceptance and manual review remain pending.

## Review-fix regression evidence

The `messageCount` regression test exercises real plaintext and encrypted stores
with an absent workspace, an existing workspace with an absent thread, actual
message counts, and cross-workspace/thread scoping.

Before the implementation fix:

```bash
env -u npm_config_http_proxy -u NPM_CONFIG_HTTP_PROXY npm run build && \
  node --test --test-name-pattern='message counts preserve' tests/encrypted-storage.test.mjs
```

Build passed. The plaintext subtest passed; the encrypted absent-workspace case
failed with `Workspace not found` as expected. Node's test report counted 1 pass
and 2 failures because it reports both the failed encrypted subtest and its
parent.

After the minimal implementation fix, the same focused command passed 3/3 with
0 failures/skips. The encrypted path now returns zero only when no projection
exists. Existing workspaces still authenticate their projection and decrypt all
rows in the scoped journal before counting exact message events.

## Minimum supported Node evidence

Before the initial independent-review baseline, controller-run focused checks on
pinned Node.js 22.19.0 recorded:

- 17/17 for the key, payload-cipher, and private-file foundation;
- 52/52 for encrypted-store integration and snapshot validation;
- 16/16 for the backup, restore, storage CLI, and key-file agent wiring;
- the focused malformed-UTF-16 compatibility coverage also passed.

Those checks resolve focused minimum-runtime API and behavior uncertainty,
including Node 22's standard SQLite ExperimentalWarning. They are not final
PR-head CI.

## Publication boundary

At the time this record was prepared, final CI had not run on either Node.js
22.19.x or 24.x for the final PR head. The controller will run and inspect that
exact-head CI after the subsequent review fixes are committed and scoped
re-review completes. Actual workflow/head links and the final commit identity
belong in the PR review record; this document does not preclaim them.

Earlier verification records remain historical evidence for their exact trees:

- [PR #1 review and fixes](../reviews/2026-09-08-pr-1.md)
- [Behalvo v0.2.1 naming patch](2026-09-07-behalvo-rename.md)
- the historical local MVP record embedded in [VERIFICATION.md](../VERIFICATION.md)
