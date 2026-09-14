# Private model-state verification

Date: 2026-09-14.

## Tested source and environment

The tested working tree was based on source commit
`680e932c9e3caeef068c562937a335d17a707a00` and included the uncommitted Task 3
CLI, evaluation, test, and documentation changes described here. The final commit
had not been created when these commands ran.

- Linux, Node.js v24.19.0, npm 11.9.0.
- All model-state, CLI, and evaluation fixtures used generated temporary keys,
  temporary owner-private paths, synthetic credentials, and synthetic gateways.
- No provider login, live model completion, real account, recipient, deployment,
  browser flow, or external effect was used.

## Commands and observed results

The npm proxy configuration variables were unset for every npm gate.

| Command | Observed result |
| --- | --- |
| `npm run build && node --test tests/model-state-config.test.mjs tests/cli-main.test.mjs tests/evaluation-cli.test.mjs` | Exit 0; 40 tests, 39 passed, 0 failed, 1 skipped because the filesystem could not construct a foreign-owned directory. |
| `npm run check` | Exit 0; strict TypeScript check and build passed; 513 tests, 511 passed, 0 failed, 2 skipped. The skips were the unavailable foreign-owner fixture and the Windows-only protected-file refusal on Linux. |
| `npm run demo` | Exit 0; offline fake provider, zero real messages, replay matched. |
| `npm run mvp:demo` | Exit 0; restart/cross-thread state and raw-history assertions completed. |
| `npm run operations:demo` | Exit 0; three verified synthetic operations, zero real external effects, unknown outcome remained blocked, replay matched. |
| `npm run owner-control:demo` | Exit 0; two authenticated synthetic decisions, replay rejection, verified/cancelled synthetic actions, zero real model calls or external effects. |
| `npm run eval:agent -- --scripted` | Exit 0; 60/60 automatic checks passed across three repetitions; scripted non-live evidence only, with live/manual acceptance still pending. |

The scripted evaluation wrote its plaintext JSON report beneath ignored private
runtime data. The report was not added to Git.

Raw local command logs are retained in the ignored Task 3 work directory at
`.superpowers/sdd/2026-09-14-private-model-state/task-3-logs/`. The npm lifecycle
portion of `npm-check.log` was captured there; the complete Node test reporter
summary observed by the runner is recorded in the table above.

## Behaviors covered

The focused tests cover strict flag/env precedence and mode rejection; ignored
ambient configuration in offline/scripted/list/help paths; the complete
database, SQLite companion, synthetic sidecar, model-state data/lock, and key
collision families; canonical and inode aliases; no-modification failures; and
generated key loading with fixed errors.

Subprocess and injected-boundary tests cover both protected writer preflights
before SQLite/Pi/report activity, explicit-model settings validation, wrong keys,
corruption, plaintext mismatch, `0400` writer refusal, one protected settings
store reused by startup and `/model`, eager key copying/clearing, and sanitized
evaluation failures. Copied-dist and injected gateways expose only controlled
synthetic catalogs and never perform inference or login.

## Gates not executed

Remote CI was not run for this working tree. The configured Node.js 22.19.0 and
24.x matrix runs `check`, `demo`, `operations:demo`, `owner-control:demo`, and a
diff check; it does not run `mvp:demo` or the scripted evaluation. No configured
CI result is claimed here. Genuine live-model
evaluation, provider correctness, manual acceptance, Windows ACL behavior,
production retention/erasure, authenticated remote/mobile owner control, and
deployment review remain unverified and open.
