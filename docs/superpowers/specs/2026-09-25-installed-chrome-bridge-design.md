# Installed normal-Chrome synthetic bridge — proposed design addendum

Status: **proposal for review, not implementation approval**. Prepared 2026-09-25 from the monitored-actions tree at `d3a5d35e9aa214a5e824ffcd6ca769ea4d6b47df` and `visa-next-gap-analysis.md`. No repository edit, installation, browser run, external research, or test execution accompanied this proposal. PR #11 merged as `09b99e6b9464b0765a7fa1bc517c34ea47cce405`. This proposal starts from that merged baseline.

## Outcome and fixed scope

The owner can install a local development bridge, launch one dedicated normal Chrome profile, explicitly enroll its one synthetic-portal tab, and use the existing paired service UI to set up, review, arm, pause, resume, and verify one synthetic appointment. The service remains a foreground modular monolith and the sole owner of SQLite, jobs, grants, and browser execution authority.

This increment adds **one installed bridge with one browser channel per run**. A lost channel stops that run. There is no automatic reconnect, tab substitution, browser driver, second service, general browser RPC, or newly authorized effect. The only page origin remains `http://127.0.0.1:43117`. There are no live origins, portal credentials, Keychain operations, signing claims, live discovery, or changes to the Beijing booking policy. The extension is owner-loaded as an unpacked development extension. A local install is not a signed distribution or live-readiness claim.

## Reuse and minimal new components

Retain `BrowserSession`, `NativeMessagingTransport`, existing native framing, extension request/gesture fencing, synthetic page contracts, `createSyntheticMonitoringComposition`, paired grant controls, encrypted service storage, and unknown-effect barriers. Connect through the existing `SyntheticMonitoringBrowserFactory` returning `{transport, tabId}`. Do not expose its injected callback through HTTP or allow user configuration to supply executable code.

Add four small modules: a synthetic browser coordinator/CLI; installation and doctor utilities; a Chrome-launched native broker; and a private IPC/enrollment adapter implementing `BrowserSessionTransport` by delegating to `NativeMessagingTransport`. Extend the existing extension with a connect popup and explicit port-disconnect handling. Keep these in the existing package.

The broker is a framing relay. It never opens the database, evaluates a grant, chooses a page, records an outcome, or launches Behalvo. The coordinator calls `startLocalService` exactly once and owns the synthetic portal, IPC server, browser launch, and cleanup.

## Installation and commands

Add an explicitly synthetic CLI, provisionally `npm run browser -- <command>`. Ordinary `npm run service` defaults remain unchanged.

| Command | Defined behavior |
| --- | --- |
| `setup --root ABS --chrome ABS` | Validate a private canonical install root outside Git/sync/backup exclusions; stage the compiled extension at a stable path, a launcher, and installation metadata; create a dedicated synthetic profile. Record the reviewed package path, absolute Node/Chrome paths and content hashes. Print instructions to load the extension in that profile and obtain its extension ID. Never choose an everyday profile. |
| `setup --root ABS --extension-id ID` | Finalize the staged install using the exact 32-character ID. Reuse `createNativeHostManifest` and the existing host name. Register in the current user's macOS Chrome native-host directory; no admin or system registration. Refuse a conflicting existing registration. Exact repeated setup is idempotent. |
| `doctor --root ABS` | Read-only checks of package hashes, canonical paths, owner/modes, manifest host/path/exact extension origin, Node compatibility, custody and Chrome Singleton markers, rendezvous status, and synthetic-only permissions. Report registered/configured separately from an observed successful Chrome handshake. Never repair or delete stale state implicitly. |
| `run --root ABS --storage-key-file ABS` | Validate installation, acquire profile custody, restore synthetic provider state, and start the installed synthetic composition described below. Launch the configured normal Chrome executable with only the dedicated `--user-data-dir` and fixed portal URL; no automation or remote-debugging flags. Print waiting/enrollment instructions and later the ordinary service URL/bootstrap path. |
| `run ... --recover-custody ID --confirm-previous-run-exited` | Explicit stale-profile-custody recovery using the existing recovery election rules, only after the old process has exited and Chrome Singleton entries are absent. This never performs domain/action recovery or restores a grant allowance. |
| `remove --root ABS` | Require no current coordinator/browser ownership. Remove only exact matching native registration and enumerated bridge-generated install files. Retain profile, database, keys, provider evidence, and unknown artifacts. Print retained paths; offer no recursive profile deletion. Refuse mismatched registration or changed artifacts. |

