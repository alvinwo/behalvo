# Installed Chrome bridge M1 — hosted CI checkpoint

Date: 2026-09-28 (America/Los_Angeles)

## Scope

This record covers the rebuilt **M1 installed Chrome bridge implementation** on
`feat/installed-chrome-bridge`. M1 is diagnostic-only: it proves the code path for
dedicated-profile Chrome installation, explicit extension enrollment, native
messaging relay, private rendezvous, and one read-only browser inspection. It does
**not** grant live US visa booking authority or prove compatibility with the
owner's installed Chrome.

Draft PR: #12 (`feat: installable Chrome bridge M1`).

## Exact verified implementation

- Implementation commit:
  `474b859101632e8d9dbb465354982736c55b5c63`
- Implementation tree:
  `35922b1ea575de1440f62934ef0d685b5489cfbc`
- Hosted GitHub Actions run:
  `36525209546`
- Command exercised by both hosted lanes:
  `npm run verify`

Results:

| Runtime | Tests | Passed | Failed | Skipped |
| --- | ---: | ---: | ---: | ---: |
| Node 22.19.0 | 1,096 | 1,092 | 0 | 4 |
| Node 24.x | 1,096 | 1,092 | 0 | 4 |

Both jobs completed successfully.

## Rebuilt M1 behavior covered

The branch contains behavior-tested support for:

- explicit popup-only extension enrollment with no native-host connection at
  background startup;
- distinct disconnected/enrolling/enrolled/invalidated states;
- background-owned selection of exactly one allowed non-incognito synthetic tab;
- staged/finalized dedicated Chrome installation, read-only doctor, and narrow
  removal that retains the profile and unknown artifacts;
- private profile custody and current-user native-host registration;
- bounded private IPC framing, one-use enrollment, channel binding, and fail-stop
  native broker relay;
- shell-free dedicated Chrome launch using only the owned profile and fixed
  synthetic portal URL;
- a read-only diagnostic coordinator that starts one local service, binds the
  rendezvous to its actual service generation, performs one `inspect` of the
  synthetic login page, and grants no gesture/booking authority;
- `browser run` key loading/zeroization with the storage-key path forwarded into
  the existing local-service path-separation guard;
- bounded Chrome termination and observed-exit custody release on diagnostic
  failure;
- prompt failure and cleanup if the dedicated Chrome process exits before
  enrollment.

## Audit fixes added after the first green coordinator

The full bridge path was audited from popup enrollment through rendezvous, broker,
transport, coordinator, and CLI. That audit produced additional RED→green
regressions for:

1. preserving `storageKeyPath` so an alias with SQLite/database paths is rejected
   by the existing service configuration guard;
2. terminating the diagnostic-owned Chrome process on enrollment failure and
   releasing profile custody only after process exit is observed;
3. racing enrollment against Chrome exit so an early browser death fails promptly
   instead of waiting for the full enrollment window.

The final hosted verification above includes these fixes.

## Gates that are still pending

This record is **not** M1 acceptance evidence for the owner's laptop.

Still required before M1 can be called complete:

1. independent high-risk PR review using the repository-required Sol-high and
   Astra-high reviewer contexts;
2. any supported review fixes followed by focused regressions and full verification
   on the exact reviewed head;
3. owner-laptop acceptance proving that installed Chrome loads the staged
   extension in the dedicated profile, invokes the registered native host,
   enrolls through the extension popup, completes the diagnostic round trip, and
   cleans up without deleting the profile;
4. merge of PR #12 under the repository review/release workflow.

No real visa account, portal credentials, CAPTCHA/challenge, payment, polling, or
appointment mutation was used in this checkpoint. Live portal discovery and any
real scheduling authority remain separately gated later work.
