# Harness sessions and managed browser verification

Date: 2026-10-11. Branch: `codex/harness-browser`. Base: `0738ffd`.
Environment: macOS, Node 25.8.1, Playwright 1.63.0, visible Chrome for Testing
153.0.8010.12. Only synthetic accounts and non-sensitive public content were used.

## Scope and review

The delegated architect approved the [harness sessions design](../superpowers/specs/2026-10-11-harness-sessions-design.md)
and [managed browser design](../superpowers/specs/2026-10-11-managed-browser-design.md)
before implementation. The primary agent implemented them. Independent Sol/high
and Astra/high source review found dispatch, cookie, cleanup, review-display,
inbox-settlement and documentation defects. Supported findings were reproduced
and repaired. The architect approved the private isolated-world dispatch and
bound-chat handoff clarification. Both reviewers approved the repaired source
through `4586677`. Review decisions and exact-head hosted CI are
recorded in the associated pull request; this document does not substitute for CI.

Behavior tests failed before the history/recall, action broker, network gate,
live adapter, session controller and terminal command implementations. Integration
also exposed a post-dispatch stale-observation guard; a successful gesture now
requires current lease authority without retaining its obsolete observation.
Review regressions reproduced a covered-link destination race, concealed field
changes through page prototypes, credential forwarding that bypassed Chromium,
and a late proxy bind after reported cleanup. The repairs retain unknown outcomes
without redispatch. Full verification exposed an eager Playwright import in two
offline copied-checkout CLI tests; lazy loading repaired both without changing
live browser behavior. A final focused review also bound native submit/toggle
values and form encoding/validation, and rejected duplicate visible option
labels. Both regressions were observed failing before repair, then passing.

## Final local evidence

Source head: `45866778174c61614d46fcc70dc4a5ed420e51b4`.

- Full POSIX `npm run verify`: **passed**, 1,444 tests, 1,361 passed,
  83 opt-in skips, zero failures. Check, demo, operations demo, owner-control demo,
  service demo and Git diff check all passed. HEAD and source fingerprint were
  unchanged and the tree was clean before and after the run.
- Terminal summary:
  `data/verification/2026-10-11T17-48-02.563Z-1880d90c-5ccc-4bdc-b6a4-96b3a15abd89/summary.json`.
  The prior failed run at `be6c1f2` remains retained; it is not passing evidence.
- Explicit `BEHALVO_MANAGED_ACCEPTANCE=1 node --test tests/managed-browser-*.test.mjs`:
  **41 passed**, zero failures or skips at the same source head. Raw output:
  `data/verification/harness-browser/final-managed.log`.
- The real Chromium suite uses two unrelated dynamic synthetic websites through
  the actual chat/controller/review path. It covers JavaScript, CSS and images,
  allowed and denied redirects, POST search, reviewed mutating GET, manual login
  across turns, separate session cookies, exact option/destination review, stale
  references, same-node link/form/field/option changes after the journal mark,
  prototype overrides, covered controls, handoff and task-input invalidation.
- Boundary tests cover credential omission, cross-site SameSite requests and
  rejected response cookies, positive retained login cookies, popup/WebSocket/
  service-worker denial, inaccessible file controls and rejected attachments,
  active origin revocation, pending-start closure and owned process/profile cleanup.
- A synthetic server applied a mutation and dropped its response. Exactly one
  mutation was observed; unknown blocked a replacement browser, survived rebuild,
  and changed only after explicit owner reconciliation. Encrypted backup/rebuild
  did not execute browser effects. Existing vault, synthetic browser, operation
  and owner-control regression tests remained passing.

## Live model and public web evidence

These are distinct from scripted model tests. Both ran against repair source
`be6c1f2dae2d88ebc6da3bf067388a69e987158b`; subsequent product changes made
the Playwright import lazy for non-browser startup, bound additional native form
semantics, and rejected ambiguous option labels. The final local suites cover
those changes; the model and public runs retain their actual earlier source head.

The live model was `openai-codex/gpt-6-astra`, using the already configured
provider, from 17:42:07 to 17:42:29 UTC. The exact task was:

> For this task, inspect the connected synthetic class directory, follow Browse choices, and report the morning class and its time. Save a useful navigation note. Do not enroll or make reservations.

The owner fixture first opened `https://example.test/`. Four completions included
two browser tool calls: `observe {}` then `navigate` with the current observation
ID and opaque control reference. Trusted review approved only “Browse choices”
to `https://example.test/choices`; no broader or later action was approved.
The reply reported Cedar at 09:30, one grounded navigation note was journaled,
and both owner-open and navigation actions were accepted. No unknown occurred.
Cleanup was confirmed. Raw tool arguments, review, reply, times and outcomes are
in `data/verification/harness-browser/live-model.json`. No credential bytes were
inspected, printed, or included in the model prompt.

The production-network smoke at 17:42:36 UTC opened `https://example.com/` with
no test DNS, proxy, certificate, profile or browser overrides. It produced a
fresh nonempty public observation, an accepted open action and confirmed cleanup
(`data/verification/harness-browser/public-smoke-final.json`). An earlier smoke
expected the old “Example Domain” heading, which did not match the current
multilingual domain notice; that earlier assertion remains recorded as failed.
The final smoke checks public HTTPS observation, not a particular page heading.
No login, real account or remote mutation was involved. This establishes bounded
public access, not authenticated-portal compatibility.

## Limits

No actual H-1B account, reservation or booking was tested. Live vault login,
existing profiles/public CDP attachment, persistent login after restart, file
transfer, WebSockets, service workers, arbitrary model scripts and unattended
monitoring remain outside the feature. Semantic events are programmatic; sites
requiring trusted keyboard/pointer input need manual handoff. The browser/network
controls are not an OS sandbox. Visible data is shared with the selected model
and can be journaled; encryption is a separate opt-in. Owner reconciliation is
an owner's attestation, not independent proof of the remote outcome.