The launcher executes the absolute Node binary and compiled broker entry point directly; it must not invoke `npm`, rebuild, or print a startup banner to stdout. Its fixed installation-root argument is non-secret. Generated shell literals must safely quote spaces and metacharacters. Chrome's invoking extension-origin argument must exactly match the recorded extension ID; unexpected arguments fail closed. The broker reads configuration from that fixed installation, never an ambient environment variable or a web page.

This is a local development installation tied to a reviewed built checkout. Bundle changes require explicit setup/update rather than silently continuing under an old registration. No claim is made that hash pinning is code signing. macOS is the first owner-laptop target; Linux tests use redirected temporary registration roots and subprocess fixtures.

## Profile custody and the enrollment trust boundary

Use the same canonical-path, private-parent, excluded-root, profile inode, Singleton-marker, exclusive custody, and stale-owner recovery implementations already in `private-connection.ts`. Do not introduce a second lock scheme or fabricate a `PrivateConnectionManager` authority callback.

Proposed narrow reuse: expose an internal **synthetic profile lease** wrapper around `validateProfile`, `acquireProfileCustody`, and `recoverProfileCustody` in their current module. Bind its registration digest to a distinct synthetic-lease format tag, installation ID, profile ID, and canonical profile device/inode. Its recovery wrapper accepts only matching leases with **empty disconnect-event history**, so it cannot recover or release a private-connection custody record. Return only custody identity and release capability. Existing private-connection APIs and on-disk formats remain unchanged.

The coordinator acquires this lease before Chrome launches. It releases it only after the service and bridge are stopped and Chrome has exited with Singleton markers absent. Failure leaves custody for explicit recovery; no Chrome marker or unknown custody artifact is deleted automatically. The existing `syntheticMonitoring`/`privateConnections` mutual exclusion remains intact: this lease owns only a synthetic browser process/profile, not a journaled private account connection.

Chrome native messaging does not itself provide a verified user-data-directory path. This design therefore binds profile identity through the coordinator's owned launch/custody plus explicit owner enrollment in that launched profile. It does **not** claim cryptographic attestation of the filesystem profile. Same-UID code and the owner remain inside the existing local trust boundary. This limitation must be accepted for the synthetic development milestone; it is not enough to declare future live profile validation complete.

## Startup order and exact enrollment

1. Validate install/configuration/key/path separation and take an exclusive coordinator installation lock. Acquire/recover the synthetic profile lease while Chrome is closed. Start/restore the fixed-origin synthetic portal; if the port is occupied, stop rather than choose another origin or connect to the existing listener.
2. Call `startLocalService` with encrypted storage, no real model configuration, and the existing synthetic fixture. Its normal database lock, workspace/installation checks, and schema handling run first.
3. Inside `createBrowserTransport(context)`, bind the private Unix-domain socket and create fresh random run and enrollment capabilities. The context supplies the actual service and installation generations; do not invent replacements. Publish owner-only rendezvous/bootstrap files atomically, then launch normal Chrome. The factory waits at most **120 seconds** for explicit enrollment. The coordinator prints the file path and waiting instructions; it does not wait for owner-control HTTP, which does not yet exist.
4. In the extension popup the owner enters the one-use enrollment value from the private bootstrap file and chooses **Connect synthetic tab**. The background obtains candidates through trusted Chrome tab APIs, requires exactly one non-incognito tab at the fixed portal root, and obtains its real tab ID. The popup cannot provide an arbitrary URL, origin, profile ID, or tab ID. Zero/multiple candidates yield a fixed local instruction and no native connection. No token is persisted in extension storage or sent through a content script/page.
5. The background opens the native port and sends its bounded enrollment message. The broker validates the caller origin/configuration, connects to the private service endpoint, authenticates, and forwards the enrollment request. The service binds installation, service generation, profile lease identity, extension ID, real tab ID and fixed origin. Consume the enrollment value exactly once. Reject additional enrolled channels.
6. Once both sides acknowledge enrollment, delete the current rendezvous/enrollment files and return `{transport, tabId}`. Normal service composition finishes, HTTP pairing becomes available, and the existing owner-reviewed synthetic setup/arm path is used. Enrollment gives transport access only; it neither sets up a connection nor creates/arms a grant. First activation and every page operation still use the existing epoch/document protocol.

Timeout or any startup failure closes the new socket/broker, cleans only exactly owned temporary artifacts, shuts the partly started service/portal, and leaves the profile/custody intact if Chrome remains open. Do not print readiness until `startLocalService` has returned.

## IPC authentication and frame directions

