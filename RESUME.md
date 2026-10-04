# Behalvo Playwright P1 continuation — 2026-10-03

Current branch: `codex/playwright-p1`, directly based on master `09b99e6`.
The owner authorized publishing a new PR for the current Playwright work and
closing stale PR #12. No merge is authorized.

The replacement carries only the reviewed P1 implementation/tests and associated
package/documentation changes. It excludes the installed-extension machinery from
PR #12. BrowserSession and the synthetic portal already exist on master; no
unmerged extension prerequisite is required. The original stacked branch
`codex/playwright-browser-adapter` at `797e7c6` and extension branch
`feat/installed-chrome-bridge` at `634c791` remain intact.

P1 is a visible, isolated, read-only synthetic login diagnostic. It enables no
live sites, accounts, page actions or P2 service integration. The original source
passed independent Sol/Astra code reviews, all six local verification gates and
15/15 visible macOS tests. The clean replacement base needs its own verification
and focused review before publication; do not apply old test counts to this tree.
See [the verification record](docs/verification/2026-10-03-playwright-p1.md).

Use Node.js >=22.19 (`/opt/homebrew/opt/node/bin` is available on this Mac).
Matched Chromium is already installed. Run
`npm run browser:playwright -- diagnostic`; see [the guide](docs/PLAYWRIGHT_BROWSER.md).
Preserve old extension test profiles and their custody/Singleton files.
