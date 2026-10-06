# smrt-sales/svelte

Per-module semantics for `@happyvertical/smrt-sales/svelte`. Package orientation, the
cross-module invariants (currency, tenancy, cross-package refs, roles vs.
money), and the Gotchas that apply before editing anything live in
[../AGENTS.md](../AGENTS.md) — read that first.

Props-driven presentational components (no data fetching, no model-class imports, Provider-free smrt-ui primitives, `--smrt-*` tokens only): CRM — `SalesDashboard`, `LeadCreateForm`, `LeadList`, `LeadDetail`, `OpportunityBoard`, `OpportunityDetail`; referrer portal — `ReferralLinkManager`, `ReferralStatusList`, `ReferrerEarningsSummary`, `CommissionBreakdown` (trace-explained amounts), `PayoutHistoryList`, `ExecutedAgreementsList`; operator — `AttributionConflictQueue` (award editor + required resolution reason), `PayoutBatchReview`, `CommissionExpenseSummary` (explicitly distinct from client invoices). Monetary props stay integer cents; `format.ts` converts at render. View-model prop types are exported interfaces (never inline intersected generics in `$props()`). Pure helpers are unit-tested and Lead intake/inbox/detail components have mounted runtime tests through `vitest.ui.config.ts`.

`LeadCreateForm` validates the required name and email-or-phone contact rule, normalizes email, and emits a host-mapped `LeadCreateDraft`; source choices, duplicate results, errors, and owner choices come from the host. `LeadList` accepts controlled filter/count, sort, page, selection/link, and row-action props; the host owns inbox fetching and callback mutations. `LeadDetail` renders a complete host-supplied timeline, an optional linked-opportunity summary snippet, and callback-only assignment, start/reopen, disqualification, human-activity, next-action, completion, and qualification controls. Its `busy` prop disables every mutation affordance; the host owns tenancy, authorization, service invocation, refresh, and any policy around due dates or reminders.