Keep one `NativeMessageReader` per physical input stream for its entire lifetime; do not parse a handshake with one reader and switch readers, which would lose coalesced buffered bytes.

The run descriptor under an owner-only runtime directory contains `{version, installationId, runId, serviceGeneration, socketPath, capability, expiresAt}`. The broker opens it with no-follow, current-owner, single-link, bounded-size/mode checks. A separate enrollment bootstrap contains the owner-entered one-use value and expiry. Neither value appears in argv, environment, stdout text, status, logs, evidence, or provider state. The socket is inside the same private directory, with canonical ownership checks. Reject an overlong socket path before publication rather than using a world-accessible fallback.

The initial IPC hello has exact keys for version, kind, installation/run/service generation, invoking extension origin, capability, enrollment value, tab ID and fixed page origin. Compare capabilities in constant time, check expiry and exact configured bindings, and allow only one successful enrollment. The authenticated private local endpoint plus the exact installation files are the IPC trust boundary; this is not remote authentication or a defense against compromised same-UID code. Invalid connections are closed individually without displacing a valid one.

| Direction | Payload |
| --- | --- |
| Chrome → broker, first frame | `bridge.enroll` with one-use owner value and background-derived tab/origin; no browser execution request |
| Broker → service, first IPC frame | Strict authenticated hello incorporating that enrollment and the descriptor's run binding |
| Service → broker → Chrome | Enrollment accepted/rejected control message; no grant or page authority |
| Service → broker → Chrome, enrolled | Existing native request/control/prepare/commit/cancel messages produced by `NativeMessagingTransport` |
| Chrome → broker → service, enrolled | Existing strict native result/control/preparation/cancellation responses |

IPC uses the existing four-byte little-endian JSON framing with a **64 KiB outer limit**. Post-enrollment IPC frames are exact `{bridgeVersion: 1, kind: 'browser.frame', channelId, message}` envelopes. The enclosed browser message retains the existing **32 KiB** limit. The broker removes/adds only this envelope; Chrome receives the existing browser wire message unchanged. The service adapter maps IPC payloads to bounded in-memory streams consumed/produced by `NativeMessagingTransport` and existing `writeNativeMessage`, preserving all cancellation/commit framing. Endpoints continue full browser-schema validation; the broker validates its outer protocol, direction, size and permitted message kind, not page semantics.

Each handshake has a **5-second** transport deadline within the 120-second owner enrollment window. Browser exchanges retain the existing 10-second native response timeout and runtime/gesture deadlines. Limit pending bytes to **256 KiB per direction**, apply backpressure, and close on overflow/invalid UTF-8/truncation/unknown control/incorrect channel ID. Stdout is native frames only; diagnostic stderr uses fixed codes without input data. No unbounded retry, persistent queue, heartbeat service, or alternate endpoint is added.

## Disconnection, shutdown, and restart

Any enrolled IPC/native-port/tab loss or unexpected cross-origin navigation closes the channel and immediately prevents new bridge requests. The coordinator stops service admission/scheduling and invokes existing bounded service shutdown. Outstanding operations settle under the existing runtime rules; a possibly dispatched booking remains unknown/verification-only. The broker does not buffer for reconnect or replay a frame.

Add a narrow background-controller invalidation entry point so native disconnect retires the current binding, cancels preparations, and attempts a bounded content revocation using existing messages. An already dispatched commit may have acted; do not claim disconnect proves nonexecution. New connection attempts are refused for that run. Human challenge handoff while the channel is healthy continues to use the existing durable pause/epoch retirement and explicit paired resume; it is not a transport reconnection.

The owner closes the dedicated browser to end a run cleanly. On SIGINT/SIGTERM the coordinator follows existing five-second runtime drain, retires/closes the bridge, removes its exact runtime files/socket, and closes the portal. It does not forcibly terminate unrelated Chrome processes. If Chrome remains open after a bounded five-second cleanup check, exit with a fixed cleanup-pending result and retain profile custody for explicit recovery. No automatic profile deletion occurs.

A later explicit `run` requires closed Chrome, fresh enrollment, fresh service generation/epochs, and the same installed synthetic state. It must not reset a retained reservation or rebuild provider truth from the journal. Existing confirmed human pauses can use existing fresh resume. **An unresolved persisted handoff tied to an unavailable old tab stays blocked**; this increment does not synthesize a revocation acknowledgment. The paired owner may stop/revoke that monitor; a new proposal is permitted only if existing domain barriers permit it. Unknown/accepted-unverified attempts remain readback-only. Exact restart handling for this blocked case must be demonstrated by a focused test; convenience recovery is outside scope.

