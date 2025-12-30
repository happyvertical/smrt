# @happyvertical/smrt-analytics

Analytics integration models for the SMRT framework - properties, data streams, reports, and event tracking with integration to @happyvertical/analytics SDK.

## Purpose

This package provides SMRT-wrapped models for analytics operations:

- **AnalyticsProperty**: Represents a GA4 property or Plausible site
- **AnalyticsDataStream**: Data streams (web, iOS, Android) for properties
- **AnalyticsReport**: Saved report configurations with scheduling
- **AnalyticsEvent**: Server-side event tracking log

## Architecture

```
AnalyticsProperty (GA4/Plausible)
   ↓
AnalyticsDataStream (web, iOS, Android)
   ↓
AnalyticsEvent (tracked events)
   ↓
AnalyticsReport (scheduled reports)
```

## Integration with SDK

This package integrates with `@happyvertical/analytics` SDK for actual provider communication:

```typescript
import { getAnalytics } from '@happyvertical/analytics';
import { AnalyticsPropertyCollection } from '@happyvertical/smrt-analytics';

// Create SDK client
const analytics = await getAnalytics({
  type: 'ga4',
  serviceAccountKey: '/path/to/key.json',
  measurementId: 'G-XXXXXXXXXX',
  apiSecret: 'your-secret'
});

// Use SMRT collection for persistence
const properties = await AnalyticsPropertyCollection.create({
  persistence: { type: 'sql', url: 'analytics.db' }
});

// Sync property from provider
const sdkProperty = await analytics.getProperty('123456789');
const property = await properties.create({
  name: sdkProperty.name,
  displayName: sdkProperty.displayName,
  provider: AnalyticsProvider.GA4,
  externalId: sdkProperty.id,
  measurementId: 'G-XXXXXXXXXX'
});
await property.save();
```

## Key Concepts

### Analytics Providers

Supports both GA4 and Plausible analytics:

```typescript
import { AnalyticsProvider } from '@happyvertical/smrt-analytics';

// GA4 property
const ga4Property = await properties.create({
  name: 'properties/123456789',
  displayName: 'My Website',
  provider: AnalyticsProvider.GA4,
  externalId: 'properties/123456789',
  measurementId: 'G-XXXXXXXXXX',
  apiSecret: 'your-api-secret'
});

// Plausible site
const plausibleSite = await properties.create({
  name: 'example.com',
  displayName: 'Example Site',
  provider: AnalyticsProvider.PLAUSIBLE,
  siteDomain: 'example.com'
});
```

### Data Streams

Track data collection sources:

```typescript
import { DataStreamType } from '@happyvertical/smrt-analytics';

// Web stream
const webStream = await streams.create({
  propertyId: property.id,
  displayName: 'Web Traffic',
  streamType: DataStreamType.WEB,
  measurementId: 'G-XXXXXXXXXX',
  defaultUri: 'https://example.com'
});

// Mobile app stream
const iosStream = await streams.create({
  propertyId: property.id,
  displayName: 'iOS App',
  streamType: DataStreamType.IOS,
  firebaseAppId: '1:123456789:ios:abc123',
  bundleId: 'com.example.app'
});
```

### Scheduled Reports

Create and schedule recurring reports:

```typescript
import { ReportFrequency, ReportStatus } from '@happyvertical/smrt-analytics';

const report = await reports.create({
  propertyId: property.id,
  name: 'Weekly Traffic Report',
  frequency: ReportFrequency.WEEKLY,
  status: ReportStatus.SCHEDULED
});

// Configure report dimensions/metrics
report.setDimensions([
  { name: 'country' },
  { name: 'deviceCategory' }
]);
report.setMetrics([
  { name: 'activeUsers' },
  { name: 'sessions' },
  { name: 'bounceRate' }
]);
report.dateRangeStart = '7daysAgo';
report.dateRangeEnd = 'today';
await report.save();

// Find reports due to run
const dueReports = await reports.findDue();
```

### Event Tracking

Log server-side events for later sending:

```typescript
import { TrackingEventStatus } from '@happyvertical/smrt-analytics';

// Create event
const event = await events.create({
  propertyId: property.id,
  eventName: 'purchase',
  clientId: 'user-123',
  userId: 'identified-user-456'
});
event.setParams({
  value: 99.99,
  currency: 'USD',
  transaction_id: 'order-789'
});
await event.save();

// Find pending events to send
const pending = await events.findPending();
for (const evt of pending) {
  try {
    await analytics.track(evt.toTrackEvent());
    evt.markSent();
  } catch (error) {
    evt.markFailed(error.message);
  }
  await evt.save();
}
```

## Usage

### Basic Setup

```typescript
import {
  AnalyticsProperty,
  AnalyticsPropertyCollection,
  AnalyticsDataStream,
  AnalyticsDataStreamCollection,
  AnalyticsReport,
  AnalyticsReportCollection,
  AnalyticsEvent,
  AnalyticsEventCollection,
  AnalyticsProvider,
  DataStreamType,
  ReportFrequency,
  ReportStatus,
  TrackingEventStatus,
} from '@happyvertical/smrt-analytics';

// Create collections with database
const properties = await AnalyticsPropertyCollection.create({
  persistence: { type: 'sql', url: 'analytics.db' }
});

const streams = await AnalyticsDataStreamCollection.create({
  persistence: { type: 'sql', url: 'analytics.db' }
});

const reports = await AnalyticsReportCollection.create({
  persistence: { type: 'sql', url: 'analytics.db' }
});

const events = await AnalyticsEventCollection.create({
  persistence: { type: 'sql', url: 'analytics.db' }
});
```

### AI-Powered Analysis

SMRT objects include AI-powered methods:

```typescript
// Analyze property performance
const analysis = await property.analyzePerformance({ period: '30 days' });
console.log(analysis.analysis);

// Check if property is configured well
const isConfigured = await property.isPerformingWell();

// Analyze report results
const report = await reports.get(reportId);
const insights = await report.analyzeResults();
console.log(insights.insights);

// Check for positive trends
const hasGrowth = await report.hasPositiveTrends();
```

## Models Reference

### AnalyticsProperty

| Field | Type | Description |
|-------|------|-------------|
| name | string | Internal name/identifier |
| displayName | string | Human-readable display name |
| provider | AnalyticsProvider | ga4 or plausible |
| externalId | string | Provider's property ID |
| measurementId | string | GA4 measurement ID (G-XXXXXXXX) |
| apiSecret | string | GA4 API secret for tracking |
| siteDomain | string | Plausible site domain |
| timeZone | string | Property timezone |
| currencyCode | string | Currency code (USD, EUR) |
| status | AnalyticsPropertyStatus | active, inactive, pending |
| lastSyncAt | Date | Last sync with provider |
| providerMetadata | string | JSON metadata from provider |

### AnalyticsDataStream

| Field | Type | Description |
|-------|------|-------------|
| propertyId | foreignKey | Parent property |
| displayName | string | Stream display name |
| streamType | DataStreamType | WEB, ANDROID, IOS |
| externalId | string | Provider's stream ID |
| measurementId | string | Web stream measurement ID |
| firebaseAppId | string | App stream Firebase ID |
| defaultUri | string | Default URI for web streams |
| bundleId | string | iOS bundle ID |
| packageName | string | Android package name |
| status | DataStreamStatus | active, inactive |
| enhancedMeasurement | boolean | Enhanced measurement enabled |

### AnalyticsReport

| Field | Type | Description |
|-------|------|-------------|
| propertyId | foreignKey | Parent property |
| name | string | Report name |
| description | string | Report description |
| dimensions | string | JSON array of dimensions |
| metrics | string | JSON array of metrics |
| dateRangeStart | string | Start date (relative or absolute) |
| dateRangeEnd | string | End date (relative or absolute) |
| dimensionFilter | string | JSON filter expression |
| metricFilter | string | JSON filter expression |
| orderBy | string | JSON sort order |
| maxResults | number | Max results |
| status | ReportStatus | draft, scheduled, running, completed, failed |
| frequency | ReportFrequency | once, daily, weekly, monthly |
| lastRunAt | Date | Last execution timestamp |
| nextRunAt | Date | Next scheduled run |
| resultData | string | JSON cached results |
| rowCount | number | Result row count |
| lastError | string | Error from last failure |

