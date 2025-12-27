# @happyvertical/smrt-ads

Advertising delivery and tracking models for the SMRT framework - ad formats, delivery tiers, ad groups, creative variations, and event tracking.

## Purpose

This package provides SMRT-wrapped models for advertising operations:

- **AdFormat**: Standard IAB ad dimensions (728x90, 300x250, etc.)
- **AdDeliveryTier**: Priority waterfall for ad selection (Sponsorship, Standard, House)
- **AdGroup**: Campaign targeting and budget controls
- **AdVariation**: Creative assets with A/B testing via weighted selection
- **AdEvent**: Immutable event tracking (impressions, clicks, conversions)

## Architecture

```
AdDeliveryTier (priority: 1, 2, 3...)
   ↓
AdGroup (contractId, tierId, targeting, zoneIds, budget)
   ↓
AdVariation (groupId, formatId, assetId, weight)
   ↓
AdEvent (variationId, zoneId, eventType, timestamp)

AdFormat (standalone: width, height, formatType)
```

## Cross-Package References

| Field | Package | Description |
|-------|---------|-------------|
| contractId | smrt-commerce | Campaign contract |
| zoneId | smrt-properties | Ad placement zone |
| siteId | smrt-properties | Site (denormalized) |
| assetId | smrt-assets | Creative asset |
| verticalSlug | smrt-tags | Category targeting |

All cross-package references use plain string IDs (not foreignKey) to avoid circular dependencies.

## Key Concepts

### Ad Delivery Priority

Ads are selected by tier priority (lower number = higher priority):

```typescript
const tiers = await AdDeliveryTierCollection.create(options);

// Create delivery tiers
const sponsorship = await tiers.create({
  name: 'Sponsorship',
  priority: 1,
  pricingModel: PricingModel.FIXED,
  description: 'Premium guaranteed placements'
});

const standard = await tiers.create({
  name: 'Standard',
  priority: 2,
  pricingModel: PricingModel.CPM,
  description: 'Regular programmatic ads'
});

const house = await tiers.create({
  name: 'House',
  priority: 3,
  pricingModel: PricingModel.FIXED,
  description: 'Self-promotional fallback'
});
```

### A/B Testing with Weighted Selection

Ad variations support weighted random selection for A/B testing:

```typescript
const variations = await AdVariationCollection.create(options);

// Create variations with different weights
await variations.create({
  groupId: adGroup.id,
  formatId: leaderboard.id,
  name: 'Version A - Blue CTA',
  weight: 2,  // 2x more likely
  status: AdVariationStatus.ACTIVE
});

await variations.create({
  groupId: adGroup.id,
  formatId: leaderboard.id,
  name: 'Version B - Green CTA',
  weight: 1,  // 1x baseline
  status: AdVariationStatus.ACTIVE
});

// Weighted selection for serving
const selected = await variations.selectByWeight(adGroup.id);
// Version A selected ~67% of time, Version B ~33%
```

### Zone Targeting

AdGroups specify which zones they can serve to:

```typescript
const adGroup = await groups.create({
  name: 'Summer Sale Campaign',
  contractId: 'contract-uuid',
  tierId: sponsorship.id
});

// Set allowed zones
adGroup.setZoneIds(['zone-1', 'zone-2', 'zone-3']);
await adGroup.save();

// Check zone eligibility
if (adGroup.hasZoneId('zone-1')) {
  // Serve ad to zone-1
}

// Query groups for a zone
const eligible = await groups.findEligibleForZone('zone-1');
```

### Immutable Event Tracking

AdEvents are append-only for analytics integrity:

```typescript
const events = await AdEventCollection.create(options);

// Track impression
await events.create({
  variationId: variation.id,
  zoneId: 'zone-uuid',
  siteId: 'site-uuid',
  eventType: AdEventType.IMPRESSION,
  metadata: JSON.stringify({
    ip: '192.168.1.1',
    userAgent: 'Mozilla/5.0...'
  })
});

// Track click
await events.create({
  variationId: variation.id,
  zoneId: 'zone-uuid',
  siteId: 'site-uuid',
  eventType: AdEventType.CLICK
});

// Get stats
const stats = await events.getVariationStats(variation.id);
console.log(stats.impressions);  // 1000
console.log(stats.clicks);       // 25
console.log(stats.ctr);          // 0.025 (2.5%)
```

## Usage

### Basic Setup

```typescript
import {
  AdFormat,
  AdFormatCollection,
  AdDeliveryTier,
  AdDeliveryTierCollection,
  AdGroup,
  AdGroupCollection,
  AdVariation,
  AdVariationCollection,
  AdEvent,
  AdEventCollection,
  AdFormatType,
  PricingModel,
  AdGroupStatus,
  AdVariationStatus,
  AdEventType,
} from '@happyvertical/smrt-ads';

// Create collections with database
const formats = await AdFormatCollection.create({
  persistence: { type: 'sql', url: 'ads.db' }
});

const tiers = await AdDeliveryTierCollection.create({
  persistence: { type: 'sql', url: 'ads.db' }
});

const groups = await AdGroupCollection.create({
  persistence: { type: 'sql', url: 'ads.db' }
});

const variations = await AdVariationCollection.create({
  persistence: { type: 'sql', url: 'ads.db' }
});

const events = await AdEventCollection.create({
  persistence: { type: 'sql', url: 'ads.db' }
});
```

### Creating a Campaign

```typescript
// 1. Define ad format
const leaderboard = await formats.create({
  name: 'Leaderboard',
  width: 728,
  height: 90,
  formatType: AdFormatType.BANNER
});
await leaderboard.save();

// 2. Create delivery tier
const standard = await tiers.create({
  name: 'Standard',
  priority: 2,
  pricingModel: PricingModel.CPM
});
await standard.save();

// 3. Create ad group with targeting
const adGroup = await groups.create({
  contractId: 'contract-uuid',  // from smrt-commerce
  tierId: standard.id,
  name: 'Summer Sale - Desktop',
  verticalSlug: 'retail',       // from smrt-tags
  dailyBudget: 100.00,
  totalBudget: 3000.00,
  startDate: new Date('2024-06-01'),
  endDate: new Date('2024-08-31'),
  status: AdGroupStatus.ACTIVE
});
adGroup.setZoneIds(['zone-1', 'zone-2']);
adGroup.setTargeting({ device: 'desktop', geo: 'US' });
await adGroup.save();

// 4. Create ad variation
const variation = await variations.create({
  groupId: adGroup.id,
  formatId: leaderboard.id,
  assetId: 'asset-uuid',        // from smrt-assets
  name: 'Summer Sale Banner',
  clickUrl: 'https://example.com/summer-sale',
  altText: 'Summer Sale - 50% Off',
  weight: 1,
  status: AdVariationStatus.ACTIVE
});
await variation.save();
```

### Ad Selection Flow

```typescript
// 1. Find eligible groups for zone
const eligibleGroups = await groups.findEligibleForZone('zone-1');

// 2. Sort by tier priority
const sortedGroups = eligibleGroups.sort(
  (a, b) => /* compare tier priorities */
);

// 3. Select variation with weighted random
const selectedVariation = await variations.selectByWeight(sortedGroups[0].id);

// 4. Track impression
await events.create({
  variationId: selectedVariation.id,
  zoneId: 'zone-1',
  siteId: 'site-uuid',
  eventType: AdEventType.IMPRESSION
});

// 5. Return ad to serve
return {
  assetId: selectedVariation.assetId,
  clickUrl: selectedVariation.clickUrl,
  altText: selectedVariation.altText
};
```

## Models Reference

### AdFormat

| Field | Type | Description |
|-------|------|-------------|
| name | string | Display name (e.g., "Leaderboard") |
| width | number | Width in pixels |
| height | number | Height in pixels |
| formatType | AdFormatType | banner, native, video |
| description | string | Optional description |

