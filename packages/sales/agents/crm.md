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
- **OpportunityConversion**: idempotent conversion links (`targetKind`/`targetId` — client, project, contract, subscription, …) with a composite natural key. CRM never creates downstream records itself and never mutates referral or commission state.
