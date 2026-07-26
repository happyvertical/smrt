# smrt-sales/svelte

Per-module semantics for `@happyvertical/smrt-sales/svelte`. Package orientation, the
cross-module invariants (currency, tenancy, cross-package refs, roles vs.
money), and the Gotchas that apply before editing anything live in
[../AGENTS.md](../AGENTS.md) — read that first.

Props-driven presentational components (no data fetching, no model-class imports, Provider-free smrt-ui primitives, `--smrt-*` tokens only): CRM — `SalesDashboard`, `LeadList`, `OpportunityBoard`, `OpportunityDetail`; referrer portal — `ReferralLinkManager`, `ReferralStatusList`, `ReferrerEarningsSummary`, `CommissionBreakdown` (trace-explained amounts), `PayoutHistoryList`, `ExecutedAgreementsList`; operator — `AttributionConflictQueue` (award editor + required resolution reason), `PayoutBatchReview`, `CommissionExpenseSummary` (explicitly distinct from client invoices). Monetary props stay integer cents; `format.ts` converts at render. View-model prop types are exported interfaces (never inline intersected generics in `$props()`); pure helpers (dashboard math, award validation mirroring the service, payout action gating) are unit-tested while components are svelte-check-gated.
