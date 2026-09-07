# Verification report — local agent MVP

Date: 2026-09-07.
Branch: `feat/mvp-local-agent`.

## Scope verified

This report covers the local terminal MVP: provider-neutral model turns, the optional Pi model adapter and credential store, durable owner/assistant turns, WorkItem and Fact proposals, cross-thread/restart recovery, the terminal REPL, and the deterministic offline MVP demo.

It does **not** claim live email, phone, WhatsApp, WeChat, browser actions, hosted operation, or production readiness.

## Build environment

The verification container runs Linux, Node.js v22.16.0 and npm 10.9.2. The committed project uses TypeScript and the Node 22 built-in SQLite driver.

Outbound npm registry access is unavailable in this container. For verification only, TypeScript and `@types/node` are linked from already-installed toolchain copies in the environment. No runtime provider package is required for offline mode.

The current `@earendil-works/pi-ai` package requires a newer Node 22 patch level than this container (Node >=22.19 at the time of this verification), so live Pi/Codex OAuth cannot be executed here. The adapter and OAuth/credential boundary are contract-tested with injected fake Pi runtimes. Users should use a current Node 22 or Node 24 release for the Pi-backed path.

## Fresh commands executed

```bash
npm run check
npm run mvp:demo
```

`npm run check` runs the strict TypeScript check, a fresh build, and every `tests/*.test.mjs` test.

## Fresh results

- TypeScript strict check: **passed**.
- Build: **passed**.
- Automated tests: **62 passed, 0 failed, 0 skipped**.
- Deterministic restart demo: **passed**.
- Node's built-in SQLite emits its experimental-feature warning under Node 22.16.0; the warning is intentionally not suppressed.

The 62 automated tests include the original M0 kernel tests plus MVP tests for:

- strict, provider-independent `AgentTurn` parsing;
- rejection of malformed model output, unknown fields and forged provenance;
- durable owner-message ingestion before model processing;
- trusted runtime application of WorkItem and Fact proposals;
- restart recovery and cross-thread WorkItem reuse;
- provider/model registry routing and ambiguity rejection;
- optional Pi model adapter request/response mapping;
- Pi-compatible credential persistence outside Journal/State;
- provider-owned OAuth login forwarding;
- cancellable terminal OAuth prompts;
- REPL model selection, login, state/work/history/context inspection and thread changes;
- CLI boot from an empty database in offline mode;
- restart demo proving durable state without smuggling an old thread transcript into the new model context.

## Observed restart-demo output

```json
{
  "firstReply": "I will track your Maui preparation.",
  "secondReply": "Your Maui preparation is still open and departs on 2026-09-12.",
  "workPhase": "open",
  "workThreadIds": [
    "thread-before-restart",
    "thread-after-restart"
  ],
  "departureDate": "2026-09-12",
  "rawOwnerMessage": "I am going to Maui on September 12.",
  "actionCount": 0,
  "journalCount": 10
}
```

This specifically verifies that:

1. process one creates durable WorkItem and Fact state;
2. the SQLite connection is closed;
3. process two opens the same database and uses a different Thread;
4. the second model turn receives the durable WorkItem/Fact state;
5. the old raw owner transcript is **not** silently copied into the new Thread's model context;
6. the old raw message is still retrievable from immutable history;
7. no external action is executed by the MVP model path.

## Model and Codex boundary

The core does not depend on Pi. A `ModelGateway` abstraction owns provider/model discovery and completion, and `PiModelGateway` is an optional adapter.

Pi session/cache hints are transport hints only; Pi conversation state is not authoritative Agent memory. Journal, projections, WorkItems, Facts and Thread artifacts remain the source of durable state.

Provider credentials are persisted separately in `data/pi-auth.json`, use Pi-compatible credential shapes, are written atomically with restrictive Unix permissions, and are not written to Journal, model context or domain state. The MVP supports provider-owned `/login <provider> oauth|api_key` flows through the REPL.

Live ChatGPT/Codex subscription OAuth is **not** claimed as verified in this offline container. The first real-device smoke test should be `/login openai-codex oauth` on a current Node version with `@earendil-works/pi-ai` installed.

## Known MVP limitations

- No automatic conversation compaction or semantic historical retrieval yet. Raw history is retained; durable WorkItems/Facts and bounded recent context provide the current cross-thread memory behavior.
- No email, SMS, phone, WhatsApp, WeChat or browser channel/capability adapters yet.
- Model proposals are limited to WorkItems and Facts in this MVP; they cannot directly execute external effects.
- Pi is an optional local dependency and was not fetched in this network-isolated build container.
- `PiCredentialFileStore` serializes refresh writes within one process; multiple concurrent processes sharing one auth file are not supported yet.
- There has been no independent security review, penetration test or hosted multi-tenant review.
- GitHub remote CI has not run for this branch.

## Clean-copy release gate

A clean source tree was exported from committed Git `HEAD` with `git archive`; it did not reuse the worktree's `dist`, database, or generated runtime data. Because the build container has no npm registry access, the clean copy was wired only to the already-installed TypeScript and `@types/node` toolchain copies. No application/runtime dependency was copied from the working tree.

The following were then executed in the clean copy:

```bash
npm run check
npm run mvp:demo
printf '/model\nhello from clean copy\n/history 8\n/quit\n' | npm run agent -- --offline --db <fresh-temp-dir>/agent.db
```

Results:

- clean-copy strict typecheck/build: **passed**;
- clean-copy automated tests: **62 passed, 0 failed, 0 skipped**;
- clean-copy restart demo: **passed** with the same durable-state/raw-history assertions described above;
- clean-copy CLI subprocess: **passed** from an empty database;
- the CLI persisted a non-empty SQLite database containing the new Journal records.

This clean-copy gate verifies the offline MVP is reproducible from committed source in the available build environment. It does not change the live Pi/Codex limitation above.
