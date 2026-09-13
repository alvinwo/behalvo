# Task 2 implementation report

## Result

- Pinned `@earendil-works/pi-ai` at 0.85.1 as a normal dependency and raised the supported/CI Node floor to 22.19.0.
- Added atomic owner-only model settings beside each database, scoped by workspace and limited to provider/model identifiers.
- Restored saved model selection after explicit `--model`, `BEHALVO_MODEL`, and `OPERATOR_MODEL` sources; successful startup and REPL selections persist.
- Kept `--offline` isolated from saved selection reads and writes.
- Added actionable startup, malformed-settings, and unavailable-saved-model guidance without echoing settings content.
- Updated local setup documentation for ordinary `npm ci`, explicit login/model commands, precedence, and separate credential storage.

## TDD evidence

Behavior tests were observed failing before implementation for the missing settings module and REPL callback, inherited object-property workspace IDs, and unsafe echoing of unknown saved values. The final suite covers per-workspace persistence, file permissions, credential-key exclusion, malformed settings, prototype-name workspaces, saved restore, explicit override, unavailable saved selection, and offline isolation.

## Verification

- Fresh `npm ci`: passed (93 packages installed from lockfile).
- `npm run check`: passed, 136 tests and typecheck.
- `npm run demo`: passed.
- `npm run mvp:demo`: passed.
- `npm run operations:demo`: passed.
- Offline CLI startup with fresh temporary database and nonexistent auth path: passed.
- Pi loader/catalog import using a nonexistent temporary auth path: passed; found pinned `openai-codex/gpt-5.6-sol` without authentication.
- `git diff --check`: passed.

## Concerns and limits

Live OAuth and inference were intentionally not exercised. The initial implementation serialized settings only within one instance; the whole-branch follow-up below adds cross-process locking. A process crash can leave a lock file; remove it only after all processes using those settings have stopped.

## Review follow-up

The task review found that interactive selection updated the registry before a settings callback failure, while the outer command handler reported only the raw error. A regression test now verifies the chosen model remains visibly active for following chat, persistence failures produce a fixed sanitized restart warning, and the previous saved selection remains intact. Remaining current-guide references to an optional Pi adapter were changed to bundled Pi adapter.

## Whole-branch review follow-up

A whole-branch review reproduced a lost update when separate settings-store instances or processes wrote different workspaces concurrently. The settings store now uses a bounded cross-process exclusive lock around the complete load/update/atomic-replace transaction. Successful concurrent writes are retained; lock contention times out with an honest sanitized failure, and update failures remove temporary and lock files. A 16-process regression and malformed-update cleanup/recovery test cover these paths.

Focused verification after this fix: TypeScript build and all 5 model-settings tests passed. A broad suite run also encountered two failures in concurrently edited task-3 tests (`local-synthetic` workspace binding and `operation-loop` history trimming); this scoped task did not modify or resolve those files.
