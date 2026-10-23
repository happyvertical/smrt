# smrt-sales/crm

Per-module semantics for `@happyvertical/smrt-sales/crm`. Package orientation, the
cross-module invariants (currency, tenancy, cross-package refs, roles vs.
money), and the Gotchas that apply before editing anything live in
[../AGENTS.md](../AGENTS.md) — read that first.

- **SalesRepresentative**: role model (`profileId`, `earnerId`, `status`).
- **Lead**: identified prospect with owner assignment, generic acquisition source (`sourceKind`/`sourceId`), preserved `acquisitionContext` JSON, and audited merge (`mergedIntoId`; merges preserve activity + acquisition history on both sides).
- **PipelineDefinition / PipelineStage**: configurable ordered stages with default `new → qualified → discovery → proposal → negotiation → closed_won | closed_lost` (seeded via `ensureDefaultPipeline()`); stages carry `probability` and `isWon`/`isLost` terminal flags.
- **Opportunity**: qualified engagement — owner, pipeline + stage, `expectedValueCents`, `probability`, `expectedCloseAt`, outcome. Stage movement validated against the pipeline; terminal stages set `won|lost` status.
- **SalesActivity**: activity/next-action trail for Leads and Opportunities (`subjectKind`/`subjectId`), also the audit trail for assignment, qualification, merges, and stage movement.
- **LeadWorkflowService**: the required tenant-safe Lead mutation seam. It transactionally locks the affected Lead/Opportunity (and completion task on PostgreSQL), accepts only active same-tenant representatives, writes actor-attributed audits alongside mutations, and returns merge-aware timeline/work-state reads. It owns validated `createLead()` intake, `new | disqualified → working`, `new | working → disqualified`, human follow-up (`note | call | email | meeting`), task scheduling/completion, delegated qualification, nonterminal Opportunity stage movement, and terminal Opportunity closure/conversion. Merging remains a collection lifecycle.
- **OpportunityConversion**: idempotent conversion links (`targetKind`/`targetId` — client, project, contract, subscription, …) with a composite natural key. CRM never creates downstream records itself and never mutates referral or commission state.

Workflow calls require ambient tenant context. Mutations require an actor profile
id except `createLead()`, whose actor is optional for automated intake. Fail
closed for foreign/missing Lead, Opportunity, pipeline, representative, and task
ids without revealing their existence. Human metadata is plain JSON-object data;
framework audit metadata is generated separately. Keep queue projection pure
(`now`/optional timezone are injected) and do not add assignment, reminder, SLA,
authorization, or conversion policy.

`createLead()` requires a name and at least one of email/phone, normalizes email,
and supports `none | email | email_or_org` tenant-local dedupe. Active duplicates
return the existing Lead and append one `inbound` activity per novel normalized
intent; terminal matches return `{ created: false, duplicateOf }` without mutation
so the caller must explicitly retry with `dedupe: 'none'` to create another Lead.
Caller idempotency keys are persisted through deterministic immutable activity
ids, including when intake resolves to an existing active Lead; reusing a key
with changed intent is rejected. PostgreSQL uses transaction advisory/row locks,
while single-connection adapters serialize the entire transaction.
The optional `profileId` is a host-authorized cross-package identity link and is
part of that immutable retry intent; Sales stores it but does not authorize or
load the referenced Profile.

`qualifyLead()` delegates to `LeadCollection.qualify()` on the same transaction
executor and returns whether the Opportunity was newly created.
`moveOpportunityToStage()` locks an open Opportunity and atomically moves it to
a nonterminal stage in the same tenant and pipeline. An exact stage/probability
retry is a no-op; a conflicting same-stage probability is refused. Terminal
stages remain exclusive to `closeOpportunity()`, which
resolves the configured won/lost terminal stage, delegates stage movement, and
optionally records a won conversion in the same transaction. Exact retries add
no stage activity or conversion. `getLeadWorkState()` includes the canonical
linked Opportunity when present. Transaction-bound result models are reloaded
on the service database after commit before being returned.

`LeadCollection.listInbox({ status?, ownerRepId?, unassigned?, overdue?,
search?, sort?, limit, offset, now? })` requires ambient tenancy and returns
`{ leads, items, total, statusCounts }`. `leads` are hydrated Lead rows; aligned
`items` add the hydrated owner and earliest open Lead task as `nextAction`
without per-row queries. Search trims and performs case-insensitive literal
substring matching across name, contact name, email, phone, and organization.
Sort values are `created | next_action | name`, all with stable id tie-breaks;
missing next actions sort last. `limit` is required from 1–100 and `offset` is
required and nonnegative.

