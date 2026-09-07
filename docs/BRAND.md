# Behalvo

**An agent that acts on your behalf.**

Selected by the project owner on September 7, 2026. Behalvo replaces the working
project name Personal Operator; it does not change the approved architecture.

## Naming conventions

- Brand and project: **Behalvo**.
- Package, source directory and intended repository slug: `behalvo`.
- Suggested pronunciation: **bee-HAL-voh**.
- Project/runtime brand and individual agent name are distinct. An agent can be
  called Jarvis, Friday, or another owner-chosen name. Per-instance display-name
  configuration is a future UI feature, not a feature added by this rename.
- Behalvo Runtime and Behalvo Cloud are possible future product names, not claims
  that a hosted service or separately published packages already exist.

The name is inspired by **on your behalf**. It represents delegated action with
explicit authority, durable state, and traceable outcomes. It is not limited to
personal administration, business reception, email, or any single model provider.

Documentation stays English-first. Chinese companion documents are supplementary.

## Compatibility

This is a naming and configuration-alias patch, version 0.2.1.

`BEHALVO_DB`, `BEHALVO_PI_AUTH`, `BEHALVO_WORKSPACE`, `BEHALVO_OWNER` and
`BEHALVO_MODEL` are the preferred environment variable names. Existing `OPERATOR_*`
equivalents remain valid. Explicit command-line flags have priority, followed by
the corresponding new variable, legacy variable and existing default.

Defaults remain `data/agent.db`, `data/pi-auth.json`, workspace `personal`, and
owner `owner`. The exported `Operator` class, command syntax, stored journal records,
workspace IDs, credential formats and database schema are unchanged. Existing
history is not rewritten to reflect the new brand. When moving a checkout, preserve
its local `data/` directory or use an explicit database/auth path.

## Publication boundaries

Choosing this name is not domain registration, npm publication, repository creation,
or trademark clearance. No availability or legal clearance is asserted here.
The intended repository slug is a plan, not evidence of a GitHub repository.

The open-source direction remains unchanged, but no public license has been
selected. `private: true` and `UNLICENSED` remain in package metadata pending
an explicit license decision. See [LICENSE-DECISION.md](../LICENSE-DECISION.md).
