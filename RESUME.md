# Behalvo browser discovery design continuation — 2026-10-04

Current branch: `codex/browser-discovery-design`, based on merged master `4fa2394`.
The owner delegated technical review and merge decisions to specialist agents,
authorized fixing findings and merging after approval, then starting the next task.
Do not ask the owner to perform code review.

## Completed

[PR #14](https://github.com/alvinwo/behalvo/pull/14) merged at
`4fa239488bcad79d11775368fa417559cc19bd70`. Independent Sol-high and Astra-high
reviewers approved all source, lifecycle, authority, cleanup, and test follow-ups.
All four hosted checks passed on final head `0e26f2a90048658277a3501590f62f66c7fd2d53`.
Local master was fast-forwarded and its tree compared equal to that reviewed head.
Post-merge CI also passed on that exact merge commit.
The merged local P2 feature branch was removed; historical extension branches and
profiles were preserved.

P2 is operational for synthetic data only: visible owned browser forms, one-use
permits, synchronous durable guards, paired service grants, polling, clean restart,
handoff/resume, candidate race, one booking, authoritative readback and replay.
Unknown submissions are never resubmitted. Missing/mismatched readback stays unknown.
All six local verification gates passed; 1,160 tests passed, 52 opt-in skipped.
The separate combined visible P1/P2 suite passed 57/57 and both public commands
exited 0 with confirmed cleanup. A later test-only CI timing correction passed
32/32 focused tests and another full verification. See
[the P2 verification record](docs/verification/2026-10-03-playwright-p2.md).

PR #13 delivered P1, the read-only login diagnostic. PR #12 was closed unmerged.
The old installed-extension path is not a prerequisite for P1/P2.

## Current task

The next discovery scope is drafted and independently approved as a design gate.
The roadmap and live-discovery document still contain extension-centric assumptions;
reconcile those with the application-owned browser without treating synthetic
acceptance as live-site compatibility or authorization. No production origin,
credential, account, live grant or real booking is authorized by this design task.
Astra-max authored
[the next scope](docs/superpowers/specs/2026-10-04-browser-discovery-scope.md), and
Sol-high approved it without scope blockers. It proposes a sanitized, partial
evidence exporter in verification support using existing read-only P2 cases,
with no new runtime/browser authority. Next: write and review the short
implementation plan, including a fixed case/check catalog, strict snapshots,
nonpassing skipped/failed/pending-cleanup outcomes, and clear source provenance.
Keep any actual live operation behind separate explicit scope and evidence gates.

Use Node >=22.19 (`/opt/homebrew/opt/node/bin` on this Mac) and canonical
`TMPDIR=/private/tmp` for verification. Matched Chromium is installed.
Run either `npm run browser:playwright -- diagnostic` or
`npm run browser:playwright -- synthetic-actions`; see
[the browser guide](docs/PLAYWRIGHT_BROWSER.md). Run visible suites serially;
they share the fixed synthetic portal port. Preserve old extension test profiles
and custody/Singleton files.
