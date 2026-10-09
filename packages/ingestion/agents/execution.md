# Review and execution integration

`/execution` exports `IntakeExecutionService`, handler/host types, policy
resolution, binding digests and `continueIntakeReview`. `IngestionService` exposes
these operations when its optional `execution` configuration is present. Its
loader is lazy: importing `/server` alone does not import the principal stack.
`/dto` exposes execution messages using type-only exports. No generated REST,
CLI or MCP mutation endpoint is enabled; applications authenticate their own
service surface and create `IngestionScope` from the session.

## Catalog and authority

Applications supply a trusted `IntakeExecutionOptions.handlers` catalog.
`OperationHandler` has qualified ID, immutable version, description, object JSON
schemas for arguments/results, allowlisted `resultModels`, `validate`, `preview`,
a registered `{model, action, version}` operation and explicit effect/idempotency/
open-world capability declaration. Preview returns display, exact normalized
arguments and target revision preconditions. There is no arbitrary tool execution
or expression evaluation. Reviewer display wraps application fields under `preview`
and symbolic metadata under `dependencies`; plan steps additionally wrap that
object under `step` alongside the plan preview. Application display keys cannot
overwrite framework metadata or be silently overwritten by it. A version change
requires a new preview and approval.
`PlanHandler` references a real registered playbook key and resolved definition
hash; expansion contains only ordered operation handlers and typed earlier-step
result references. Discovery/proposal generation consumes this catalog rather
than creating another registry. Semantic model output is never host configuration.

Authenticated receipt context captures `capturedCeiling.execution` with principal
ID and permission/handler/operation ceilings. The execution host's `authorize`
resolves current grants and application/tenant/source/(optional request) policy
on the supplied executor, checking the active requester and confidential scope.
Lists intersect, budgets minimize, review requirements OR, and disabled policy
wins. Policy versions must change when policy semantics change. Normal operation
requires human review; machine authorization requires explicit evaluated opt-ins
at all three authority layers and remains separate provenance from human review.
The reference handlers always require review; no evaluation claim is made here.

`mutationBoundary: 'serialized'` is an explicit host guarantee, not an inferred
property of a permissions array: grant revocation must serialize with the supplied
transaction, or the owning mutation must revalidate under its own lock. The host
must implement that guarantee before enabling handlers. `assertTarget` similarly
locks current tenant/confidential ownership and revision against concurrent
writers using the supplied executor. The reference host demonstrates a scoped
row lock before public `Contents` reads. A current `PrincipalRun` intersects live
permissions with the captured ceiling and checks the exact registered collection
operation at every effect. No `runOnce` atomicity is assumed.

## Durable review and effects

Preview appends a proposal bound to exact analysis attempt/evidence, handler,
arguments, policy and target preconditions. Decision requests use unique durable
request IDs; reusing an ID with changed content is rejected. First valid review
wins under the item lock. Corrections append a new revision; reject/defer remain
non-executable. Plan corrections use re-expansion. Human decisions expire and
live authority is checked again before each step. Raw foundation proposals cannot
bypass execution's schema, preview, evidence and approval verification.

Database handlers must use `context.db` for every domain effect and must perform
no external I/O. Domain result and successful execution commit together. A domain savepoint rolls failed effects
back while preserving the item lock and atomically consuming the retry attempt. Completed
actions survive job cleanup and evidence retention; expired originals leave a
minimal result digest tombstone, preventing a second effect. Active result reads
recheck host visibility and result target ownership.

External handlers reserve a stable action idempotency key before submission.
Timeout, process death or ambiguous outcome requires reconciliation; an expired
lease never means permission to resend. `reconcile` must return authoritative
`succeeded`, `not_applied` or `unknown`. `not_applied` is safe only when the provider
can exclude a late acceptance of the original send; uncertainty stays `unknown`.
The same key is reused after a conclusive non-application. Cancellation prevents
pending work but cannot retract a send already issued. Applications must arrange
provider reconciliation before privacy retention removes the binding; a redacted
unknown action fails closed and cannot automatically execute again.

Each plan step has a stable action identity. Completed steps are immutable and
return their original result. Symbolic record IDs bind to exact earlier proposal
revision, successful result digest/model and target revision; they cannot point
across items or form cycles. Failed dependent steps never repeat predecessors.
The plan preview and target preconditions are part of its digest and visible in
each step review; changed preview/preconditions require a fresh review.
Abort/continue follows the pinned public playbook definition, with fresh authority
at every step.

`continueIntakeReview` uses the existing jobs continuation context. Applications
create tasks with owner, tenant and exact `{recordId, revision, inputKey}` binding
and configure `authorizeMcpTask` to revalidate it. A continuation answer only wakes
the task; the service reloads the authoritative decision. Waiting persists without
an occupied worker and survives runner restart.

## Deployment and evidence

Apply normal manifest migrations before runtime. Execution imports the public
agents/users principal stack, which registers profiles including `ProfileAsset`;
execution-enabled hosts must migrate their dependency graph (including profile
asset joins used by asset deletion). `/server` receipt-only imports register none
of these additional models. Content is not a runtime dependency of ingestion.
`reference/handlers.ts` is an application/test fixture, excluded from published
entries and declarations; importing it deliberately adds Content and its asset
joins, whose migrations the application then owns. No runtime DDL is performed.

Real SQLite and PostgreSQL execution suites exercise the public Content draft and
attachment APIs, transaction rollback, actor/context denials, simultaneous applies
and reviewers, retention replay, external process death and actual TaskRunner
restart. See the issue 3674 test matrix for the complete release evidence mapping.

## Layered retention and request automation

Every automation-bearing policy layer, including an optional request layer, must
match the evaluated version. An absent request automation block adds no evaluator
restriction; it cannot replace the three required application/tenant/source opt-ins.

Authorized execution-policy access monotonically narrows the existing intake
expiry to `min(existing expires_at, item.created_at + resolved retentionMs)`.
The anchor is receipt creation, never review, retry or replay time. A longer later
policy never extends a recorded deadline. This hard maximum applies to the whole
intake item: the existing `sweepRetention` protocol removes retained originals and
derivatives, preserving replay identities. No second expiry column or hidden clock
is introduced, and no blob I/O occurs in an execution transaction.

At an observed expired deadline, execution reads/completions erase proposal,
decision, execution, plan, action and feedback payloads under the item lock. Review
reads return existing identity/hash fields with `state: 'expired'` and empty
`display`; completed action replay returns its digest-only tombstone. Failed writes, including ordinary validation/CAS/policy rejection and domain
savepoint rollback, cannot roll back an already-authorized retention ceiling or
redaction. Restoring a recorded authorized maximum needs no new content-read grant;
later revocation cannot undo it. Initial denied authorization records no intent.
Completed replay checks the deadline again after target authorization
callbacks before returning cached content. Proposal publication and automatic
authorization also recheck after preview/evaluator callbacks, before publishing
retained proposal or decision payloads. Unknown
external outcomes remain unknown/reconcile-only, never eligible for blind resend.
