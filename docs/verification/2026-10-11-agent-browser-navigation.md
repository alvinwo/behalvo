# Agent-initiated browser navigation verification

Date: 2026-10-11. Executable source: `ee0d784ee1565a832aa72f654259048751bba81f`.

## Behavior

With `--browser live`, a resolved task exposes `visit` before any page exists.
The model chooses when browsing is needed and the public HTTPS URL; the owner
reviews each proposed visit before destination traffic. `/browser open` is an
optional trusted shortcut with one-use exact-URL/source authority. A direct
answer allocates no browser resources. Later visits reuse the scoped session and
cookies, invalidating control and input references even for fragments.

Live mode stays supervised. Public network restrictions, manual login handoff,
input authorization, task/chat isolation, resource caps, unknown-effect barriers
and replay semantics are unchanged. No storage migration or dependency added.
Startup/help and absent-page feedback use the existing English catalog in
`src/browser/live-messages.ts`; the CLI has no other supported locale.

## Tests and model acceptance

Behavior tests first failed for the missing visit validator/adapter, lazy
session acquisition and absent-session live loop. They passed after implementation.
Focused runs passed 69 tests across action (9), real Chromium adapter (17),
session (9), exploration loop (21), CLI (5) and real Chromium chat acceptance (8).
The acceptance test's review-prompt recorder was corrected after initially
checking output writes rather than the trusted read prompt; all eight then passed.

Coverage includes no resources for direct answers/absent observation, exact visit
arguments, legacy digest stability, review and action.started before traffic,
reject/handoff with zero destination requests, cookies across turns, fragment
reference revocation, cancelled pending allocation, late completion, unconfirmed
cleanup, scoped leases, unknown navigation sent once and encrypted rebuild with
no repeated effects. Existing manual-open/login paths remain covered.

A bounded actual `openai-codex/gpt-6-astra` run on a fresh synthetic class directory
completed in four model calls (including task intake). It independently emitted
`visit` for the supplied site, then `navigate` to the discovered class choices.
Both exact synthetic gestures were approved by the test review callback. It
reported Cedar at 09:30 with observation evidence, saved one advisory navigation
note, and confirmed owned browser/profile/proxy cleanup. There was no prerequisite
controller.open call, real account, personal browser profile or website credential.
Raw local evidence: `data/verification/agent-browser-navigation/live-model.{mjs,json,log}`.
This proves the actual model-to-browser path on a synthetic site, not authenticated
H-1B portal compatibility, unattended monitoring or verified booking.

## Release gates

`PATH=/opt/homebrew/opt/node/bin:$PATH TMPDIR=/private/tmp npm run verify`
passed on Node 25.8.1/npm 11.11.0. All six steps exited zero: check, kernel demo,
prepared-operation demo, POSIX owner-control demo, service demo and diff check.
The default suite reported 1,469 tests, 1,377 passed, 92 opt-in skips and zero
failures. The explicitly run Chromium suites above cover managed-browser acceptance.

Terminal summary and raw logs:
`data/verification/2026-10-11T22-10-28.284Z-0de976da-ea33-460c-bfbc-c97e03db843e/summary.json`.
The source head stayed `ee0d784`, with the same before/after fingerprint
`6f01e9bd5513d6c5f30f2a2ae187dc1c6dac091090c46fcae1f503f2714b4da7`.
Only documentation changes followed. Hosted CI is separate evidence and must
pass on the exact final PR head before merge.

## Delegation ledger

- Architecture: gpt-6-astra, max; approved the design and plan; zero retries.
- Independent code/security review: gpt-5.6-sol, high; high-risk final review;
  zero retries; approved with no actionable findings.
- Independent architecture/security review: gpt-6-astra, high; high-risk final
  review; zero retries; approved with no actionable findings. Independently ran
  44 action/session/exploration/CLI tests, all passed.
