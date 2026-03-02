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

## Gotchas

- **Priority waterfall**: lower priority number = higher priority in selection
- **Weight is relative integer**: not percentage — probability calculated from total weight across variations
- **Denormalized counts need async refresh**: impressions/clicks on AdVariation are eventually consistent
- **No frequency capping or budget enforcement built-in**: external responsibility
- **Targeting rules stored as JSON string**: no schema validation
- **Optional tenancy** on AdVariation and AdEvent
