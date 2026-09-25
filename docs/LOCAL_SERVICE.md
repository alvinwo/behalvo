# Local foreground service

The shipped service is a trusted, loopback-only foreground process for one local
owner and workspace. It provides durable chat and reminders, action review,
approval, explicit execution/readback, and status. It is awake-only: closing the
terminal, sleeping the laptop, or stopping the process stops polling and work.

## Run the supported service

Use Node.js 22.19 or newer on POSIX. Create private directories outside Git and
configured sync or backup roots, then initialize or upgrade the database:

```bash
npm ci
install -d -m 700 "$HOME/.local/share/behalvo-private/service" \
  "$HOME/.local/share/behalvo-private/bootstrap"
npm run service -- run \
  --db "$HOME/.local/share/behalvo-private/service/behalvo.db" \
  --bootstrap-dir "$HOME/.local/share/behalvo-private/bootstrap" \
  --workspace personal --owner owner --offline --upgrade-storage
```

The process prints a loopback URL and the path to a short-lived, owner-only
bootstrap file. Open the URL locally and pair once with that file. Pairing creates
an in-memory bearer session; it is not remote authentication. Stop with SIGINT or
SIGTERM and wait for clean shutdown.

`--storage-key-file` enables the separate SQLite payload-encryption boundary.
Model credentials/settings use their own optional `--model-state-key-file`. Read
[PRIVATE_STORAGE.md](PRIVATE_STORAGE.md) before selecting paths or backups.

## Synthetic monitored-action acceptance

```bash
npm run service:demo
```

This command creates an owner-private temporary encrypted database and removes
that temporary directory on success or failure. It also creates a fixed-origin
synthetic scheduling portal, compiled manifest-selected extension
content/background code, and framed native transport. It pairs through real
loopback HTTP and demonstrates
empty polling, overdue restart, challenge handoff, explicit fresh-page resume, a
pre-reservation candidate disappearance, one later synthetic booking, exact
readback, stopped recurrence, and effect-free rebuild. It uses no credentials,
Keychain, installed Chrome, real portal, or network provider.

Library callers that need to retain synthetic evidence may pass
`runServiceDemo({ rootDirectory })`. That exact directory must already exist, be
empty, owned by the current user, owner-only, and not a symlink. The demo never
changes its permissions or removes it; supplied directories and generated demo
artifacts remain caller-owned after success or failure.

The ordinary service CLI does not expose the synthetic visa composition and does
not install a browser extension, native host, signed helper, profile, launch
agent, or OS supervisor. There is therefore no supported live visa install or
activation command in this revision.

## Handoff, recovery, and revocation

- A challenge or session checkpoint durably pauses the monitor before browser
  ownership transfers to the human. Resume is an authenticated owner command and
  queues a fresh read-only identity, roster, terms, and appointment-absence check.
- A failed or ambiguous handoff remains paused. Exact epoch reconciliation is an
  explicit recovery choice; it never silently resumes.
- A submission without authoritative confirmation is `unknown`. It retains its
  allowance and enters verification-only recovery. Do not submit again merely
  because readback is empty.
- Pause stops polling without consuming the grant. Stop/revoke terminalizes the
  monitor and grant. Disconnect additionally fences the exact connection
  generation, browser session, secret broker, grants, monitors, and jobs.
- Exclusive maintenance recovery requires every service worker to be stopped:

```bash
npm run service -- recover \
  --db /absolute/path/behalvo.db --workspace personal \
  --exclusive-maintenance --storage-key-file /absolute/path/storage.behalvo-key
```

The database, storage key, model-state key, credential files, dedicated browser
profile, profile custody directory, and native helper state have separate custody
and backup rules. Keep them out of Git, cloud-sync roots, support-export folders,
and general workstation backups unless the backup design explicitly protects and
coordinates every component. Profile removal is a separate manual follow-up and
the service never recursively deletes the profile.

## Removal

Stop the foreground process first. Remove the local package checkout only after
retaining any database or evidence you need. Delete service data, bootstrap files,
keys, credentials, and any future dedicated browser profile as separate explicit
operations. This revision has no installer or uninstaller and makes no secure
erasure claim.
