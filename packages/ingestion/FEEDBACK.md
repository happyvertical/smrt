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
authority allows the optional memory projection and it fits the configured byte
cap. Denial or an oversized automatic projection leaves the underlying
authoritative decision/outcome intact, including failure and reconciliation.
Explicit `recordFeedback` and `observeFeedback` requests still reject invalid or
oversized writes; actual database failures still propagate and roll back. Failed/rolled-back domain
work and unknown external outcomes remain distinct. `observeFeedback` can replay
an authorized existing event; it cannot supply a correctness label or fabricate
an execution result. An initial denial does not mutate retention. Once authorized,
a narrowed privacy ceiling survives business rollback and later revocation.

Observed `action_decision` events carry the decision's `decisionMode`
(`review` or `review_own`) and `selfDecision` flag from the durable decision
record. A submitter confirming their own proposal (#4085) is observed as a
decision by that actor, never as reviewer correctness evidence; consumers that
derive reviewer agreement must exclude `selfDecision: true` events, and nothing
in this package turns them into automation eligibility.

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
contexts. Receiving checks cover every offered handler, before and after source
checks, using each live grant, actual provider recipients and the narrowest byte
ceiling. Both retrieval and reference revalidation budget the full reconstructed
examples. A receiving item's provider grant cannot substitute for a source grant.
Superseded, revoked, deleted or incompatible sources are excluded. Current explicit human corrections
take precedence: a generation carrying one does not retrieve learned examples.

A judgment recorded on an action whose generation ran under a reviewer
instruction (REVIEW.md) stores only a reference, `instruction: {id, digest}`,
after verifying the generation's provenance against the authenticated
extraction record. **Write side:** the reference is ~100 bytes, so instruction
text never counts against the judgment's write budget (`feedback.maxBytes` /
`policy.maxBytes`) and cannot make `recordFeedback` fail with `Feedback
limit`. `retrieve` re-verifies the source record and joins the text, returning
`{id, digest, text}`; a stored reference that no longer matches the source's
record excludes the example. Because one long instruction joined at read time
could otherwise push every selection that ranks it over budget and deny
generation scope-wide, `recordFeedback` also builds that single joined example
exactly as `retrieve` would and refuses with `Feedback instruction exceeds
retrieval budget` (nothing is written) when it alone exceeds
`min(feedback.maxBytes, handler policy.maxBytes)`. An example that fits exactly
records and retrieves. **This guard covers only the single-example case** on the
judged handler's own budget: retrieval still sums up to `maxExamples` examples
and takes the minimum across *every* offered handler of the receiving item, so a
multi-example selection, or a receiving item with a narrower handler budget, can
still exceed the budget and fails closed as below. It is returned as part of the example so comparable later items see the guidance
that produced the judged suggestion. It is example content only: it does not
transfer to the receiving generation's configuration or prompt section, and it
expands no catalog, candidate, permission or automation eligibility. **Read-side budget
impact:** joined instruction text (up to 4,000 characters, more bytes for
non-ASCII) counts toward the exact serialized selection budget — the narrowest
of `feedback.maxBytes` and each offered handler's `policy.maxBytes` — like any
other example field. The existing fail-closed rule is unchanged: an over-budget
selection rejects with `Feedback limit` and generation records
`provider_error` without provider I/O; examples are not silently trimmed. Hosts
that enable reviewer instructions together with feedback should size
`feedback.maxBytes` (and the policy ceilings) for at least
`maxExamples × (4,000 characters of instruction + the example's own fields)`,
or lower `maxExamples`.

Full examples exist only in the authorized provider request. The SDK proposal
adapter includes that typed selection in its serialized user message when
present; disabled feedback leaves the original request shape unchanged. Saved generation
provenance contains the receiving query, selection configuration digest and
immutable feedback IDs/digests, not copied source example content. Selected
references are rechecked before generation, capability probing, decision calls,
publication and completed-result reads. A newly added example does not invalidate
an older selection; a revoked or superseded selected example does. Feedback
lineage is bounded and fails closed. Saved-action reads and pending decisions,
automatic authorization, preview publication/replay and execution also revalidate
selected lineage under the
owning transaction. Revoking, deleting or superseding a selected example blocks
pending actions; regenerate their proposals and obtain fresh approval to recover.
A preview replay checks the exact persisted proposal it returns, including its
analysis attempt; a newer action revision cannot supply replacement lineage.
Plan replay and final sealed plan-step publication use the same gate.
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

`suggestRoutingRule` requires repeated current explicit positive judgments
from distinct source items with matching handler/version and arguments, and returns supporting immutable IDs,
shared query terms and the policy owner's preview/version. Suggestions cannot
execute or modify policy. `getRoutingRule` rechecks the displayed binding and all
supporting examples. Arguments are routing preferences, never executable grants.

By default matching compares **all** action arguments, preserving existing host
behavior. Create handlers commonly have per-document content and idempotency
keys, which must remain distinct. Such hosts can explicitly declare a routing-only
subset in trusted server configuration before capturing judgments:

```ts
feedback: {
  // ...existing limits, authorize and policy owner
  routing: [{
    handlerId: 'host:create-document',
    handlerVersion: '1',
    version: 'routing-fields-1',
    fields: ['destinationId', 'category'],
  }],
}
```

Each declaration must name a configured handler/version and a nonempty, unique
allowlist of its top-level `argsSchema.properties`; duplicate declarations,
unknown properties and prototype keys reject. There are no dotted paths,
caller-supplied selectors or implicit exclusions (including request IDs).
Optional absent fields stay absent and differ from explicit `null`; at least one
selected value must be present. The host must select preferences only, never
grants, provider permissions or automation controls.

Capture retains the full immutable action arguments and binding plus the
versioned subset. For opted-in handlers `RoutingRule.args` contains only selected
values and `RoutingRule.projection` carries the canonical sorted fields and
version. Independent support must match that entire contract and those values;
full original source arguments, provenance and current access are still checked.
Existing unprojected feedback is not retroactively reinterpreted: record fresh
explicit judgments after enabling or changing a declaration. Changing a version,
field list or selected value invalidates old suggestions on reads, adoption and
replay, including changes inside policy-owner callbacks. Full argument feedback
retrieval remains unchanged; hosts may present matching examples from
`retrieveFeedback`, but suggestion creation revalidates every supplied ID.

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
validation and the frozen learning protocol, and the
[routing projection matrix](../../docs/test-matrix/3732-ingestion-routing-projection.md)
for the optional subset contract. The small authored deterministic
cohort demonstrates contract-level influence, not provider quality or measured
production improvement. Real-provider evaluation belongs to #3677. There are no
sampled automatic outcomes in this feature; reporting that stratum as unavailable
avoids inventing correctness labels from successful jobs.

When interpretation requests optional examples, an explicit denial of feedback
retrieval degrades to generation without examples or feedback provenance. Direct
`retrieveFeedback` calls still reject denied reads. Other authorization errors
are not swallowed, and already selected examples must pass the normal live
provider-boundary checks; revocation does not silently preserve selected data.
