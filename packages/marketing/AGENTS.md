# @happyvertical/smrt-marketing

Cross-channel campaign coordination for SMRT. This package owns Campaign
identity, budgets, lifecycle, execution links, immutable performance evidence,
computed pacing, and props-driven Svelte surfaces. It does not execute ads,
publish social posts, send messages, or own sales attribution.

## Validation

Run `pnpm --filter @happyvertical/smrt-marketing test` and
`pnpm --filter @happyvertical/smrt-marketing typecheck`; use `test:coverage`
to exercise the model/service and component coverage configurations.
Natural-key changes must also run
`pnpm --filter @happyvertical/smrt-marketing test:postgres` when
the disposable PostgreSQL harness is available. Use
`pnpm --filter @happyvertical/smrt-marketing build` and `verify:pack` for
publish-surface changes.

## Models

- **Campaign**: optional-tenant umbrella with stable natural key
  `(tenant_id, campaign_key)`, open objective, integer-cent budget, currency,
  schedule, optional native UUID reference to the canonical commerce Customer,
  guarded metadata helpers, and lifecycle
  `draft → scheduled → active ↔ paused → completed → archived`. Raw saves are
  protected by an authoritative prior-status re-read; use
  `CampaignLifecycleService` for lifecycle writes.
- **CampaignChannel**: one generic execution link per
  `(campaign_id, channel_kind, channel_ref)`. `channelKind`/`channelRef` are
  intentionally plain strings so ads, social, messages, content, events, and
  referral programs remain peer packages. Allocation and schedule overrides
  use integer cents and dates.
- **CampaignMetricSnapshot**: immutable period evidence with a global
  `dedupe_key` natural key. A snapshot always carries `campaignId`; a null
  `campaignChannelId` means campaign-level rollup evidence; when present, the
  channel must belong to that same campaign. API/MCP/CLI expose create/list/get
  only, and the save guard rejects hydrated edits, blind-id overwrites, and
  natural-key overwrites. Programmatic deletion is rejected.

Every model is `@TenantScoped({ mode: 'optional' })` with nullable `tenantId`.
All generated surfaces are explicit; never omit `api`, `mcp`, or `cli` config.

## Services

- **CampaignLifecycleService** loads the current row before applying one legal
  transition. Paused campaigns may resume; completed campaigns may only be
  archived; archived campaigns are terminal.
- **MetricIngestionService** validates required scope/source/period fields and
  delegates to `getOrCreateByDedupeKey()`. A replay returns the original row
  unchanged even if the replay payload differs.
- **BudgetPacingService** computes campaign/channel pacing from snapshots and
  never persists derived balances. For each exact reporting period, campaign
  pacing prefers campaign rollups and otherwise sums channel snapshots,
  preventing double counting without dropping channel-only periods. Status
  uses a five-percent budget tolerance around schedule-derived expected spend.
- **CampaignCollection** exposes bounded, tenant-and-Customer-scoped cursor
  pages ordered by `start_at DESC, id DESC` and bounded batch summaries for
  total count, active count, and latest start time. Its reporting-page variant
  preserves that order/cursor and adds channel count/mix, immutable metric
  totals, and canonical pacing with two page-wide grouped reads. Customer scope
  is validated through runtime relationship metadata; there is no static
  commerce import, per-campaign callback, or tenant-wide materialization.

## Svelte

`@happyvertical/smrt-marketing/svelte` exports `MarketingDashboard`,
`CampaignList`, `CampaignDetail`, `ChannelMix`, and `BudgetPacing`, plus view
interfaces and pure helpers. Components are props-only: no fetching, no model
imports, no providers. Use Provider-free `smrt-ui` primitives, `--smrt-*`
tokens, named `$props()` interfaces, and integer-cent inputs formatted only at
render time.

## Boundaries and gotchas

- Runtime dependencies stay limited to `smrt-core`, `smrt-tenancy`, and
  `smrt-ui`. Never statically import sibling domain packages.
- `Campaign.customerId` targets `@happyvertical/smrt-commerce:Customer` through
  `@crossPackageRef`. Saves and customer-scoped reads require exact tenant
  agreement (including global-to-global only) and fail without revealing
  whether a Customer is absent or belongs elsewhere. Associated saves validate
  and persist through one transaction-bound Campaign instance; scoped reads
  validate and query through one fresh transaction-bound collection. PostgreSQL
  locks the validated Customer rows for the duration of each operation.
- Lead loop-closing is conventional: CRM stores `sourceKind: 'campaign'` and a
  campaign key in `sourceId`; marketing does not import or mutate Lead.
- Attribution math remains in sales/referrals. Marketing stores performance
  evidence only.
- Campaign rollups and channel snapshots may describe the same period. The
  pacing service deliberately chooses one evidence level instead of summing
  both.
- Corrections append a new metric snapshot with a new dedupe key; never edit
  persisted evidence.
- Table names are global: `campaigns`, `campaign_channels`, and
  `campaign_metric_snapshots`.
