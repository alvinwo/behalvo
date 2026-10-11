# Harness sessions and managed browser verification

Date: 2026-10-11. Branch: `codex/harness-browser`. Base: `0738ffd`.
Environment: macOS, Node 25.8.1, pinned Playwright 1.63.0, visible managed Chromium.

## Scope

The approved designs are [harness sessions](../superpowers/specs/2026-10-11-harness-sessions-design.md)
and [managed browser](../superpowers/specs/2026-10-11-managed-browser-design.md).
The delegated architecture review approved both before implementation.
The primary agent implemented them; final independent review is a separate gate.

Behavior tests were observed failing before the history/recall, action broker,
network gate, live adapter, session controller and terminal command implementations.
Integration testing found a stale-observation guard incorrectly treating a completed
fill as unknown; the failing end-to-end test passed after separating pre-dispatch
control freshness from post-dispatch lease authority.

## Evidence already collected

- Harness/context/intake/operation regression selection: 72 tests, 71 passed,
  1 skipped, zero failures after the approved legacy-context compatibility fix.
- Network/process-owner/action boundary selection: 29 passed. An additional
  forged-digest regression brought browser-action tests to eight passing cases.
- Session/exploration/harness/continuity selection: 36 passed, zero failures.
- Terminal/session/exploration selection: 29 passed, zero failures.
- Visible managed browser acceptance: 8 passed, zero failures. Two unrelated
  dynamic synthetic websites used the actual chat/controller/review path. Tests
  covered encrypted backup and effect-free rebuild, cross-turn cookies, manual
  synthetic login, stale/replaced/ambiguous controls, handoff input invalidation,
  blocked redirects/popups/WebSockets/service workers, and confirmed owned cleanup.
- The server-applies-then-drops-response case observed exactly one mutation,
  journaled unknown, denied a replacement browser, preserved the barrier through
  replay, and reconciled only through an explicit owner command without redispatch.
- Production network smoke reached `https://example.com` with no test network,
  proxy, certificate or browser overrides; fresh observation contained the public
  multilingual domain notice. The initial assertion expected an old English
  heading and did not match the current page. No real account or mutation was
  involved, and owned cleanup was confirmed. This proves bounded public HTTPS
  observation only, not compatibility with an authenticated portal.
- Live `openai-codex/gpt-6-astra` acceptance used four completions on a synthetic
  class directory. It proposed the expected navigation for trusted review,
  reported Cedar at 09:30, saved one grounded note, and left two accepted actions
  (owner open plus navigation). Cleanup was confirmed. This run used the existing
  configured provider; no credential value was inspected or printed. It is
  distinct from the scripted acceptance tests.

Local raw evidence is under `data/verification/harness-browser/`, including
`live-model.json` and `public-smoke.json`. Full `npm run verify`, independent
Sol high/Astra high review and exact-head hosted CI remain release gates; this
record must not be read as evidence that those pending gates have passed.

## Limits

No actual account, H-1B portal, reservation or booking was tested. Live vault
login, existing profiles/CDP, persistent browser login, uploads/downloads,
WebSockets, service workers, arbitrary page scripts and unattended monitoring
remain outside the feature. The browser/network controls are not an OS sandbox.
Visible page data is sent to the selected model and can be journaled; storage
encryption is a separate opt-in. Owner reconciliation records an owner's account
of an outcome rather than independently verifying remote truth.
