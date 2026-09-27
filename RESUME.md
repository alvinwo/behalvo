# Behalvo laptop handoff — 2026-09-27

## Start here

Repository: `alvinwo/behalvo`. Resume branch: `feat/installed-chrome-bridge`.
Read this file before relying on older checkpoints. This is project navigation and
recovery evidence, not a live booking grant. Do not copy cloud scratch paths into
laptop commands.

**Recovery gap:** the filesystem available to the synchronization session stopped
at `d0b1ec4`, although the supplied archived conversation reported later commits.
The later objects were absent from both available Behalvo object databases; the
installer SHA was also unavailable from GitHub. The remote branch did not yet
exist. The cause of the discrepancy is unverified. This handoff publishes the
surviving code/design plus these explicit recovery notes; it does not recreate
missing implementation or certify its reported tests.

## Goal and owner direction

- Build a personal agent that can schedule a US visa appointment, eventually on
  the owner's laptop with supervised live-portal discovery and bounded authority.
- Continue through implementation, PR review, and subsequent milestones. The
  owner approved PR #11 publication/merge and said to continue toward the goal.
- After design review, the owner said "go": revise the design, plan smaller
  increments, and implement. Routine continuation does not need another approval.
- Commit each meaningful verified change. Preserve a tracked checkpoint and
  publish authorized checkpoints so a new session can resume without chat history.
- Latest request: synchronize progress, workflow, and project memory for laptop
  resumption. This synchronization is a handoff, not another implementation run.
- Real account access, payments, challenges, and exact live-grant activation remain
  separate from synthetic development authorization. Never infer a live grant
  from this summary; consult the approved domain policy and owner controls.

## Available versus reported progress

| Item | Evidence and status |
| --- | --- |
| Monitored action service / synthetic visa acceptance | PR #11 merged as `09b99e6b9464b0765a7fa1bc517c34ea47cce405`; code available locally and on GitHub. |
| PR #11 verification | Existing tracked evidence records independent Sol/Astra passes and Node 22.19 / 24 CI before and after merge, 1,049 passed and zero failed per hosted job. Not rerun during this docs-only sync. |
| Initial Chrome bridge design | Available in commit `9491587`; postmerge checkpoint available in `d0b1ec4`. |
| Revised design and three-task M1 plan | Archived conversation reports `8146aca`. Object and plan file unavailable in this checkout. |
| Task 1: explicit extension enrollment | Reported `2ef4802`, 41 focused passes, full verify 1,055 passes; subsequent strict status-field type fix `4fb957b`, eight enrollment tests, review completed. Code/review artifacts unavailable here: reported, not verified. |
| Task 2: installer and synthetic profile custody | Reported `76f15b2`, six installer tests and combined regressions passed; unknown empty directory removal regression fixed. Independent review was pending when the prior work stopped. Code/review artifacts unavailable here. |
| Task 3: native broker and diagnostic command | No completion reported. Pending. |
| Actual Chrome / live visa acceptance | Pending. Fake Chrome and synthetic tests are not laptop or live-portal evidence. |

## Accepted design direction to preserve

The surviving [design](docs/superpowers/specs/2026-09-25-installed-chrome-bridge-design.md)
predates the owner's approved revisions. Do not implement its entire broad scope
as one milestone or interpret its old approval-pending language as a new pause.
The archived review and follow-up narrowed the work as follows:

1. M1 proves installation and one real Chrome diagnostic round trip. It grants no
   booking/page-command authority. M2 adds complete synthetic booking with human
   pause/resume; M3 demonstrates failure and restart recovery.
2. Register the native host inside the exact dedicated Chrome user-data directory;
   setup and read-only doctor must agree on that location.
3. Explicit popup enrollment replaces automatic native connection. Use separate
   disconnected/enrolling/enrolled/invalidated states and distinct enrollment
   messages. Only the extension's own popup initiates enrollment. Background
   selects exactly one allowed non-incognito synthetic tab via Chrome APIs; pages
   cannot supply tab IDs, URLs, tokens, or browser commands.
4. Keep a single local service as booking authority; the native broker only relays.
   Pairing, exact profile custody, strict bounded framing, fixed safe errors, and
   explicit cleanup remain required. Reuse existing custody primitives.
5. Setup refuses conflicting files; doctor does not mutate; removal retains the
   profile and unknown files AND unknown empty directories. Quote executable paths
   correctly and test the actual separate-process launcher.
