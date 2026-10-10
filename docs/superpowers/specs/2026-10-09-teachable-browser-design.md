# Teachable browser work

Status: approved by delegated Astra/max architecture and Sol/high design review.
No runtime behavior is enabled by this document.
Date: 2026-10-09.
Base: `2a977188511e4cffa56c4b0bdbe89d9bd20dca96`.

## Product intent

The owner teaches Behalvo a goal and constraints in ordinary conversation. Behalvo
remembers those instructions and subsequent corrections, explores a website,
learns useful navigation knowledge, and uses current evidence to make progress.
The owner should not need a developer to encode each website's sequence of steps.
The H-1B appointment task is the first intended personal use case. Email, phone
integration, and a dedicated visa planning script are not prerequisites.

Learning means durable, source-linked knowledge used in later runs. It does not
mean model training, executable code generation, or a learned permission to act.
The user has delegated technical design and review decisions to specialists.

## Current implementation and gap

`AgentService` retains messages and grounded fact proposals. `buildContext` loads
current work, facts, and bounded history. These are useful foundations but do not
provide explicit task teachings or separately typed website knowledge.
`OperationLoop` supports catalog, preparation, inspection, execution, and readback.
It does not expose browser exploration tools to the model.

The current browser contract enumerates scheduling states and gestures; its DOM
reader depends on `data-behalvo-*` attributes, Beijing, and fixed fixture dates.
It proves specific synthetic execution boundaries, not general website learning.
Existing tests and adapters remain intact as regression evidence.

## Alternatives and decision

1. Extend the fixed visa adapter with more page states. Smallest immediate change,
   but it still requires code for every workflow and does not meet the intent.
2. Give the model unrestricted Playwright or generated scripts. Flexible, but
   bypasses the application's authority, evidence, and unknown-effect boundaries.
3. Add durable teachings and observational memory, plus bounded semantic browser
   tools inside the existing runtime. Recommended: the model decides the route;
   trusted code owns access, dispatch, and evidence.

Do not introduce another agent framework, vector service, distributed worker, or
runtime subagents. Preserve the modular monolith and provider-neutral kernel.

## Delivery slices

**T1 — teach, explore, remember, and prepare a recommendation.** The first coherent
implementation joins durable task teachings, source-linked learned notes, and a
model-driven browser loop against synthetic websites. It ends with a supported
recommendation or an explicit blocker, not a booking. Two structurally different
appointment sites and a non-visa browsing task demonstrate generality. No source
changes are allowed between those acceptance runs.

Ship T1 in two dependent, independently testable increments: **T1a**, durable
source-bound teachings and corrections through ordinary conversation; **T1b**,
semantic browser exploration and observational learning. T1a alone must not be
advertised as website learning. The combined live-model/visible-browser acceptance
is the T1 completion gate. Each increment has its own implementation plan and
code review; the following contracts govern both.

**T2 — supervised live exploration.** A separate reviewed increment supplies live
origin/session custody, privacy and retention, permitted request behavior, owner
login and challenge handoff, and real-site observations. It reuses T1's tools and
memory. Synthetic success cannot activate live access.

**T3 — consequential browser action and verification.** Prepare a concrete effect,
review it through trusted owner control, execute once, and inspect independent
readback. A learned recipe never supplies approval or proves success. Support
depends on the target's observable guarantees; if sufficient evidence is absent,
the agent hands the step to the owner. Unattended polling is a subsequent scope.

T1 does not finish the actual H-1B case. It removes the architectural dependency on
a hard-coded task sequence before supervised real-site work.

## Memory and provenance

Introduce two distinct journal-backed concepts rather than encoding everything as
facts or promoting summaries into instructions:

- A task teaching references an immutable owner message and exact source text,
  focused work, teaching ID/revision, and active/superseded/retracted status.
  Application code binds workspace, owner, thread and source; the model cannot
  supply those identities. Corrections explicitly supersede a prior teaching;
  unresolved contradictory instructions remain visible and require clarification.
- A learned note is derived from browser observations, scoped to work and exact
  origin, with source observation IDs, observation time, and candidate/invalidated
  status. It may describe navigation or a tentative interpretation. It is always
  untrusted evidence, never owner intent, approval, current availability, identity,
  or authoritative readback.

Owner messages persist immediately as today. Model-extracted structured meanings
are interpretations, not verbatim owner authority. Teachings preserve the source
so the agent can explain what it remembers and the owner can correct it. Merely
quoting page instructions in an owner message is not automatic endorsement of
their contents. No inferred teaching can enlarge executable capabilities.
Creating, correcting or retracting a teaching conservatively advances the focused
work revision, invalidating prior action approvals under existing freshness rules.
An ambiguous correction or retraction is a distinct clarification outcome, never
an empty change list. Preserve its exact owner source as mandatory pending context,
advance work revision, and block action preparation/approval/dispatch for that
work until a later owner-only turn explicitly resolves it. An ordinary no-change
message cannot clear the hold. Conflicting unresolved teachings use the same hold.

