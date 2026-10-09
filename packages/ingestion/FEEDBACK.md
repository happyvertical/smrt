# Explicit ingestion feedback

Configure `IngestionOptions.feedback` to opt in. The existing `intake_feedback`
ledger owns these records; no new schema, embedding service or provider is added.
`FeedbackConfiguration` sets a version, maximum examples, scan count, serialized
bytes and lexical similarity threshold, plus a live scoped authorization callback.
Hard ceilings are 20 examples, 1,000 scanned records and 1 MB. Choose substantially
smaller application limits. The proposal's complete serialized request, including
examples, must also fit the current minimum application/source/provider budget.

`recordFeedback` accepts the exact displayed action revision, review version and
binding hash, an explicit correct/incorrect judgment, optional reason text and a
request ID. The server resolves reviewer, tenant/confidential scope, retained
source evidence, extraction/generation versions and current handler arguments.
A replay returns the same immutable receipt; changed payloads conflict.
`supersedesId` appends a replacement for the specified prior interpretation
judgment. A second successor conflicts. Revised actions make old bindings
ineligible. Approval and successful execution never imply that extracted fields
are correct.

Decision and downstream execution facts are captured inside their owning
transaction, keyed by immutable event ID and signal, when the configured capture
authority allows the optional memory projection. Denial leaves the underlying
authoritative decision/outcome intact. Failed/rolled-back domain
work and unknown external outcomes remain distinct. `observeFeedback` can replay
an authorized existing event; it cannot supply a correctness label or fabricate
an execution result. An initial denial does not mutate retention. Once authorized,
a narrowed privacy ceiling survives business rollback and later revocation.

## Retrieval and provider boundaries

`retrieveFeedback({ itemId, query })` derives the current offered catalog,
candidates and model/prompt/configuration versions on the server. Callers cannot
provide candidate authority. The deterministic matcher uses lowercase Unicode
word-set Jaccard similarity (minimum 0.2), then immutable record ID for ties.
Scanning, recursive provenance checks and returned examples are bounded; a limited scan does not promise an
exhaustive history search. Both positive and negative explicit examples are kept.

Every selected source must still be readable in the same tenant and confidential
scope, with its current action/analysis binding, target grants, handler version,
model/prompt/configuration compatibility and retention. Each source's current
provider policy must allow the generation recipient and any configured decision
recipient; the source owner rechecks that policy on both initial and final live
contexts. A receiving item's provider grant cannot substitute for a source grant.
Superseded, revoked, deleted or incompatible sources are excluded. Current explicit human corrections
take precedence: a generation carrying one does not retrieve learned examples.

Full examples exist only in the authorized provider request. The SDK proposal
adapter includes that typed selection in its serialized user message when
present; disabled feedback leaves the original request shape unchanged. Saved generation
provenance contains the receiving query, selection configuration digest and
immutable feedback IDs/digests, not copied source example content. Selected
references are rechecked before generation, capability probing, decision calls,
publication and completed-result reads. A newly added example does not invalidate
an older selection; a revoked or superseded selected example does. Feedback
lineage is bounded and fails closed. Saved-action reads and pending decisions,
automatic authorization and execution also revalidate selected lineage under the
owning transaction. Revoking, deleting or superseding a selected example blocks
pending actions; regenerate their proposals and obtain fresh approval to recover.
For already successful actions, current-authorized durable outcomes remain
readable/replayable, but invalid learned lineage suppresses saved proposal
display, arguments and plan payload. An empty selection carries no learned source
and does not turn optional feedback-capture denial into action denial. Examples
never expand the offered catalog, candidate IDs, operation permissions or
automation eligibility.

All durable feedback belongs to the source item's existing retention/redaction
lifecycle. There is no separate memory store or delayed indexing writer to clean
up. Hosts using other derived stores still implement the existing `purgeDerived`
contract. Core `LearningMemory` is intentionally not used here: its success/failure
reinforcement and default ancestor-scope fallback do not represent separate
correctness/decision/outcome signals and strict confidential-scope eligibility.

## Routing suggestions and adoption

`suggestRoutingRule` requires repeated current explicit positive judgments with
from distinct source items with matching handler/version and arguments, and returns supporting immutable IDs,
shared query terms and the policy owner's preview/version. Suggestions cannot
execute or modify policy. `getRoutingRule` rechecks the displayed binding and all
supporting examples. Arguments are routing preferences, never executable grants.

`adoptRoutingRule` requires the exact suggestion digest and expected policy
version plus current reviewer and adoption authority. The configured policy owner
must perform its version compare-and-swap and audit on the supplied database
executor. The ingestion transaction records the exact returned version/audit ID.
Replays do not adopt twice. Revocation or permission/policy widening rolls back
both changes. The host callback may store routing preferences only: it must not
change grants, provider permissions or automation controls. Adoption always
returns `automaticActionEligible: false`; subsequent proposals retain normal
current policy and explicit review requirements.

## Review UI and evidence

The optional `IntakeReviewHost.feedback` callback carries the exact displayed
revision and binding. Correct/incorrect controls are explicit and independent of
Approve/Apply. Unsaved argument edits disable correctness controls until the
displayed binding is current again. Hosts must authenticate that callback and connect it to
`recordFeedback`; client-supplied reviewer/scope fields are not accepted. The
maintained browser fixture demonstrates this transport with CSRF protection and
rejects substituted revisions.

See [the behavior matrix](../../docs/test-matrix/3676-ingestion-feedback.md) for
validation and the frozen learning protocol. The small authored deterministic
cohort demonstrates contract-level influence, not provider quality or measured
production improvement. Real-provider evaluation belongs to #3677. There are no
sampled automatic outcomes in this feature; reporting that stratum as unavailable
avoids inventing correctness labels from successful jobs.
