# Verification report — M0 offline foundation

Date: 2026-09-07.
Source-code checkpoint: `360582c9c8d49494df4fd40734dc5290d3ab452c`.
Subsequent handoff changes affect documentation only.

## Environment

Linux; Node.js v22.16.0; npm 10.9.2; TypeScript 5.8.3;
@types/node 22.19.7. Three installed development/transitive packages, zero runtime
npm dependencies. Dependency versions and integrity values are in package-lock.json.

The network registry was not reachable from the build container (DNS resolution
failed). Installation was completed from the existing npm cache with the committed
lockfile, not by substituting untracked dependencies. Live registry availability
and a vulnerability audit were not verified.

## Commands actually executed

```bash
npm ci --offline --cache /root/.npm --ignore-scripts --no-audit --no-fund
npm run check
npm run demo
git diff --check
git diff --cached --check
git bundle verify /mnt/data/personal-operator.bundle
```

`/root/.npm` is a cache path in the build environment, not a requirement for users.
Use ordinary `npm ci` in an environment with registry access.

## Results

- TypeScript strict check and build: passed.
- Automated tests: **39 passed, 0 failed, 0 skipped**.
- Offline demo subprocess: passed as part of the test suite and independently.
- Original test-first run: 36 failing behavior assertions for missing implementation.
- Additional test-first run: 3 expected failures for demo, historical stateAt and
  summary-size limit; all passed after implementation.
- Fresh clone from Git bundle: dependency install, strict checks, all 39 tests and
  offline example passed again. The restored branch is `feat/bootstrap`.
- Source ZIP: independently extracted and checked during final handoff validation.

The Node 22 built-in SQLite driver emits its documented experimental warning.
This is not suppressed or misreported as a clean production stability guarantee.

## Observed demo output

```json
{
  "mode": "offline-fake-provider",
  "realMessagesSent": 0,
  "fakeProviderCalls": 1,
  "crossThreadWorkId": "refund-demo",
  "workStatus": "open",
  "recoveredUnknownActions": 1,
  "dueTimersFired": 1,
  "secondPollFired": 0,
  "rawHistoryRetained": true,
  "rawMessagesOmittedFromContext": 8,
  "sourceLinkedSummariesLoaded": 1,
  "contextEstimatedTokens": 1766,
  "replayMatches": true,
  "journalRecords": 24
}
```

## Coverage of behaviors, not a coverage-percentage claim

Tests exercise journal update/delete rejection; atomic rollback; revision conflict;
ingress deduplication and collision rejection; workspace isolation; persistence;
projection replay and historical state; transactional inbox acknowledgement;
approval identity/digest/expiry/work-version binding; effect redispatch;
unknown-outcome recovery and explicit reconciliation; timers after restart;
cross-thread work; source-preserving summaries; budget overflow; future facts
and conflicting claims.

Restart tests close and reopen real SQLite connections. They do not simulate
hardware power loss, all operating-system crash modes, or real provider outages.
The fake provider is not evidence of production mail or messaging reliability.

## Review and release limitations

Architecture-to-code self-review and regression tests were performed. There was
no independent reviewer or security audit. The GitHub Actions workflow is configured
for Node 22.16 and 24.x, but **remote CI has not run**; local Node 24 compatibility
was not tested. No GitHub repository, issue, Projects board, PR or public release
was created. No production account was accessed. License choice remains pending.