Capture teaching proposals in an owner-only interpretation step before browser
evidence or learned notes enter model context. Bind new sources to the current
owner record, validate exact source spans, and keep interpretations advisory.
Browser-enabled turns and any turn consuming learned notes reject nonempty legacy
`factProposals` and owner-teaching proposals from their final response. Such turns
may only propose separately typed, observation-grounded learned notes. This is an
application-enforced rule, not a prompt instruction. The owner-only step may see
prior owner teachings for correction references but never browser observations,
learned notes, tool transcripts, or assistant messages that could launder them.

Use focused-work scope for T1. Cross-thread retrieval requires an explicit link
to that work. No cross-workspace or external-audience retrieval. A future request
to reuse knowledge for another work item must not silently transfer account data.
Retraction removes a teaching from active context; it does not claim secure erasure
of the existing append-only journal.

Retrieve exact active teachings before derived notes. Pin source text and
unresolved conflicts needed for the task; fail if mandatory material exceeds the
budget. Learned notes use the remaining bounded budget and retain provenance.
No embeddings are necessary. Navigation hints are revalidated against a fresh
observation before acting; remembered element handles never survive a document.

New events reduce deterministically, with no browser/model calls on replay.
Existing databases must reopen safely: use an explicit projection upgrade/rebuild
with old-journal and encrypted-backup compatibility tests, not silent shape edits.

## Browser observation and tools

Add a separate semantic browser port; do not widen the existing synthetic visa
protocol in place. Playwright objects stay private to the adapter.

A bounded observation contains application-assigned session/document/observation
IDs, origin and sanitized location, visible text, and visible controls with opaque
references, role, accessible name, and allowed interaction shapes. Pages provide
content, not authority. No raw HTML, script execution, cookies, passwords, hidden
inputs, browser endpoints, or unrestricted DOM access enter the model contract.

Browser-enabled turns use an exploration-only capability: no `execute`, `prepare`,
or other operation-effect tool is reachable, including through legacy tool names.
The loop exposes observation, navigation to an observed link, and interaction with
an observed control (click, fill, select). The adapter resolves opaque references;
the model cannot submit selectors, scripts, arbitrary URLs, or network requests.
All references bind the exact document and observation; stale, ambiguous, hidden,
disabled, replaced, or out-of-scope controls reject before interaction.

Typing accepts a source-bound task-input reference, never arbitrary model text.
The reference binds an exact owner-supplied value, task, destination origin and
field purpose; disclosure needs that separate trusted binding. Selection accepts
only an option reference from the current observation. URLs and query fields must
not encode arbitrary model strings. Teachings alone do not authorize disclosure.
If no valid input binding exists, stop for owner input instead of transmitting
other context. No password, security answer, OTP or payment field is supported.

An element reference establishes a target, not permission to activate it. Clicking
a button, choosing a value, following GET, or typing can have remote effects.
The model and page labels cannot classify an interaction as safe. For T1, the
synthetic fixture supplies an independently reviewed request/effect policy that
permits only exploration. That policy describes reachable requests and prohibited
effects, not a sequence of steps or which option satisfies the owner's goal.
Effectful submissions, off-origin navigation, redirects, popups, downloads, and
unsupported channels are blocked before dispatch. Explicitly reviewed nonmutating
fixture search/filter forms may be permitted subject to the same input-disclosure
rules. Unknown classification stops. Runtime and browser adapters contain no
fixture-specific route planner or answer-selection branches.

No real URL parameter or persistent authenticated profile is introduced in T1.
JavaScript-driven pages and their extra network channels are not implied by this
initial exploration boundary; live support requires T2 evidence.

Reuse the owned-browser lifecycle and cancellation controls. Every async boundary
rechecks active work, session generation, document and deadline. Retain the
eight-completion/120-second per-turn limits and serialized-size limits; tool calls
and learning consume that same budget. Each interaction returns a fresh bounded
observation to avoid spending another model call solely to refresh the page.
A budget stop saves application-authored source references as a checkpoint and
waits for another owner turn; it does not request an extra model completion.
Startup never resumes effects automatically.

## Runtime integration and user experience

