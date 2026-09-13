# Bounded operation agent and reliable local setup

Owner approved this increment in the conversation: memory correctness, normal installation, and a bounded model loop connected to prepared operations. Later milestones remain background scheduling, real connectors with protected credentials, and isolated browser execution.

## Design

Keep the modular monolith and provider-neutral model gateway. Use structured JSON tool requests interpreted by application code; do not add a general shell or arbitrary function execution. A turn may request one tool at a time or return the existing final reply/fact/work proposal envelope. The runtime scopes every request to the trusted workspace, owner and focused work. Available tools list connections/registered operations, prepare an operation, inspect an action, execute an already approved action, and verify readback. No model tool can approve, attest, register credentials or change account bindings.

Approvals come only from a separate `/approve <action-id> <digest>` terminal command after `/actions` displays the exact prepared command. Approval expires after ten minutes. Preparing a new action stops the loop with an application-generated approval request. An unknown/failed outcome or unsuccessful verification stops it; no replacement action or retry is attempted in that run. Each run permits at most eight model completions and a 120-second deadline; timeout must prevent later dispatch even if a provider ignores cancellation. Limit serialized request/response sizes; no guessed dollar-cost claims. Existing operation journal state is authoritative across restarts; the inference run itself is disposable and is not automatically resumed.

Ship an opt-in synthetic operation environment for terminal dogfooding with unmistakable labels and separate storage. Persist synthetic provider state so readback after restart reflects earlier synthetic actions. No real accounts, recipients or writes. Default mode can expose an empty operation catalog.

For memory, distinguish when the application learned a fact (runtime timestamp and source record) from when it became true (nullable validFrom). Unknown onset must not become the current time or a fabricated date. Preserve replay of legacy facts with timestamps. Model-supplied dates require conservative source grounding; never silently backdate ordinary preference statements. Context must render unknown validity honestly and retain current observations across threads.

Install the previously inspected Pi 0.85.1 adapter as a pinned dependency through npm ci, with a matching supported Node floor and CI matrix. Keep login explicit, keep secrets out of model context, provide actionable startup guidance, and persist selected provider/model without credentials. Do not select an arbitrary model for the user.

## Alternatives

A generic unrestricted tool loop would be faster to expose but bypasses operation contracts. A background worker now would combine scheduling, retry ownership and credential security before the terminal workflow works. This increment instead exercises the existing controlled action boundary end to end.

## Verification

Use synthetic behavior tests first. Cover unknown fact onset and replay, ordinary fresh install, model selection persistence, no implicit approval, tool argument validation and workspace/work isolation, loop limits, timeout late-completion suppression, unknown outcomes, restart readback and no repeated effect dispatch. Run npm run check, all three existing demos and diff checks. Review each task and whole branch using two models before publishing/merging under prior owner authorization.

## Design review decisions

Cancellation reaches OperationService through a trusted execution context, separate from model input. Check elapsed time and cancellation after each preflight await and immediately before dispatch. A dispatched attempt whose result is unavailable at deadline becomes unknown; consume and discard late results without subsequent store writes. No automatic exclusive-maintenance recovery on startup.

Every action tool requires the current action's workId to match trusted focused work. Strict disjoint tool/final envelopes reject model-supplied authority fields. Catalog entries provide trusted resource IDs and argument descriptions. Cap accumulated prompts, not just individual results. Stops for approval, uncertainty, invalid protocol and limits generate durable application-authored replies and finish the owner inbox item.

Synthetic provider truth and resource versions persist independently of journal replay and are workspace-scoped. Reopening retains matching connection generations, never reactivates revoked connections, and rejects corrupt/missing state where reseeding would erase previous outcomes. `/approve` requires `/actions` to have displayed that same action ID/digest in the current terminal; output escapes control characters.
