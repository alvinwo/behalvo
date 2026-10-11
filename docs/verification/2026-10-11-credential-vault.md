# Credential vault verification — 2026-10-11

Scope: the [approved local vault design](../superpowers/specs/2026-10-11-credential-vault-design.md).
This is synthetic local evidence, not live website login or a production security
audit. No actual accounts or passwords entered the tests.

## Local evidence

- `npm run verify` passed on macOS / Node v25.8.1: 1389 tests, 1322 passed,
  67 optional/platform tests skipped, zero failed. Type checks, kernel demo,
  operations demo, owner-control demo, service demo and `git diff --check` passed.
  Summary: `data/verification/2026-10-11T08-51-19.133Z-be409f50-b665-433a-a0f0-9a369b0472f9/summary.json`.
  Source fingerprints before/after matched. This run covered the reviewed fixes;
  final packaging moves unchanged fixture labels into the English catalog.
- Visible, disposable Chromium acceptance: 13/13 passed using a scripted model
  and fake credentials, including capture, encrypted reopen, fresh confirmation,
  form/action/target changes, stale document/task, lock/removal, revocation before
  POST, unknown response, unconfirmed cleanup and exact leading U+FEFF values.
- Model requests, raw journal, source artifacts, rebuilt state, terminal output
  and vault ciphertext were checked for synthetic username/password canaries.
- Storage compatibility and reviewed regressions: 53 passed, one platform skip.
  Existing protected Pi credential/settings formats and no-hook update semantics
  remained compatible. Publication expiry during fsync refused both creation
  and replacement, preserving existing ciphertext and removing owned staging files.

Raw logs are in the ignored `data/verification/credential-vault/` directory.
Tests ran with `TMPDIR=/private/tmp`; real POSIX permission checks required running
outside the desktop sandbox, which strips special file-mode bits on this host.
The existing permission test was retained unchanged.

## Independent reviews

The architecture reviewer approved the written design and implementation plan.
Two independent final reviewers inspected the complete branch. Their findings
required publication guards immediately before rename/link, a wall-clock check
in CLI capture, and exact UTF-8 credential decoding. Each issue had a failing
regression before the fix. Both reviewers approved the corrected changes; merge
also requires final local verification and the exact PR head's hosted CI.

| Role | Model | Effort | Reason | Retries / follow-up | Result |
| --- | --- | --- | --- | --- | --- |
| Architecture/design | gpt-6-astra | max | Credential trust, custody and browser boundaries | One amended-design/plan review | Approved |
| Independent code review | gpt-5.6-sol | high | Storage compatibility, private input and integration | Focused re-review of fixes | Approved |
| Independent security review | gpt-6-astra | high | Revocation, publication and secret use | Focused re-review of two findings | Approved |

The primary chat was the sole implementation writer. No provider-backed live
model evaluation or live portal acceptance was performed for this feature.
Hosted CI is a separate release gate, not implied by the local results above.
