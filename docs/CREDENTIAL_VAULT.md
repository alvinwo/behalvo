# Local credential vault

Behalvo can store website logins in a separate encrypted file and request hidden
input when a supported browser needs a login. The model receives a control
reference and a fixed outcome, never a username, password or credential ID.
The current browser integration is **synthetic only**. It does not sign in to
H-1B portals or arbitrary live websites.

## Lessons adopted

[OpenClaw's secrets tools](https://docs.openclaw.ai/tools/secrets) separate model
requests from trusted owner input and limit secret use to allowed hosts. Its
[runtime model](https://docs.openclaw.ai/gateway/secrets/runtime-model) keeps
references in agent context and resolves values near the destination.
[Hermes's credential vault](https://hermes-agent.nousresearch.com/docs/user-guide/features/credential-vault)
uses private input, encrypted custody and origin-bound browser filling.

Behalvo adopts those boundaries within its existing modular application:
encrypted custody, hidden capture, exact origin matching, late value access and
fresh owner confirmation. Passwords are not task memories. We reuse the private
encrypted-file implementation already used for optional Pi credential protection;
no external vault, vector service or additional runtime agent is introduced.

## Set up once on POSIX

Use Node.js 22.19+ and an interactive terminal. Create private directories outside
the checkout and cloud-sync locations, then generate an independent vault key:

```bash
install -d -m 700 "$HOME/.local/share/behalvo-private/keys" \
  "$HOME/.local/share/behalvo-private/state"
npm run storage -- keygen \
  --out "$HOME/.local/share/behalvo-private/keys/vault.behalvo-key"
npm run agent -- \
  --vault "$HOME/.local/share/behalvo-private/state/logins.vault" \
  --vault-key-file "$HOME/.local/share/behalvo-private/keys/vault.behalvo-key"
```

Both flags are required together. They accept paths, never passwords or inline key
values. Keep the vault key distinct from database and model-state key files.
This option does not change the existing database, Pi OAuth credentials or model
selection. Their encryption remains independently configured.

Run `/vault init` and confirm creation. It creates and unlocks a new encrypted
vault, refusing to replace an existing one. Subsequent processes start locked:
run `/vault unlock` to load the existing file. Unlock reads the configured key file;
it does not add a master-password prompt. A missing file does not silently recreate
the vault. Windows is not supported by this private-file capability.

## Manage logins

| Command | Behavior |
| --- | --- |
| `/vault` or `/vault list` | Show ID, label, exact origin and revision in the current workspace/owner scope |
| `/vault add` | Ask for HTTPS origin and label, then hidden username and password |
| `/vault replace <id>` | Replace values and label at the same origin, invalidating the old revision |
| `/vault remove <id>` | Confirm removal, retaining a value-free tombstone |
| `/vault lock` | End current local access and discard owned key/secret buffers |
| `/vault unlock` | Reopen the existing encrypted vault |

An origin looks like `https://accounts.example.com`: no path, trailing slash,
wildcard, username, query or fragment. Subdomains and nondefault ports are distinct.
Use a nonsensitive label; labels appear in trusted terminal prompts. Never put
passwords in chat, command arguments, task teachings or environment variables.
Inline values on `/vault` commands and multiline `/vault` input are refused before
chat ingestion. Hidden prompt state and queued lines are discarded when the
private interaction ends. Ctrl+C, EOF or expiry cancels it.

Entries bind workspace and local owner ID. This is local isolation, not remote
authentication against another process running as your user. The vault holds up
to 128 entries including removed tombstones, with 1024-byte usernames and
16384-byte passwords (UTF-8). No pruning or export command is shipped.

## Exercise the synthetic browser

Install the pinned Chromium build if it is not already available:

```bash
npx playwright install chromium
npm run agent -- --synthetic-browser login \
  --vault "$HOME/.local/share/behalvo-private/state/logins.vault" \
  --vault-key-file "$HOME/.local/share/behalvo-private/keys/vault.behalvo-key"
```

Unlock the vault, select your configured model if necessary, and ask:

```text
Sign in to the synthetic account and tell me whether the login succeeded.
```

When the model requests the observed login control, Behalvo asks whether to save
and use a login for `http://127.0.0.1:43118`. Use any nonsensitive label and these
**fake fixture values** in the hidden prompts:

- Username: `behalvo-demo`
- Password: `synthetic-only-password`

The compiled fixture is the sole HTTP exception; startup refuses an occupied
port. `/vault add` cannot authorize arbitrary HTTP origins. For a saved entry,
Behalvo asks again before each attempt. If several accounts match, choose one in
the terminal. Piped/headless input and a locked vault cannot provide credentials.
The model cannot choose an account ID or supply values.

Use binds to the current task revision, run, observed document, origin, entry
revision and deadline. Behalvo rechecks the form and the one-use request before
dispatch. The disposable browser closes before borrowed credentials are released,
and the run accepts only a final model answer afterwards. Unknown results never
trigger automatic retry. A new run requires another owner confirmation; no
persistent authenticated session is created.

The scripted acceptance suite uses only synthetic credentials:

```bash
npm run build
BEHALVO_VAULT_ACCEPTANCE=1 node --test tests/vault-browser-acceptance.test.mjs
```

## Custody and limits

The entire vault payload, including labels and origins, uses authenticated
AES-256-GCM with a vault-specific derived key. Updates use the existing private,
exclusive file lock and atomic publication. Unsafe modes, links, wrong keys,
corruption, plaintext and configuration path collisions fail closed. There is
no plaintext fallback or automatic migration. Existing Pi file formats remain
compatible with the refactored shared storage implementation.

Vault writes are operational credential custody, outside the domain journal.
Model prompts, journal artifacts and task replay contain only sanitized browser
observations. Replay never reads or unlocks the vault. A borrow holds the file
lock through browser closure; remove/replace commit only after earlier borrows
finish. Same-process lock/remove/replace requests cancel active borrows. Revocation
cannot recall a request already dispatched.

The key file is protected by filesystem permissions, not a hardware keystore.
Keep separate protected backups of the encrypted vault and its key; losing the
key loses access. Old backups may retain removed passwords. Same-UID code, root,
the running process and trusted path ancestors are in the trust boundary. Owned
byte buffers are cleared, but JavaScript strings, browser internals, swap and
crash dumps cannot be securely erased. There is no rollback detection, key
rotation, coordinated backup, secure deletion, external-manager integration,
TOTP, unattended login or production credential-security claim.

The preexisting native Keychain transport remains a separate contract; no signed
helper is installed or added by this feature. Live website login needs a
separately reviewed browser adapter and acceptance evidence.
