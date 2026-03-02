# @happyvertical/smrt-ads

Advertising delivery and tracking models for the SMRT framework. Supports priority-based ad group delivery with a tier waterfall, IAB ad formats, weighted A/B variation testing, and immutable event tracking.

## Installation

```bash
pnpm add @happyvertical/smrt-ads
```

## Usage

```typescript
import {
  AdDeliveryTier, AdDeliveryTierCollection,
  AdGroup, AdGroupCollection,
  AdVariation, AdVariationCollection,
  AdEvent, AdEventCollection,
  AdEventType, PricingModel, AdGroupStatus
} from '@happyvertical/smrt-ads';

// Define delivery tiers (lower priority number = served first)
const tiers = new AdDeliveryTierCollection(db);
const sponsorship = await tiers.create({
  name: 'Sponsorship',
  priority: 1,
  pricingModel: PricingModel.FIXED,
});

const standard = await tiers.create({
  name: 'Standard',
  priority: 2,
  pricingModel: PricingModel.CPM,
});

// Create an ad group with targeting and budget
const groups = new AdGroupCollection(db);
const group = await groups.create({
  name: 'Holiday Campaign',
  tierId: sponsorship.id,
  contractId: 'contract-uuid',
  status: AdGroupStatus.ACTIVE,
  dailyBudget: 100.00,
  totalBudget: 3000.00,
  startDate: new Date('2024-06-01'),
  endDate: new Date('2024-08-31'),
});
group.setTargeting({ device: 'desktop', geo: 'US' });
group.setZoneIds(['zone-1', 'zone-2']);
await group.save();

// Add variations with weights for A/B testing
// weight=2 is selected 2x more often than weight=1
const variations = new AdVariationCollection(db);
const varA = await variations.create({
  groupId: group.id,
  name: 'Version A - Blue CTA',
  weight: 2,
  status: 'active',
});

// Track an immutable event (create-only, no update/delete)
const events = new AdEventCollection(db);
await events.create({
  variationId: varA.id,
  zoneId: 'zone-uuid',
  siteId: 'site-uuid',
  eventType: AdEventType.IMPRESSION,
});
```

### Delivery Tier Waterfall

Ads are selected by tier priority (lower number = higher priority):

1. **Sponsorship** (priority 1) -- guaranteed premium placements, FIXED pricing
2. **Standard** (priority 2) -- regular programmatic ads, CPM pricing
3. **House** (priority 3) -- self-promotional fallback ads

Within a tier, variations are selected by relative weight. A variation with `weight: 2` is twice as likely to be chosen as one with `weight: 1`.

## API

### Models

| Export | Description |
|--------|------------|
| `AdDeliveryTier` | Priority tier for waterfall delivery (name, priority, pricingModel) |
| `AdFormat` | IAB standard ad dimensions (width, height, formatType: banner/native/video) |
| `AdGroup` | Campaign with targeting rules, budget, zone restrictions, and date range |
| `AdVariation` | Creative variant within a group with weight for A/B distribution. Denormalized `impressions`/`clicks` counts |
| `AdEvent` | Immutable tracking event (impression/click/conversion). Create-only -- no update/delete. `cli: false` (high-volume) |

### Collections

`AdDeliveryTierCollection`, `AdFormatCollection`, `AdGroupCollection`, `AdVariationCollection`, `AdEventCollection`

### Enums

| Export | Values |
|--------|--------|
| `AdEventType` | `impression`, `click`, `conversion` |
| `AdFormatType` | `banner`, `native`, `video` |
| `AdGroupStatus` | `draft`, `active`, `paused`, `completed` |
| `AdVariationStatus` | `draft`, `active`, `paused` |
| `PricingModel` | `fixed`, `cpm`, `cpc`, `cpa` |

## Dependencies

- `@happyvertical/smrt-core` -- ORM and code generation
- `@happyvertical/smrt-tenancy` -- multi-tenant scoping (optional on AdGroup, AdVariation, AdEvent)
- Peer: `@happyvertical/smrt-assets`, `@happyvertical/smrt-commerce`, `@happyvertical/smrt-properties`, `@happyvertical/smrt-tags`