6. Never automatically retry an uncertain submission. Recovery must preserve
   booking evidence. The old-tab blocked-handoff limitation needs a defined later
   recovery path; diagnostic M1 does not solve it.

The reported M1 plan had three sequential implementation tasks: (1) explicit
extension enrollment; (2) installation and profile ownership; (3) native broker
and diagnostic command. Original missing plan path:
`docs/superpowers/plans/2026-09-27-installed-chrome-bridge-m1.md`.

## Workflow and project memory

Read [AGENTS.md](AGENTS.md), [README.md](README.md), [SECURITY.md](SECURITY.md),
the [development skill](.agents/skills/behalvo-development/SKILL.md), its
[recovery](.agents/skills/behalvo-development/references/recovery.md) and
[review/release](.agents/skills/behalvo-development/references/review-release.md)
references, [model policy](docs/MODEL_USAGE.md), and
[routing configuration](.agents/model-usage.json).

- Use a feature branch and one implementation writer. The selected implementation
  workflow is subagent-driven, with sequential dependent tasks and focused task
  review. No additional planner is needed for mechanical synchronization.
- For delegated work, use explicit available model/effort and a compact file-based
  brief, `fork_turns: "none"`; follow repository availability/risk-floor rules.
  Complex implementation: Sol high; architectural decisions: Astra max.
- Behavior changes need observed failing tests before implementation, focused
  regressions, a meaningful commit, and independent task review. Fix and re-review
  only supported changed findings. Do not repeat broad reviews without a reason.
- High-risk final PR review requires independent Sol high and Astra high contexts;
  the implementer cannot self-certify. Missing reviewers leave the gate pending.
- Final implementation gate: `npm run verify` on POSIX, terminal summary and raw
  logs, exact HEAD/tree, then hosted Node 22.19 / Node 24 CI before merge. A docs-only
  checkpoint uses link and diff checks. Record only checks actually performed.
- Synthetic data only; deterministic journal reduction; no effects during replay;
  unknown outcome never becomes permission to retry. Credentials stay local.
- End each meaningful increment with commit SHA, evidence paths, review status,
  unresolved gates, and exact next action. A local commit alone is not a remote
  backup. Verify the remote tree after publication; never force-push over history.
- Earlier command-line Git lacked write credentials. Connected GitHub Git-data
  tools provided publication with preserved ancestry and exact tree comparison.
  On the laptop, prefer normal authenticated Git when available.

## Resume on the laptop

For a fresh clone:

```bash
git clone --branch feat/installed-chrome-bridge https://github.com/alvinwo/behalvo.git
cd behalvo
git status --short --branch
git log -5 --oneline
```

For an existing checkout, first inspect status and preserve local changes. Fetch
the branch, then create a separate worktree from its remote tip if another branch
or local changes are active. Do not reset or overwrite a newer local branch.

**First next action: recover missing work before reimplementation.** Check the
laptop/archived session for `8146aca`, `2ef4802`, `4fb957b`, and `76f15b2`, the M1
plan, tests, and reviewer report. If present, compare trees and preserve both
histories before integrating. Continue Task 2 independent review, then Task 3.
Do not repeat completed reviews when their exact source and evidence are available.

If those objects/artifacts are absent everywhere accessible, reconstruct the
approved revised design and M1 plan from the decisions above, explicitly marking
them as reconstructed. Reimplement missing tasks with fresh behavior tests and
independent review; do not manufacture original commit IDs or test evidence.

Node 22.19+ is required. After recovery, use `npm ci`, `npm run build`, and the
plan's focused tests; run full verification at the final implementation gate.
Do not invent bridge CLI commands before Task 3 provides them. Laptop acceptance
must separately prove installed Chrome, extension loading, native host invocation,
and diagnostic enrollment/round trip before claiming M1 complete.

Then continue M2/M3, supervised read-only live discovery, real adapter evidence,
Keychain/signing gates as required, and exact owner activation. Do not treat the
synthetic milestone as real visa scheduling support.

## Synchronization evidence

This sync inspected local branch/status/reflog/object availability and remote
branches. It made documentation-only changes and used link/diff checks, not a new
runtime verification or independent implementation review. No subagents or live
browser/account actions were used. Publication must be checked by matching the
remote commit tree to the local checkpoint tree before reporting sync complete.