T1a is an application-selected, opt-in teaching capability; the model cannot
enable it and legacy callers retain their existing behavior. Within that mode,
teaching uses ordinary conversation rather than a required memory command.
The extraction step receives only the current owner text and exact active
teaching sources, IDs and revisions. Exclude legacy facts, historical transcripts,
work-goal paraphrases and assistant/browser-derived content. Its changes are
`add`, `replace` or `retract`, each with a unique verbatim quote from the current
owner text. The runtime computes source offsets. Replacement/retraction requires
the exact currently active teaching ID and revision in focused work. A model's
interpretation remains advisory; no fuzzy source matching is allowed.
Replacement creates a new immutable teaching ID linked to the superseded entry;
the old entry's lifecycle revision advances. Retraction retains its original
source and records a separate current-owner retraction source.

The first extraction consumes one of the same eight model completions and shares
the original absolute 120-second deadline with the subsequent loop. Projection
v2 requires explicit maintenance rebuild from the old journal, with no effects;
ordinary startup never silently upgrades an existing projection.
Legacy writes remain projection v1 and cannot append teaching events until the
explicit upgrade. Clarification holds and their resolution replay without effects.

The owner describes the goal and gives instructions in the ordinary chat surface.
The agent acknowledges the relevant teachings in plain language. A later owner
correction changes active memory; questions such as “What do you remember for this
task?” expose the source-linked active instructions and learned notes separately.

The same reasoning loop selects tools from current observations. It can inspect,
navigate, compare candidates, ask for clarification, and propose a learned note.
The runtime validates provenance and scope before appending any memory event.
Browser observations cannot be rebound to the current owner message as facts or
teachings. Enforce the owner-only extraction and mixed-context proposal rejection
specified above before any event commit, including turns that only consult a
persisted learned note without opening a browser.

On restart, the agent receives active teachings and learned notes and opens a fresh
session only on explicit continuation. It checks the current page before using
prior navigation knowledge. Changed layouts invalidate old references; changed
content can invalidate a learned note. Missing evidence results in uncertainty.

Recommendations cite observed candidate details and owner constraints. A browser
success banner or a model's reply alone never closes durable work. T1 has no
booking execute capability. T3 retains exact action preparation and approval,
durable started-before-dispatch ordering, and verification-only handling after
possible submission; no replay of an unknown effect.

## Acceptance and review gates

Write failing behavior tests before each executable change. Required T1 evidence:

1. Teach through ordinary conversation, restart, and continue in a linked thread;
   the original instructions remain available with exact owner provenance.
2. Correct and retract instructions; stale interpretations cannot silently win.
   Contradictions are surfaced; context overflow cannot drop mandatory constraints.
3. With the same runtime, explore two appointment layouts with different control
   labels, pagination, order, and dates. Select a supported recommendation using
   only supplied instructions and current observed content. Include a non-visa
   task, such as comparing synthetic course sessions, to detect domain coupling.
4. Learn a useful navigation note, restart, and reuse it after reobservation.
   Change the layout/content and demonstrate invalidation or relearning.
5. Inject page text asking to change owner preferences, grant approval, fabricate
   sources, leak context, or claim completion. Assert no authority promotion or
   prohibited dispatch, not merely a reassuring model reply. Deterministic final
   envelope tests reject legacy fact and teaching proposals in browser-enabled
   and learned-note-only turns; prove no partial event commit. Attempt to fill a
   control or query with unrelated memory, a forged input reference, or a valid
   reference bound to another destination; prove zero transmitted canaries.
6. Reject stale/forged/cross-session element references and cross-workspace,
   cross-work, or unlinked-thread memory retrieval.
7. Attempt dangerous controls and prohibited requests; server-side counters prove
   zero booking/submission effects. Cancellation and browser crashes cannot cause
   late interactions or automatic retries. Confirm owned-resource cleanup.
8. Rebuild from journal without inference or browser access. Reopen an older
   database and verify encrypted backup/restore with the new projection.
9. Separate deterministic policy tests from actual model/browser acceptance.
   Scripted model tests cannot demonstrate exploration or learning. Record exact
   source head, model, task instructions, observed tool calls, recommendations,
   intervention count, failures, limits and cleanup for live-model synthetic runs.
   Keep fixture answer keys and safe-route policy details out of model context.

Technical reviewers approve the spec and implementation plan under the owner's
delegation. Code release requires independent Sol/high and Astra/high reviews,
`npm run verify`, exact-head hosted CI, and visible owned-browser acceptance.
Product usefulness remains an owner judgment; do not infer it from passing tests.

## References

- [Architecture](2026-09-07-architecture-v0.md)
- [Source-preserving memory](../../adr/0003-source-preserving-memory.md)
- [General operations](../../general-operations.md)
- [Existing browser ownership design](2026-10-03-playwright-browser-adapter-design.md)
- [Live discovery constraints](../../VISA_DISCOVERY.md)