`total` applies every selected filter. `statusCounts` contains `all`, every Lead
status, `unassigned`, and `overdue`; counts retain owner/search scope but ignore
the selected status/unassigned/overdue tab. Overdue means the earliest open task
is due strictly before injected `now` (default current time).

`LeadConversionService.create({ db: tx, transaction: 'caller' })` records pending
conversions before an Opportunity is won, using immutable `lead_conversion`
SalesActivity receipts (no new table). Hosts authorize inputs and serialize the
lead conversion scope, create downstream records, and record the receipt within
one caller-owned transaction. `getForLead({ tenantId, leadId, targetKind })` and
`recordForLead({ ...scope, targetId, actorProfileId, metadata? })` require matching
ambient tenancy and a same-tenant Lead. A tenant/lead/targetKind has one target;
exact target/metadata replay returns the original receipt and actor, conflicting
intent is refused. The service never changes Lead/Opportunity state, invites
users, or starts a transaction. Only use returned plain receipts after commit.

`findForTarget({ tenantId, targetKind, targetId })` reads canonical originating
Lead receipts for a downstream target in the active tenant, without requiring
hosts to parse SalesActivity metadata.

`LeadWorkflowService.updateLeadContact({ leadId, actorProfileId, name,
contactName, email, now? })` locks a same-tenant, non-merged Lead and corrects
editable contact fields in its own transaction. Name is required, email is
normalized/validated, and at least email or existing phone is required. Exact
retries are no-ops. Effective changes append one `contact_update` activity with
before/after values and actor; audit failure rolls back the correction. Profile
identity, acquisition context/source, CRM status and downstream records stay intact.


## Governed sellers, quotes and canonical advertiser registration

`SalesGovernanceService` is the required mutation boundary for governed sales.
Referral identity never grants seller authority. Every fresh seller mutation
requires a tenant context exactly matching `tenantId`, an actor Profile matching
an active tenant-owned `SalesRepresentative`, host membership and suspension
checks, and `canSell`. There is no seller count limit. Hosts own newsroom or
editorial classification through `canSell`; SMRT imports no application policy.

