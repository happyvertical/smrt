# @happyvertical/smrt-ads

Advertising delivery and tracking models for the SMRT framework. Supports priority-based ad group delivery, weighted A/B variation testing, and immutable event tracking (impressions, clicks, conversions).

## Installation

```bash
pnpm add @happyvertical/smrt-ads
```

## Usage

```typescript
import {
  AdGroup, AdGroupCollection,
  AdVariation, AdVariationCollection,
  AdEvent, AdEventCollection,
  AdEventType, PricingModel
} from '@happyvertical/smrt-ads';

// Create an ad group
const groups = new AdGroupCollection(db);
const group = await groups.create({
  name: 'Holiday Campaign',
  status: 'active',
  pricingModel: PricingModel.CPM,
});
await group.save();

// Add variations with weights for A/B testing
const variations = new AdVariationCollection(db);
const varA = await variations.create({
  adGroupId: group.id,
  name: 'Version A',
  weight: 70,
  status: 'active',
});
await varA.save();

// Track events
const events = new AdEventCollection(db);
await events.create({
  adVariationId: varA.id,
  eventType: AdEventType.Impression,
});
```

## API

### Models

| Export | Description |
|--------|------------|
| `AdGroup` | Campaign grouping with status, priority, and pricing model |
| `AdVariation` | Creative variant within a group with weight for A/B distribution |
| `AdEvent` | Immutable tracking event (impression/click/conversion) |
| `AdFormat` | Ad format specification (banner/native/video) |
| `AdDeliveryTier` | Priority tier for waterfall delivery |

### Collections

`AdGroupCollection`, `AdVariationCollection`, `AdEventCollection`, `AdFormatCollection`, `AdDeliveryTierCollection`

### Enums

| Export | Values |
|--------|--------|
| `AdEventType` | `impression`, `click`, `conversion` |
| `AdFormatType` | `banner`, `native`, `video` |
| `AdGroupStatus` | `draft`, `active`, `paused`, `completed` |
| `AdVariationStatus` | `draft`, `active`, `paused` |
| `PricingModel` | `fixed`, `cpm`, `cpc`, `cpa` |

## Dependencies

- `@happyvertical/smrt-core` — ORM and code generation
- `@happyvertical/smrt-tenancy` — multi-tenant scoping
- Peer: `@happyvertical/smrt-assets`, `@happyvertical/smrt-commerce`, `@happyvertical/smrt-properties`, `@happyvertical/smrt-tags`
