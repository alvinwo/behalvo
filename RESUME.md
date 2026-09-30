# Behalvo laptop continuation — 2026-09-29

## Current source of truth

Repository: `alvinwo/behalvo`, local checkout
`/Users/alvinwo/Documents/workspace/behalvo`.
Branch: `feat/installed-chrome-bridge`. PR [#12](https://github.com/alvinwo/behalvo/pull/12)
targets `master` and remains **draft**. Do not merge without separate owner authorization.

Latest reviewed implementation head:
`0d554eb3afce1af2ae1c93962693881f0ad42aa6`.
Implementation tree: `422e45d658b595064fa557eae1557f08ccff0373`.
Later documentation-only checkpoint commits may follow; discover actual local and
remote heads before resuming. Never reset to a SHA from this document.

The 2026-09-29 continuation ran directly on the owner's Mac (`Darwin`) using local
terminal, Git, and authenticated `gh`. It found a clean stale local master at
`5d250f9`, fetched `origin/master` at `09b99e6`, and continued from the verified
feature/PR head `3cb1f1a`. No local-only commits, changes, or other worktrees were
present. Local master was left untouched. All publication used ordinary Git with
remote-head checks and preserved ancestry; no force-push or merge occurred.

## Implemented review corrections

All R1–R8 hypotheses were supported by observed failing behavior tests and corrected:

- **R1:** registration is bound to the exact dedicated profile's
  `NativeMessagingHosts` directory, created after the profile. Generated-artifact
  conflicts are detected without following symlinks before staging writes. Native
  registration itself must be a canonical single-link owner-only regular file.
- **R6:** any Singleton entry, including a dangling symlink, blocks removal.
- **R7:** integrity pins include compiled package JavaScript/JSON and package
  metadata, not just the broker entry. Stale source can still be explicitly removed
  without deleting profile data.
- **R2:** native channel completion is observed during inspect and subsequent
  Chrome wait. Later normal Chrome exit cannot convert channel failure to success.
- **R3:** release requires complete service/bridge/portal cleanup and either known
  never-launched Chrome or observed process exit, plus existing idle-profile
  validation. Unknown cleanup/exit retains custody. Real rendezvous cleanup reports
  retained unknown artifacts instead of silently claiming success.
- **R4/R5:** broker handshake teardown destroys native input; rendezvous owns and
  closes stalled pre-enrollment sockets and their handlers.
- **R8:** SIGINT/SIGTERM use one cancellation path and bounded cleanup. Storage keys
  are cleared. Unconfirmed Chrome shutdown retains custody and reports cleanup
  pending; owned stderr/process handles are detached after the bound so ordinary
  failure also cannot keep the CLI alive indefinitely.

The bridge remains synthetic and diagnostic-only: explicit popup enrollment, one
local service, one read-only inspect. No live portal, credentials, booking/page
mutation, automatic reconnect, or new M3 recovery authority was introduced.

## Evidence and review gates

See the current [laptop verification record](docs/verification/2026-09-29-chrome-review-laptop.md)
for exact RED/GREEN logs, commits, full verification summaries, CI runs, review
findings and their resolution. Raw laptop logs are retained under
`data/verification/`; hosted runs retain their own verification artifacts.

Both required independent full-PR review contexts completed their reviews and
focused re-reviews through `0d554eb`: **gpt-5.6-sol high** and **gpt-6-astra high**,
with no outstanding supported defects. They did not implement the corrections or
impersonate installed Chrome acceptance. Their code-review clearance is not merge
permission or evidence of real Chrome compatibility.

On reviewed code head `0d554eb`, laptop `npm run verify` passed all six gates:
1,124 tests, 1,120 passed, zero failures, four skipped. Hosted PR run
[36534553233](https://github.com/alvinwo/behalvo/actions/runs/36534553233)
passed Node 22.19 and Node 24 on that same head. Later documentation-only checkpoint
verification is identified by its own exact HEAD in local summaries/GitHub checks.

Local verification uses the installed Node 25.8.1 via
`PATH=/opt/homebrew/opt/node/bin:$PATH` and `TMPDIR=/private/tmp`. The default shell
Node 22.17 is below the project minimum, and macOS's default temporary path has a
symlink ancestor rejected by canonical profile validation. Hosted Node 22.19 and
Node 24 are separate required gates. Consult terminal summaries and exact-head
GitHub checks; never carry an older green result forward to changed code.

**Owner-laptop installed Chrome acceptance remains pending.** No everyday Chrome
profile was opened, no real Chrome enrollment/diagnostic was performed, and no
live visa account was accessed. Real Chrome may close its native port before its
process exits; that ordering remains an acceptance uncertainty. Preserve the
conservative R2 fail-stop rule rather than interpreting later exit as channel
success without distinct evidence.

## Exact next action

1. Reconcile current checkout/remote/PR heads and verify the latest exact-head
   laptop summary and hosted Node 22.19/24 results linked in the verification
   record. Preserve any subsequent work.
2. Complete the separately supervised dedicated-profile installed-Chrome acceptance
   from the reconstructed M1 plan: extension loading, native-host invocation,
   explicit enrollment, one login inspect, channel-loss behavior, clean close and
   custody release. Keep PR #12 draft while required gates remain unsatisfied.
3. Merge only with separate owner authorization. No merge is authorized by this
   handoff. M2 synthetic booking and M3 recovery remain later milestones; live
   portal discovery and real authority remain separately gated.

## Workflow and preserved decisions

Read `AGENTS.md`, `README.md`, `SECURITY.md`, the development skill and its recovery/
review-release references, `docs/MODEL_USAGE.md`, `.agents/model-usage.json`, the
[reconstructed M1 plan](docs/superpowers/plans/2026-09-27-installed-chrome-bridge-m1.md),
and the [review-fix plan](docs/superpowers/plans/2026-09-29-chrome-m1-review-fixes.md).
Use one implementation writer, test-first corrections, meaningful verified commits,
focused independent review, and actual exact-head verification evidence. On POSIX,
`npm run verify` includes checks, all required demos, and the Git diff check.

The [surviving design](docs/superpowers/specs/2026-09-25-installed-chrome-bridge-design.md)
contains broader proposals; the reconstructed M1 decisions are the approved scope.
The kernel stays model/transport-independent, the application a modular monolith,
and domain changes journal-backed/deterministically reduced. Replay never executes
effects; unknown external outcomes never authorize retry. Local owner ID remains a
trust binding, not public authentication. Synthetic data only.

**Do not restart historical object recovery.** Original archived implementation
objects `8146aca`, `2ef4802`, `4fb957b`, and `76f15b2` were unrecoverable; that recovery
was exhausted. Tasks 1–3 were rebuilt test-first from preserved approved decisions.
The rebuilt branch, present tests, current reviews and verification are the source
of truth; summaries and old green results are navigation, not completion evidence.

## Installed-Chrome acceptance follow-up

The owner confirmed loading Behalvo in the dedicated test profile. Registration
then exposed macOS Chrome's normal code-sign-clone hard links, rejected by our
single-link executable check. A narrow compatibility correction and regression
tests are described in the laptop verification record. Fresh setup is required
for the changed compiled bundle; do not manually update old integrity pins.
No installed-Chrome handshake or diagnostic success has yet been observed.
