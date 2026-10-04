# Synthetic Playwright browser workflows

P1 opens a visible, newly isolated Chromium browser, reads the local synthetic
login page through Behalvo's existing BrowserSession, and closes its owned browser.
It requires no Chrome extension, enrollment value, existing profile or account.
The diagnostic does not submit actions. The separate P2 command below runs an explicitly scripted synthetic scheduling workflow through the local service. Neither command uses real accounts or a model.

## Install and run

Use Node.js 22.19 or newer and this checkout's locked dependencies:

```sh
npm ci
npx playwright install chromium
npm run browser:playwright -- diagnostic
npm run browser:playwright -- synthetic-actions
```

The browser install is an explicit one-time download of the build matched to
Playwright 1.63.0. Runtime never downloads a browser or falls back to installed
Chrome. Reinstall the matched build after an explicitly reviewed dependency
upgrade. Playwright manages its own browser cache, including unused cached builds.

The command starts its own synthetic portal at `http://127.0.0.1:43117/`, opens a
visible browser, checks the login state twice through BrowserSession, and reports
actual versions. The browser may appear only briefly. Success requires the owned
process to exit, BrowserServer to close, and its exact temporary profile to be
absent. A successful page read alone is insufficient.

No browser options or other arguments are supported. The command does not use or
remove the old extension test profiles. P1 has been accepted on macOS; other
platforms still require their own visible acceptance. Run from a desktop session.

## Failure and cancellation

Ctrl-C, SIGTERM and SIGHUP use the same bounded cleanup path. Setup is limited to
15 seconds, each observation to 10 seconds, and total cleanup to 5 seconds.
A missing browser prints the explicit installation command. A port conflict fails
without attaching to the existing listener. Ambient Selenium/Playwright routing,
browser location/platform overrides and debug settings are refused; remove those
settings from this command's environment before running it.

Failed browser ownership attempts retain a private `receipt.json` per owner in
generated temporary directories. Each contains only a run ID, fixed
phase/status/code, and owned process/profile identity when available. P2 may
retain several browser receipts. Pending portal/service startup still exits 3
but may have no browser receipt when no owner was created. Exit code 0 means success; 1 means failed with cleanup confirmed;
2 means invalid arguments; 3 means cleanup is unconfirmed. Internal unexpected
failures are reported conservatively without raw upstream exception messages.

If cleanup is unconfirmed, do not automatically rerun or delete a profile. Inspect
the exact receipt and reconcile that run's owned resources first. When launch
never returned a process handle, the profile path is explicitly unavailable and
termination cannot be confirmed. Bounded CLI exit ends reliable late cleanup;
Playwright's process-exit hooks are only best effort. There is no broad process
kill, global profile scan, Singleton deletion or automatic recovery command.

## Scope and verification

For the P1 diagnostic, context routing allows only GET of the exact synthetic root from the owned main
frame. Other methods/paths, off-origin navigation, popups, subframes, WebSockets,
service workers and downloads are rejected. JavaScript is disabled in the page.
P1 gesture requests reject before authorization/dispatch. The local browser
control endpoint is private to the launching process; this is a trusted local
API boundary, not an OS network sandbox or protection against same-UID code.

Offline regression tests do not launch browsers. Explicit visible acceptance:

```sh
npm run build
TMPDIR=/private/tmp BEHALVO_PLAYWRIGHT_ACCEPTANCE=1 node --test tests/playwright-acceptance.test.mjs
```

The acceptance suite uses only owned synthetic browsers and local servers. It
covers normal observation, changed markup, navigation during a pending read,
crash, cancellation, blocked mutations/off-origin requests/popups, and signals
during launch. [Verification record](verification/2026-10-03-playwright-p1.md).
## P2 supervised synthetic actions

`synthetic-actions` starts a private encrypted temporary service store and pairs
through its local control API. Its fixed script proposes, reviews and arms the
synthetic grant, observes an empty calendar, cleanly restarts, pauses for a
synthetic human challenge, resumes from fresh DOM evidence, rejects a withdrawn
candidate, and books one later candidate. It verifies the rendered appointment,
checks that another restart creates no effects, and rebuilds projections without
executing effects. Successful cleanup removes the generated store and profiles.

The browser submits actual typed DOM forms. A one-use route permit binds each
request to its command, source document, epoch, sequence and deadline. A fresh
synchronous durable authorization guard runs immediately before dispatch.
Redirects and retries are disabled. HTTP forbidden/rate-limited responses must
match the actual parsed page state. An unknown submission is never resubmitted;
only verification through a fresh owned browser can resolve an exact readback.

Each browser startup is limited to 15 seconds, observations/gestures to 10 seconds,
and the entire script to 180 seconds plus 5 seconds for cleanup. Restart requires
confirmed service shutdown and exact owned browser destruction. Active-operation
handoff terminates the browser and fails closed. Same-run idle handoff supports
fresh resume; cold crash ownership recovery is not implemented.

All CLI copy uses the existing English catalog; there is no locale selector.
Run the P2 visible suites serially because they own the same fixed loopback port:

```sh
TMPDIR=/private/tmp BEHALVO_PLAYWRIGHT_P2_ACCEPTANCE=1 node --test --test-concurrency=1 tests/playwright-actions-mechanics.test.mjs tests/playwright-actions-acceptance.test.mjs tests/playwright-actions-service.test.mjs
```

[P2 verification record](verification/2026-10-03-playwright-p2.md).

This remains synthetic-only, foreground and awake-only. It does not establish
real-site compatibility, account security or unattended production readiness.
