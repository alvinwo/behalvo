# Public HTTPS browsing — 2026-10-11

The owner approved normal public HTTPS access without per-domain enrollment,
while retaining isolated sessions, exact-origin field/vault binding, reviewed
journaled gestures and private/local network restrictions. The primary remains
the sole implementation writer. Specialist review, fixes, PR publication,
exact-head CI and merge are authorized in the current conversation.

Executable source is `05111a59c8b98ea2bddf190723ec43575db26a53` on
`codex/public-https-browsing`, based on merged PR23 at `da27afbd`. Current network
policy and commands are documented in the [browser guide](docs/PLAYWRIGHT_BROWSER.md)
and [approved amended design](docs/superpowers/specs/2026-10-11-managed-browser-design.md).
Independent Sol/high and Astra/high reviewers approved after correcting stale
origin-grant wording in the live agent system prompt.

Full POSIX verification passed: 1,365 tests passed, 85 opt-in skips, zero failures,
and all six verification steps passed. All 46 managed-browser cases passed
across focused runs with real Chromium against synthetic sites. The public visa
information page rendered without enrollment, but remaining resource resets and
403 responses prevent any claim of complete portal compatibility. No real login,
account or appointment mutation was tested. Exact evidence and limitations:
[public HTTPS verification](docs/verification/2026-10-11-public-https.md).

The latest change removes `/browser allow` from normal use. The compatibility
command only explains the public policy. Private/local/file access, gesture
review, input scope, cookie policy, unknown barriers and synthetic vault behavior
remain unchanged. No storage migration is required. Existing Behalvo processes
must restart to pick up the code; do not stop an owner's session or inspect its
account state during development.

Before resuming integration, inspect git and remote PR state rather than assuming
this checkpoint means published or merged. Required hosted checks must pass on
the exact final PR head. After merge, sync clean local `master` and remove only
this merged feature branch. Preserve ignored profiles, auth and evidence.

Use Node from `/opt/homebrew/opt/node/bin` and `TMPDIR=/private/tmp` on this laptop.
The general browser still uses manual login handoff and programmatic semantic
gestures. Authenticated H-1B compatibility, live vault-driven login and unattended
booking remain unverified or outside this change.
