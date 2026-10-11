# Agent-initiated browser navigation — 2026-10-11

The owner asked for normal prompts to let the agent decide when to browse and
which website to visit, without typing `/browser open`. Specialist design and
code/security reviews, fixes, PR publication, exact-head CI, merge and cleanup
are authorized. The primary remains the sole implementation writer.

Source is `ee0d784ee1565a832aa72f654259048751bba81f` on
`codex/agent-browser-navigation`, based on merged PR24 at `d3aa4ef`.
The live loop exposes a reviewed `visit` even with no existing session. A lazy
owned port allocates only on a visit, reuses the task/chat browser and cookies,
and owns pending cleanup before allocation awaits. Text-only answers allocate
nothing. Every model visit requires private owner review before destination
traffic. Optional trusted `/browser open` retains one-use exact-URL authority.

Approved [design](docs/superpowers/specs/2026-10-11-agent-browser-navigation-design.md)
and [plan](docs/superpowers/plans/2026-10-11-agent-browser-navigation.md).
[Browser guide](docs/PLAYWRIGHT_BROWSER.md) and
[verification evidence](docs/verification/2026-10-11-agent-browser-navigation.md)
record current behavior, tests, model acceptance and limits.

Full POSIX verification passed: 1,377 tests passed, 92 opt-in skips, zero failures;
all six verification steps passed. Focused runs passed 69 tests, including actual
Chromium on synthetic sites. An actual Astra run chose visit from a task prompt,
followed a discovered link and reported the observed class time; cleanup confirmed.
Both independent reviewers (Astra/high and Sol/high) approved with no actionable
findings.

Before integration, inspect git and remote PR state rather than assuming this
checkpoint means published or merged. Exact-head hosted CI remains required.
After merge, sync clean local master and remove only the merged feature branch.
Preserve ignored profiles, provider auth and local evidence. Existing Behalvo
processes must restart to pick up changes; do not stop the owner's session or
inspect its account state during development.

Use Node from `/opt/homebrew/opt/node/bin` and `TMPDIR=/private/tmp` on this laptop.
No storage migration is required. Public HTTPS remains available without origin
enrollment. Manual login, reviewed gestures, field input authorization, private
network restrictions and unknown barriers remain. Real authenticated H-1B portal
compatibility, unattended monitoring and booking verification are not established.
