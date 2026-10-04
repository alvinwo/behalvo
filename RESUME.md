# Behalvo Playwright P2 design continuation — 2026-10-03

Current branch: `codex/playwright-p2-design`, based on merged master `6b6ef82`.
The owner delegated technical merge/revise decisions to specialist reviewers,
authorized addressing findings and merging after approval, then starting the next task.
PR #13 merged at `6b6ef8279617c5e2395156c0d1b9eca2697feeda` after independent
Sol-high and Astra-high MERGE decisions for `30ad65e`. All four hosted checks passed.
PR #12 is closed, superseded by #13. Local master is synchronized; its tree exactly
matches the reviewed PR head. The fully merged local P1 branch was removed.

Next work is P2's separate design and implementation plan for authorized synthetic
Playwright actions. Design is in progress; no P2 executable behavior is implemented.
Keep technical approval with the specialists; do not ask the owner to perform code review.
The [P2 architecture checkpoint](docs/superpowers/specs/2026-10-03-playwright-p2-design.md)
records the dispatch-authority and restart-ownership questions. Complete the design
and implementation plan, obtain independent review, then implement. The checkpoint
is a draft, not an approval or a completed plan.

The replacement carries only the reviewed P1 implementation/tests and associated
package/documentation changes. It excludes the installed-extension machinery from
PR #12. BrowserSession and the synthetic portal already exist on master; no
unmerged extension prerequisite is required. The original stacked branch
`codex/playwright-browser-adapter` at `797e7c6` and extension branch
`feat/installed-chrome-bridge` at `634c791` remain intact.

P1 is a visible, isolated, read-only synthetic login diagnostic. It enables no
live sites, accounts, page actions or P2 service integration. The original source
passed independent Sol/Astra code reviews, all six local verification gates and
15/15 visible macOS tests. The clean replacement source `9ec8538` passed all six verification gates
(1099 tests passed, 19 skipped, zero failed), followed by 15/15 visible macOS
acceptance and a successful public command. P1 files are byte-identical to the
previously reviewed implementation; both independent reviewers cleared the new base and reduced PR scope.
Do not apply the old stacked-branch test counts to this tree.
See [the verification record](docs/verification/2026-10-03-playwright-p1.md).

Use Node.js >=22.19 (`/opt/homebrew/opt/node/bin` is available on this Mac).
Matched Chromium is already installed. Run
`npm run browser:playwright -- diagnostic`; see [the guide](docs/PLAYWRIGHT_BROWSER.md).
Preserve old extension test profiles and their custody/Singleton files.
