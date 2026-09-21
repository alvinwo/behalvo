# Development model-routing policy

This policy conserves development-model capacity while preserving review quality. It governs optional task delegation by contributors and coding agents; it does **not** configure the Behalvo runtime, load automatically in an agent harness, enforce quotas, alter the primary chat's effort, or select Pi provider models.

Read [the declarative configuration](../.agents/model-usage.json) before selecting a delegated model. The account's actual spawn tool is the source of truth for available capabilities. The IDs in that file are advertised orchestration-tool IDs, not a guarantee that they appear in Behalvo's or Pi's model catalog. Each spawn must explicitly set `model`, `reasoning_effort`, and `fork_turns: "none"` and use a compact file-based brief that preserves checkpoints and failure evidence. If the tool exposes a speed tier, use standard speed; do not choose premium or fast only to save wall time without user authorization. Tool capability overrides this policy when they conflict.

If a named model is unavailable, choose the next **suitable** advertised capability in this order: Luna → Terra → Sol → Astra. Do not go below the role or risk floor. Preserve the role's effort when supported; otherwise choose a supported effort at or above the requirement, or mark the task blocked. Carry the brief, checkpoints, and failure evidence forward, and record every substitution or capability gap. Do not choose by guessed quota, use a paid fallback, or add a new provider. Tool availability never waives an explicit user model constraint; record an incompatible constraint as a gap.


## Defaults

| Work | Model and effort | Use |
| --- | --- | --- |
| Architecture or planning | `gpt-6-astra`, max | Only genuine design decisions; routine work gets no extra planner. |
| Research | `gpt-5.6-sol`, medium | Raise to high for conflicting sources or high-impact synthesis. Integrating proven research is not fresh research. |
| Extraction or mechanical docs | `gpt-5.6-luna`, medium | Bounded source work. |
| Routine execution | `gpt-5.6-terra`, medium | Straightforward implementation. |
| Complex implementation or debugging | `gpt-5.6-sol`, high | Difficult execution. |
| Hard escalation | `gpt-6-astra`, high | Security, concurrency, architecture, or difficult debugging; max only for a redesign. |
| Task review | `gpt-5.6-sol`, high | A narrow mechanical review may use `gpt-5.6-terra`, high. |
| Typo or source extraction | `gpt-5.6-luna`, medium | Bounded mechanical correction. |
| Well-specified component | `gpt-5.6-terra`, medium | Routine component implementation. |
| Queue, encryption, or concurrency | `gpt-5.6-sol`, high | Escalate to Astra for design or high-risk final review. |

Tool-only work runs directly; do not use an agent solely for git or tests. Small changes need no additional planning or research agent. One person or agent writes an implementation. Use at most two concurrent specialist agents by default, at most one advanced planner, and work sequentially when tasks depend on one another. Specific user constraints take precedence.

## Review, escalation, and quota limits

Use one final pair of independent review contexts per PR; the implementer cannot supply an independent gate or self-certify review. Routine or low-risk PRs use Terra high plus Sol high. They require two distinct suitable models, high effort, and two independent non-implementer contexts. If Terra is unavailable, Sol high plus Astra high may satisfy the routine pair when both are available; if two distinct suitable models or the required effort are unavailable, leave the gate pending and do not merge. High-risk work—security, concurrency, architecture, storage migration, unknown external effects, or similarly high-impact changes—uses Sol high plus Astra high. The high-risk rule overrides the routine pair. If Astra is unavailable for high-risk work, the gate stays pending and the change cannot merge; do not downgrade. Re-review only changed findings; repeat a full review or test suite only when evidence gives a reason.

After two evidence-backed unsuccessful fixes of the same diagnosed problem with no progress, escalate through the same suitable available capability order: Luna → Terra → Sol → Astra. At Astra, narrow or reconsider the evidence and checkpoint for the unresolved issue; do not endlessly respawn. Expected TDD RED results and routine test iterations do not count, and a long task alone does not trigger escalation. Begin advanced work immediately for trust, cryptography, migrations, or unknown-effect problems. Diagnose an infrastructure failure once and resume; do not hop models. If a required advanced reviewer is unavailable or quota-restricted, safe lower-risk work may continue, but record the missing review as pending and do not claim the gate passed or merge. Do not automatically downgrade security review.

There is no live quota telemetry, automatic main-chat effort switching, paid API fallback, credit purchase, global quota, or guessed model-cost budget. When quota pressure is explicitly reported or observed, reduce optional parallelism and fresh research, batch routine work, and preserve required tests and reviews. Unknown quota remains unknown.

At task end, record only actual usage in a minimal ledger: role, model, effort, reason, retries, and result. Do not invent usage.

## Sources

The role guidance follows OpenAI's model descriptions: [Models](https://learn.chatgpt.com/docs/models) describes Astra for hardest end-to-end work, Sol for complex/open-ended work and research, Terra for everyday tasks, and Luna for clear extraction/classification. [Pricing](https://learn.chatgpt.com/docs/pricing) notes that actual consumption varies and that smaller models and shorter context can help. Sources reviewed 2026-09-21.
