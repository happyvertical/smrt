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
