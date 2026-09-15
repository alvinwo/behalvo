# Recovery

Classify the interruption before acting:

- **Environment unavailable before a command started:** restore or replace the
  environment, then verify the workspace and resume the command once.
- **Stale agent or abandoned work:** inspect current agents before replacing one.
  Stop or reuse the stale worker as appropriate, and avoid concurrent writers to
  the same worktree.
- **Test or command failure:** preserve the failing output, diagnose the cause,
  and make a focused tested fix. Do not relabel a real failure as infrastructure.

Before resuming, confirm the expected workspace path, repository root, branch,
HEAD, working-tree diff, and currently active agents. Compare these with the last
recorded checkpoint and re-read any partial verification `summary.json`; only a
terminal `passed` result is a pass.

Determine whether any external write actually started. A missing response,
timeout, or stale agent does not prove failure. Inspect provider or remote state
through a read-only path when available, and ask the owner when the outcome remains
unknown. Never retry an external write blindly. Resume local reversible work from
the first unverified step and record the evidence used.