### AnalyticsEvent

| Field | Type | Description |
|-------|------|-------------|
| propertyId | foreignKey | Parent property |
| eventName | string | Event name (purchase, page_view, etc.) |
| clientId | string | Anonymous client ID |
| userId | string | Identified user ID |
| params | string | JSON event parameters |
| eventTimestamp | Date | Event timestamp |
| status | TrackingEventStatus | pending, sent, failed |
| sentAt | Date | When sent to provider |
| errorMessage | string | Error if failed |
| retryCount | number | Retry attempts |
| nonPersonalizedAds | boolean | Disable personalized ads |
| sessionId | string | Session identifier |
| pagePath | string | Page path for pageviews |
| pageTitle | string | Page title for pageviews |
| userAgent | string | Browser user agent |
| ipAddress | string | Anonymized IP |

## Collections

All collections extend `SmrtCollection` and provide:

### AnalyticsPropertyCollection
- `findByExternalId(externalId)` - Find by provider ID
- `findByMeasurementId(measurementId)` - Find by GA4 measurement ID
- `findBySiteDomain(siteDomain)` - Find by Plausible domain
- `findByProvider(provider)` - Filter by provider type
- `findGA4Properties()` - All GA4 properties
- `findPlausibleSites()` - All Plausible sites
- `findActive()` - Active properties
- `findNeedingSync(hoursAgo)` - Properties needing sync

### AnalyticsDataStreamCollection
- `findByProperty(propertyId)` - Streams for property
- `findByExternalId(externalId)` - Find by provider ID
- `findByMeasurementId(measurementId)` - Find by measurement ID
- `findByType(streamType)` - Filter by type
- `findWebStreams()` - All web streams
- `findIOSStreams()` - All iOS streams
- `findAndroidStreams()` - All Android streams
- `findMobileStreams()` - iOS + Android streams
- `findActive()` - Active streams
- `findActiveByProperty(propertyId)` - Active streams for property

### AnalyticsReportCollection
- `findByProperty(propertyId)` - Reports for property
- `findByStatus(status)` - Filter by status
- `findDrafts()` - Draft reports
- `findScheduled()` - Scheduled reports
- `findCompleted()` - Completed reports
- `findFailed()` - Failed reports
- `findByFrequency(frequency)` - Filter by frequency
- `findRecurring()` - Non-once reports
- `findDue()` - Reports due to run
- `findRecentlyRun(hoursAgo)` - Recently executed

### AnalyticsEventCollection
- `findByProperty(propertyId)` - Events for property
- `findByEventName(eventName)` - Filter by event name
- `findByClientId(clientId)` - Events for client
- `findByUserId(userId)` - Events for user
- `findByStatus(status)` - Filter by status
- `findPending()` - Pending events
- `findSent()` - Sent events
- `findFailed()` - Failed events
- `findForRetry(maxRetries)` - Events eligible for retry
- `findPendingByProperty(propertyId)` - Pending for property
- `findByDateRange(start, end)` - Events in date range
- `findConversions(propertyId?)` - Conversion events
- `findPageviews(propertyId?)` - Pageview events
- `countByEventName(propertyId)` - Event counts
- `getPropertyStats(propertyId)` - Event statistics

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
- `@happyvertical/analytics` (peer): Analytics SDK for provider communication

## Environment Variables

Configure via environment or smrt.config:

```bash
# For GA4
GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json
GA4_MEASUREMENT_ID=G-XXXXXXXXXX
GA4_API_SECRET=your-secret

# For Plausible
PLAUSIBLE_API_KEY=your-api-key
PLAUSIBLE_BASE_URL=https://plausible.io  # Optional for self-hosted
```

## Future Enhancements

- Auto-sync properties from providers
- Real-time report execution with SDK integration
- Batch event sending with retry queue
- Custom dimension/metric management
- Key event (conversion) configuration
