# Local owner control

The local owner-control console is a synthetic-only, loopback review surface. It
records an owner approval or cancellation for an exact prepared action. Approval
does **not** execute an operation or resume model inference.

These owner-control commands currently require a POSIX platform and deliberately
refuse Windows because their process-lock and bootstrap-file controls depend on
POSIX filesystem semantics. This is a feature-level requirement; it does not
change the package-wide Node.js platform declaration.

```bash
npm run owner-control -- init-demo --db data/owner-control-demo.db
npm run owner-control -- serve --db data/owner-control-demo.db --bootstrap-dir data/control-bootstrap
```

The server prints its `http://127.0.0.1:<port>` origin and a JSON-quoted path to
one short-lived `.behalvo-bootstrap` pairing file. Open that origin locally,
select that exact pairing file, then review the complete command, digest, work
revisions, connection metadata and absolute expiry before choosing **Approve**
or **Cancel**. The pairing document expires after five minutes and is consumed on
exchange. Reloading the page, losing the pairing file, losing the bootstrap
exchange response, or allowing the file to expire requires a server restart to
issue a new pairing file. There is no re-pair endpoint.

The paired session expires after fifteen minutes of inactivity and has a one-hour
absolute lifetime. An authenticated request extends the idle deadline only up to
that absolute deadline. Sign-out clears browser authority and review state, while
already recorded approvals remain durable across logout and restart.

Use **Refresh** after an expired, replaced, conflicting, or unconfirmed result.
A post-commit server failure can leave a decision recorded even when its response
is lost; the console does not retry a mutation automatically. A review receipt
lasts two minutes and can be used once. For a newly approvable action, the
displayed approval deadline is fixed at ten minutes after the review was issued,
not ten minutes after the approval click. An existing approval shows its existing
deadline. This API cannot renew an expired approval; cancel it if it remains
eligible and prepare a replacement separately. Cancellation only cancels a
proposed or approved prepared action. It cannot settle a running or unknown effect
and does not itself execute a subscription change.

Stop the server with `Ctrl-C` or `SIGTERM`; it closes the listener and removes its
owned pairing file. A stale `.behalvo-lock` after an unclean stop may be removed
only after every Behalvo process using that database has stopped and the operator
has confirmed exclusive maintenance. Removing it does not prove an operation did
not run.

```bash
npm run owner-control:demo
```

The demo initializes a fresh temporary fixture, crosses the real local HTTP
boundary, approves one synthetic contact update, rejects its replay, cancels one
synthetic subscription action, then separately executes and verifies only the
approved synthetic action after the console closes.

This listener is intentionally bound only to `127.0.0.1`. It does not establish
remote/mobile identity, phone connectivity, production privacy, real-provider
access, model login, chat, or an execution endpoint. Responsive layout supports
local desktop and narrow (390 px) browser views, but it is not a claim of mobile
or remote authentication.

The process-lock and bootstrap files require a trusted filesystem environment.
Trusted ancestors are an operator precondition; only the immediate controlled
directory and file identities are checked. Replacing a trusted ancestor can defeat
the canonical-path, process-lock, and bootstrap-file ownership assumptions because
the implementation does not validate the full ancestor chain. Existing agent data
directories must already meet the enforced private immediate-parent policy;
directories are never silently chmodded. A plaintext SQLite database may remain
mode `0644` when its immediate parent is private (owner-only, writable and
traversable); persistent synthetic provider data is still plaintext.
