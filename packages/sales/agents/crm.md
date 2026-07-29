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
- **LeadWorkflowService**: the required tenant-safe pre-qualification mutation seam. It transactionally locks the Lead (and completion task on PostgreSQL), accepts only active same-tenant representatives, writes assignment/status/completion audits alongside their mutations, and returns merge-aware timeline/work-state reads. It owns `new | disqualified → working`, `new | working → disqualified`, human follow-up (`note | call | email | meeting`), and task scheduling/completion; qualification and merging remain collection lifecycles.
- **OpportunityConversion**: idempotent conversion links (`targetKind`/`targetId` — client, project, contract, subscription, …) with a composite natural key. CRM never creates downstream records itself and never mutates referral or commission state.

Workflow calls require ambient tenant context and an actor profile id. Fail closed for foreign/missing Lead, representative, and task ids without revealing their existence. Human metadata is plain JSON-object data; framework audit metadata is generated separately. Keep queue projection pure (`now`/optional timezone are injected) and do not add assignment, reminder, SLA, authorization, or conversion policy.
