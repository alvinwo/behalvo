# Scoped Sol Node 22 compatibility re-review

## Scope and verdict

- Reviewed range: `5e09824..a1d0489`.
- Reviewed source fix: `a1d0489abe66e6c4c17f04843a870ec6a806f6e2` (`fix: stabilize Node 22 focused verification`).
- Current head observed: `7e89aea50ce05b007c8b01d6d10a77f96ef64d3c`, whose only additional change is the Node 22 verification document.
- Scope: Node 22 child-process import corrections and synthetic portal connection-close behavior only; no repeat of prior whole-branch review.
- **Blockers: none.**
- **Scoped SPEC: PASS. Scoped QUALITY: PASS.**

## Findings

No correctness, safety, or behavior regression was found in the three-file fix.

### Narrow child-process imports — accepted

The Keychain child probe now imports `dist/secrets/keychain.js` directly (`tests/keychain-contract.test.mjs:310-330`), and the two native-messaging subprocess probes import `dist/browser/native-host.js` directly (`tests/native-host.test.mjs:89-133`). These are the implementation modules that `dist/index.js` re-exports; the change removes only the unrelated eager barrel import of experimental `node:sqlite` under Node 22.

The probes retain their original behavior and safety assertions unchanged:

- exact fixed safe error output;
- successful child exit;
- empty child stderr;
- rejection of raw/private error leakage;
- bounded timeout/close behavior with no stalled child.

The parent test files still import the public barrel normally, so public export compatibility remains exercised. The child probes appropriately isolate the low-level implementation behavior they are intended to test.

### Synthetic portal `Connection: close` — accepted

`startSyntheticPortal` now sets `Connection: close` before route validation and dispatch (`src/synthetic-portal/server.ts:33-38`). The header therefore applies uniformly to HTML, JSON, form redirect, not-found, origin/host rejection, and other fixed error responses, including errors reached through the async handler catch. It does not alter request parsing, fixed-origin/Host/Origin checks, content security policy, cache policy, response bodies, durable synthetic state, gesture semantics, or status codes.

Closing each synthetic response is a bounded fixture behavior that prevents a Node 22 built-in-fetch pooled socket from being reused after one fixed-port server instance closes and a new instance binds the same origin. It also makes server lifecycle isolation stronger and does not broaden network access or effect authority. The portal is a loopback synthetic test/demo boundary, so persistent connection throughput is not an acceptance requirement.

## Evidence and limits

The supplied regression report records the isolated Node 22 failure pattern and the focused GREEN evidence:

- Node 22.19.0: Keychain 14/14, native host 15/15, visa observation 17/17.
- Node 24.19.0: Keychain 14/14, native host 15/15, visa observation 17/17.
- Total per runtime: **46 passed, 0 failed**.

The complete visa-observation file covers sequential fixed-origin server lifecycles, which is the behavior that failed on Node 22. `git diff --check 5e09824..a1d0489` is clean. Per dispatch, I did not run a build, tests, full verification, or any port probe, and I made no tracked repository change. The controller's exact full verification on both runtimes was still in progress when this report was written.

This remains local synthetic evidence. It does not establish installed-browser/native-helper, Keychain, live portal/account, hosted execution beyond the separately recorded CI evidence, push, merge, or publication acceptance.

## Actual review usage

- Reviewer: `/root/recovery_review_sol`.
- Model: `gpt-5.6-sol`.
- Effort: high.
- Delegated agents: zero.
- Review retries: zero.
- Result: scoped pass with no blockers; report written outside the repository.
