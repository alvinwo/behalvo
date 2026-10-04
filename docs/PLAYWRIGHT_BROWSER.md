# Read-only Playwright browser diagnostic

P1 opens a visible, newly isolated Chromium browser, reads the local synthetic
login page through Behalvo's existing BrowserSession, and closes its owned browser.
It requires no Chrome extension, enrollment value, existing profile or account.
It does not run the agent, log into websites, monitor appointments or submit actions.

## Install and run

Use Node.js 22.19 or newer and this checkout's locked dependencies:

```sh
npm ci
npx playwright install chromium
npm run browser:playwright -- diagnostic
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

Failures retain a private `receipt.json` in a generated temporary directory. It
contains only a run ID, fixed phase/status/code, and owned process/profile identity
when available. Exit code 0 means success; 1 means failed with cleanup confirmed;
2 means invalid arguments; 3 means cleanup is unconfirmed. Internal unexpected
failures are reported conservatively without raw upstream exception messages.

If cleanup is unconfirmed, do not automatically rerun or delete a profile. Inspect
the exact receipt and reconcile that run's owned resources first. When launch
never returned a process handle, the profile path is explicitly unavailable and
termination cannot be confirmed. Bounded CLI exit ends reliable late cleanup;
Playwright's process-exit hooks are only best effort. There is no broad process
kill, global profile scan, Singleton deletion or automatic recovery command.

## Scope and verification

Context routing allows only GET of the exact synthetic root from the owned main
frame. Other methods/paths, off-origin navigation, popups, subframes, WebSockets,
service workers and downloads are rejected. JavaScript is disabled in the page.
All gesture requests reject before authorization/dispatch. The local browser
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
P2 actions, durable service integration, human handoff and live accounts require
separate design and approval; P1 does not establish their guarantees.
