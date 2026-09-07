# Behalvo naming patch — verification

Date: September 7, 2026. Version: 0.2.1.
Branch: `chore/behalvo-brand`.
Base: MVP v0.2.0, commit `a166c0d5f4b259bbcf87b64180aa51de70d074f9`.

## Change boundary

The owner selected Behalvo as the project brand. This patch updates package and
lockfile metadata, CLI display text, the model's project-name string, demo/test
temporary-directory prefixes, and English-first documentation. It also adds
`BEHALVO_*` environment variable aliases while retaining `OPERATOR_*` compatibility.

No database schema, domain reducer, Journal record format, workspace/owner default,
credential format, public `Operator` export, model transport, permission rule or
external effect behavior has changed. It does not register a domain, publish npm
packages, create a GitHub repository, select a public license, or assert trademark
clearance.

## Environment and install limitation

Linux, Node.js 22.16.0, npm 10.9.2. The build used the exact locked development
versions: TypeScript 5.8.3, `@types/node` 22.19.7 and `undici-types` 6.21.0.
These were linked from preinstalled copies outside the checkout and are excluded
from the source archive. Neither source nor lockfile was altered to substitute
those dependencies.

`npm ci --offline` failed because the packages were not in the npm cache.
A registry-backed `npm ci` attempt failed with a DNS `EAI_AGAIN` error. Therefore,
a fresh npm installation from the public registry was **not** verified here.
Node emitted its SQLite experimental warning; the warning was not suppressed.

## Red/green verification

The unmodified v0.2.0 baseline passed all 62 tests with the matching toolchain.

Before changing production code, six configuration/metadata tests were added,
and the existing CLI and model-system-name assertions were changed to expect
Behalvo. The targeted run produced **5 failures and 5 passes**: the failures were
specifically the old package name, old CLI/model name, and absent `BEHALVO_*`
configuration support. Legacy variables, explicit flags and defaults already passed.

After implementation, the full check produced:

```text
68 tests
68 passed
0 failed
0 skipped
```

The new tests verify consistent package/lockfile naming, all five new configuration
variables, legacy compatibility, new-name precedence, CLI-flag precedence, and
unchanged default paths and identities. Existing tests still cover kernel, memory,
restart, approval and optional model-adapter contracts.

## Commands actually run

```bash
npm run check
npm run demo
npm run mvp:demo
git diff --check
```

All passed. An actual CLI subprocess was also run with `BEHALVO_DB` pointing to a
fresh synthetic database, using `/model`, `/new brand-test`, an offline message,
`/history 8` and `/quit`. It printed the Behalvo banner and persisted Journal records.

## Cross-version database check

Before modifying production code, the original v0.2.0 build created a synthetic
MVP database with durable work, facts, raw messages and a Journal. Its complete
state and Journal were saved as a comparison fixture outside the project.

The renamed v0.2.1 build opened that same database. Deep equality checks confirmed
that both current state and all Journal records were identical. Reading the prior
owner message returned the original raw text unchanged. No migration or historical
record rewrite was required.

## Still unverified or out of scope

Live Pi installation, ChatGPT/Codex OAuth and real model inference remain unverified
in this environment. The project still has no real email/IM/phone integration,
production hosting, automatic historical compaction or public security review.
Tests using a fake model prove runtime behavior, not live model quality.
No remote GitHub CI run or publication is claimed by this report.