### AdDeliveryTier

| Field | Type | Description |
|-------|------|-------------|
| name | string | Display name (e.g., "Sponsorship") |
| priority | number | Lower = higher priority (1, 2, 3) |
| pricingModel | PricingModel | fixed, cpm, cpc, cpa |
| description | string | Optional description |

### AdGroup

| Field | Type | Description |
|-------|------|-------------|
| contractId | string | FK to smrt-commerce Contract |
| tierId | foreignKey | FK to AdDeliveryTier |
| name | string | Display name |
| verticalSlug | string | Tag slug from smrt-tags |
| targeting | string | JSON targeting rules |
| zoneIds | string | JSON array of Zone IDs |
| startDate | Date | Campaign start |
| endDate | Date | Campaign end |
| dailyBudget | number | Daily spend limit |
| totalBudget | number | Total spend limit |
| status | AdGroupStatus | draft, active, paused, completed |

### AdVariation

| Field | Type | Description |
|-------|------|-------------|
| groupId | foreignKey | FK to AdGroup |
| formatId | foreignKey | FK to AdFormat |
| assetId | string | FK to smrt-assets Asset |
| name | string | Display name |
| clickUrl | string | Click destination URL |
| altText | string | Accessibility text |
| weight | number | A/B test weight (higher = more likely) |
| status | AdVariationStatus | draft, active, paused |
| impressions | number | Denormalized count |
| clicks | number | Denormalized count |

### AdEvent

| Field | Type | Description |
|-------|------|-------------|
| variationId | foreignKey | FK to AdVariation |
| zoneId | string | FK to smrt-properties Zone |
| siteId | string | Denormalized Site ID |
| eventType | AdEventType | impression, click, conversion |
| timestamp | Date | Event time |
| metadata | string | JSON analytics data |

## Collections

All collections extend `SmrtCollection` and provide:

### AdFormatCollection
- `findByDimensions(width, height)` - Find by size
- `findByType(formatType)` - Filter by type
- `findBanners()`, `findNative()`, `findVideo()` - Type helpers

### AdDeliveryTierCollection
- `findByPriority()` - Ordered by priority ASC
- `findByPricingModel(model)` - Filter by pricing
- `getHighestPriority()` - Get top tier
- `findFixedPricing()`, `findCPM()`, `findPerformanceBased()` - Pricing helpers

### AdGroupCollection
- `findByContract(contractId)` - Groups for campaign
- `findByTier(tierId)` - Groups in tier
- `findByStatus(status)` - Filter by status
- `findActive()` - Active with valid dates
- `findByVertical(verticalSlug)` - Groups targeting vertical
- `findByZone(zoneId)` - Groups that can serve to zone
- `findEligibleForZone(zoneId)` - Active groups for zone

### AdVariationCollection
- `findByGroup(groupId)` - Variations in group
- `findByFormat(formatId)` - Variations with format
- `findActiveByGroup(groupId)` - Active in group
- `selectByWeight(groupId)` - **Weighted random selection**
- `findTopPerformers(limit)` - Best CTR

### AdEventCollection
- `findByVariation(variationId)` - Events for variation
- `findByZone(zoneId)` - Events for zone
- `findBySite(siteId)` - Events for site
- `findByDateRange(start, end)` - Events in range
- `countByType(variationId, type)` - Count events
- `getVariationStats(variationId)` - Full stats object

## Testing

```bash
# Generate manifest and run tests
pnpm run test

# Or run manually
pnpm run generate:test
npx vitest run
```

## Dependencies

- `@happyvertical/smrt-core`: SMRT framework
- `@happyvertical/smrt-commerce` (peer): Contract references
- `@happyvertical/smrt-properties` (peer): Zone references
- `@happyvertical/smrt-assets` (peer): Asset references
- `@happyvertical/smrt-tags` (peer): Vertical targeting