Create with `{ database: { type: 'postgres', url, ... }, host, now? }`.
The service owns connection creation; arbitrary adapter injection is not accepted.
`service.database` is a read-only getter for migrations and host reads. The owned
backend declaration and adapter reference cannot be replaced through public API.
The factory validates an explicit connection-options allowlist before SQL sees
it: no adapter-shaped objects or runtime schema definitions.
Connections always use `cache: false`; requesting `cache: true` is refused before
SQL. Each service owns a distinct adapter, so closing it cannot invalidate a peer.
SQLite is rejected before opening: the required same-process recovery after
BUSY invalidation could not be established on the published SQL adapter, even
with uncached owned connections, callback transactions, close and recreate.
Earlier SQLite behavioral and separate-process race evidence does not establish
that recovery contract. This backend remains unavailable until a passing complete
Sales recovery proof supports enabling it. This is an unverified validation
contract, not an established raw SQL defect. Follow the acceptance in
[SMRT #4269](https://github.com/happyvertical/smrt/issues/4269) before enabling SQLite.
 Every service
transaction and mutation rechecks its supported backend boundary. All host methods are mandatory and authorize
only on literal `true`. `host.policy` returns `{ version, maxDiscountBps,
leaseDurationMs, approvalDurationMs }`: basis points and durations are safe
integers, durations positive, basis points between 0 and 10000. Unsupported or
malformed values, missing resources and thrown provider/inventory failures deny
without partial writes. Host predicates receive the exact transaction executor;
lock current authoritative membership, suspension, policy and inventory rows
through that executor. A cached predicate or remote network check cannot promise
transactionally stable authority. `validateQuote` must validate the exact rate
card version, inventory version, advertiser ownership and cents totals.

`acquireLease` accepts a canonical tenant-local `advertiserId`, never free-text
organization/email dedupe. `advertiserExists` validates this identity and tenant
ownership. Registration is exclusive while `released === false` and
`expiresAtMs > now`; equality is expired. The shared deterministic resource UUID
and database row lock/CAS arbitrate independent processes/connections. Database
busy/transaction-conflict failures are safe to retry with the original operation
UUID. `renewLease` requires a live owner and matching `leaseId`, and starts a
new configured duration from current time. `releaseLease` requires the same
owner token and does not transfer ownership; release at expiry is allowed.
A newly acquired replacement has a new token. `getLease` returns the current
registration after host member/suspension and advertiser checks.

Every mutation accepts a globally unique lowercase UUID `operationId`. An exact
retry returns its immutable original outcome, including its original expiry,
without extending a lease or repeating a transition. Changed inputs conflict.
An outcome replay is historical evidence, **never fresh authority to sign**.
To combine host writes and Sales writes, use:

```ts
await sales.withTransaction(async (tx) => {
  const quote = await sales.signQuote(input, tx);
  await hostPersistSignIntent(quote, tx);
});
```

Only active executors issued by `withTransaction` are accepted; arbitrary pools
and external callback executors are refused. This avoids guessing transaction
identity or nesting transactions on independent pooled sessions. Any throw rolls
back Sales state, audit and host writes together. Do not retain the executor
beyond the callback. Result projections are plain detached values.

`createQuote` freezes one commercial revision: seller, canonical advertiser,
rate-card version, inventory version, subtotal/total integer cents, uppercase
currency, maker Profile, tenant and exact policy. New revisions must increase;
older revisions cannot issue, approve or sign after a new revision is created.
The comparison `(subtotalCents - totalCents) * 10000 <= subtotalCents *
maxDiscountBps` uses BigInt, so the discount boundary has no floating rounding.
`issueQuote` moves draft to issued; `signQuote` moves issued to signed. Both
revalidate current seller, host resources and exact policy version/values.

Above-limit terms require `requestApproval` then `decideApproval`. Requests bind
the entire frozen revision and policy hash. A distinct current tenant member
with `canApprove` must decide: no self-approval or single-operator fallback.
Only pending, unexpired requests can approve/reject. Approved decisions can be
revoked, including after issue/sign. Sign/issue recheck current checker
membership, suspension and finance authorization. Pending, rejected, revoked,
expired or altered bindings fail closed. A new request after expiry/rejection
uses a new quote revision. Decisions and reasons remain immutable audit events.

For provider execution use `sourceKind: 'sales-quote'`, `sourceId: quoteId`,
`sourceVersion: revision`, and `signingActorProfileId`. Agreement execution
requires an injected `authorizeSigning(input)` guard for these sources; wire it
to `sales.assertCanSign({ tenantId, actorProfileId: signingActorProfileId,
quoteId: sourceId, revision: sourceVersion })` and
validate that the source document describes those exact frozen terms. The guard
runs before source storage/replay and immediately before provider create I/O.
An optional guard can cover other source kinds too. A host must not relabel a
sales quote as an ungoverned source. Already-existing execution retries still
recheck the guard; seller revocation cannot reuse earlier signing authority.
SQL commits local sign authority; external provider work cannot join or roll
back with SQL. Revoking authority does not cancel already-dispatched provider
requests: hosts must explicitly cancel outstanding requests when their policy
requires it, and handle the provider result/reconciliation lifecycle.

Migrate **both** manifest models `SalesGovernanceState` (resource/operation
fences) and `SalesGovernanceEvent` (immutable intent/result history) before
calling the service. Runtime never creates application schema. Both models and
collections are root/CRM exports for generated registration but have no generated
API/MCP/CLI writes. Direct generic collection/model create, update and delete are
also refused: the service owns an internal executor-bound write capability.
Do not edit private state rows or delete audit rows. A privileged SQL owner can
bypass domain models; never expose raw database access to application callers.
`SellerGovernancePanel` and its exported `SellerGovernanceView` /
`SellerGovernanceAction` are callback-only UI contracts; displayed eligibility
never substitutes for server authority checks. Hosts map canonical advertiser
selection and current conflict/expiry state onto those props.

This delivery supports **PostgreSQL only**. SQLite, DuckDB, JSON, PGlite,
missing and unknown backend configurations are refused before any connection,
SQL, policy callback or state mutation. PostgreSQL independent pooled-connection tests exercise the database fence.
Native PostgreSQL acceptance cases run under `test:postgres`.

The complete #4264 request remains open and blocked on
[happyvertical/sdk#1452](https://github.com/happyvertical/sdk/issues/1452): the
published SQL DuckDB adapter opens independent native instances for the same
file and a second handle can read stale state after another handle commits.
Independent writer authority cannot safely rely on that adapter. This explicit
backend boundary is a reduced supported contract, not a DuckDB SQL workaround.
DuckDB support requires the upstream shared-instance visibility fix and a repeat
of the full cross-connection lease/approval matrix before enabling it.