## Synthetic provider persistence and acceptance controls

Persist `SyntheticPortalState.exportDurableState()` separately from the service journal using its existing strict `restore()` contract. Initialize once for a new installation; missing/corrupt prior provider state blocks startup. Never silently reseed it. Use a bounded owner-only synthetic JSON file with atomic replacement and directory sync; it contains only known synthetic fixture fields and is explicitly not a general protected credential store. Keep service SQLite encrypted with its separate supplied key.

Add a narrow persistence callback to the synthetic server/coordinator so state changes are saved before a successful provider response. Failure closes the portal and stops the coordinator; a started service action still becomes unknown. This preserves synthetic provider truth across process restarts without adding another database or workflow engine.

For the human acceptance scenario, the foreground CLI may accept only three fixed synthetic fixture commands: introduce the existing human challenge, complete that challenge, and publish the existing eligible slot. Use existing guarded state methods, persist the result, and instruct the owner to refresh the synthetic page. These controls cannot reset booking/intent, create confirmation, reset mutation count, arm a grant, or act on a real origin. Reject them after a reservation/mutation where their preconditions no longer hold. Do not expose unrestricted `setScenario` through the installed UI.

## Tests and release evidence

Linux tests must use actual separate service/broker fixture processes for authentication, framing directions, partial/coalesced messages, startup timeout, incorrect caller/extension/tab/origin/generation, used/expired capabilities, second-channel rejection, byte bounds and broken pipes. Test actual installer output in private temporary roots, conflicting manifest refusal, quoted executable paths, doctor read-only behavior, narrow removal, lease conflict/recovery, Chrome Singleton rejection, and retention after incomplete cleanup. Existing compiled-extension tests exercise the popup/background enrollment adapter using fake Chrome APIs and confirm no page receives the enrollment value.

Test channel loss before preparation, after preparation, after commit/possible mutation, and after verified completion; assert no replay and no second effect. Test persisted provider restoration, failed/missing state, confirmed pause resume, and blocked old-tab handoff recovery. Existing grant, authority, synthetic policy, encrypted-storage and production-boundary tests remain authoritative; no live-origin default is broadened. Run focused tests during implementation, then the repository final verification gates and independent Sol-high/Astra-high review on the final tree.

Owner-laptop acceptance must separately prove real Chrome extension loading, native host launch/argv, exact tab enrollment, navigation/document fencing, synthetic human takeover/resume, one real-page synthetic booking plus authoritative readback, clean browser close, and at least a native-host failure and explicit rerun. Record commit/bundle versions and fixed redacted outcomes, not screenshots, browser profile exports, tokens, or raw page/IPC dumps. Linux fake-Chrome tests are not evidence that this passed. Keychain, signing, real portal compatibility, and live readiness remain untested and unavailable.

## Alternatives and outstanding review decisions

| Choice | Reason |
| --- | --- |
| Private Unix socket, instead of additional HTTP/WebSocket browser transport | Keeps IPC local/private and preserves existing framed native transport without a second web authentication surface. |
| Pre-HTTP enrollment in the existing factory | Avoids a new dynamic composition lifecycle. The terminal/private bootstrap supports the only owner action needed before the service UI is ready. |
| One channel per run, fail-stop on loss | Smallest lifecycle that does not introduce replay/reconnect authority. Hot reconnect and old-tab retirement recovery can be separately designed later if real use requires them. |
| Explicit owner enrollment plus owned profile launch | Practical within the current trusted-local synthetic boundary. Native messaging alone does not attest the actual Chrome profile directory. |
| Thin synthetic lease wrapper over current custody helpers | Reuses existing hard-won custody/recovery behavior without constructing a fake private account or relaxing the synthetic composition guard. |

The proposal is sufficiently concrete to review, but **three items still need reviewer acceptance before it becomes an implementation plan**: (1) the stated profile-binding limitation is acceptable only for this synthetic milestone; (2) the thin lease wrapper cannot consume a private-connection custody history and preserves all cleanup/recovery invariants; and (3) stopping an unresolved old-tab handoff is an acceptable v1 limitation, with no implicit allowance reset. These are explicit tradeoffs, not claims already validated by execution.

No owner input is needed to review or build this synthetic proposal. Actual local installation/loading/pairing and laptop acceptance occur when the reviewed runnable result exists. This document grants no installation, repository publication, or live-account authority.

Usage ledger: architecture design; `gpt-6-astra`; max; concrete bounded addendum from existing source; zero retries; proposal saved, implementation and verification not performed.
