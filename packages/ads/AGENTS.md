# @happyvertical/smrt-ads

Ad delivery with priority waterfall, weighted A/B testing, and immutable event tracking.

## Models

- **AdFormat**: IAB standard dimensions (width, height, type: banner/native/video)
- **AdDeliveryTier**: priority levels — Sponsorship (1, FIXED pricing) > Standard (2, CPM) > House (3, fallback)
- **AdGroup**: campaign with targeting, budget, zone restrictions
- **AdVariation** (STI): creative variant with weighted selection for A/B. `weight=2` is 2x more likely than `weight=1`. Denormalized `impressions`/`clicks` fields.
- **AdEvent** (STI, immutable): impression/click/conversion tracking. **Create-only** — no update/delete in API/MCP. `cli: false` (high-volume).

## Cross-Package References (all plain string IDs)

`contractId` → smrt-commerce, `zoneId`/`siteId` → smrt-properties, `assetId` → smrt-assets, `verticalSlug` → smrt-tags

## Tenancy

Optional tenancy via `@TenantScoped({ mode: 'optional' })` is applied to the
three transactional models — `AdGroup`, `AdVariation`, and `AdEvent` — which
participate in per-tenant ad serving and event tracking.

`AdFormat` and `AdDeliveryTier` are deliberately **NOT** tenant-scoped: they
are shared catalog/lookup tables.

- `AdFormat` rows describe IAB standard ad dimensions (e.g. `728x90`
  Leaderboard, `300x250` Medium Rectangle). The dimensions are an industry
  standard, not a tenant-specific configuration.
- `AdDeliveryTier` rows describe the priority waterfall for ad selection
  (Sponsorship → Standard → House). Tiers are part of the package's
  ad-serving contract; per-tenant tier definitions would fragment the
  selection algorithm without a clear use case.

Either model can still be filtered by tenant manually if a deployment ever
needs tenant-specific overrides, but the default is global. This mirrors the
documented exception pattern in `packages/secrets/AGENTS.md` (`TenantKey`).
Each `@smrt(...)` block on these two classes carries an inline comment
pointing back here.

## Gotchas

- **Priority waterfall**: lower priority number = higher priority in selection
- **Weight is relative integer**: not percentage — probability calculated from total weight across variations
- **Denormalized counts need async refresh**: impressions/clicks on AdVariation are eventually consistent
- **No frequency capping or budget enforcement built-in**: external responsibility
- **Targeting rules stored as JSON string**: no schema validation
- **Optional tenancy** on `AdGroup`, `AdVariation`, `AdEvent` only — see Tenancy section above for `AdFormat`/`AdDeliveryTier` rationale
