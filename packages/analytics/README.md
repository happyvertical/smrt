# @happyvertical/smrt-analytics

Analytics integration models for the SMRT framework. Manages analytics properties (GA4, Plausible), data streams, server-side event tracking with retry support, and AI-powered report generation with scheduling.

## Installation

```bash
pnpm add @happyvertical/smrt-analytics
```

## Usage

```typescript
import {
  AnalyticsProperty, AnalyticsPropertyCollection,
  AnalyticsDataStream, AnalyticsDataStreamCollection,
  AnalyticsEvent, AnalyticsEventCollection,
  AnalyticsReport, AnalyticsReportCollection,
  AnalyticsProvider, DataStreamType, ReportFrequency
} from '@happyvertical/smrt-analytics';

// Create a GA4 property
const properties = new AnalyticsPropertyCollection(db);
const property = await properties.create({
  name: 'main-site',
  displayName: 'Main Site Analytics',
  provider: AnalyticsProvider.GA4,
  externalId: 'properties/123456789',
  measurementId: 'G-XXXXXXXXXX',
  apiSecret: 'server-side-secret',
  status: 'active',
});

// Add a web data stream
const streams = new AnalyticsDataStreamCollection(db);
await streams.create({
  propertyId: property.id,
  displayName: 'Web Traffic',
  streamType: DataStreamType.WEB,
  measurementId: 'G-XXXXXXXXXX',
  defaultUri: 'https://example.com',
  status: 'active',
});

// Track a server-side event with retry support
const events = new AnalyticsEventCollection(db);
const event = await events.create({
  propertyId: property.id,
  eventName: 'purchase',
  clientId: 'client-uuid',
  params: JSON.stringify({ value: 99.99, currency: 'USD' }),
  status: 'pending',
});
// After sending: event.markSent() or event.markFailed('timeout')
// Retry logic: event.shouldRetry(3) checks retryCount < maxRetries

// Create a scheduled report with dimensions and metrics
const reports = new AnalyticsReportCollection(db);
const report = await reports.create({
  propertyId: property.id,
  name: 'Weekly Traffic Report',
  dimensions: JSON.stringify([{ name: 'country' }, { name: 'deviceCategory' }]),
  metrics: JSON.stringify([{ name: 'activeUsers' }, { name: 'sessions' }]),
  dateRangeStart: '7daysAgo',
  dateRangeEnd: 'today',
  frequency: ReportFrequency.WEEKLY,
});

// AI-powered operations (uses do() and is() from SmrtObject)
const analysis = await property.analyzePerformance({ period: '30 days' });
const isHealthy = await property.isPerformingWell();
const insights = await report.analyzeResults();
const trending = await report.hasPositiveTrends();
```

### Server-Side Event Lifecycle

Events track their delivery status with built-in retry support:

1. **PENDING** -- created, not yet sent to provider
2. **SENT** -- successfully delivered (`markSent()` sets `sentAt` timestamp)
3. **FAILED** -- delivery failed (`markFailed(error)` increments `retryCount`)

Use `shouldRetry(maxRetries)` to check if a failed event should be retried, and `resetForRetry()` to reset it to PENDING.

### Report Scheduling

Reports support automatic scheduling via `ReportFrequency`:

- `ONCE` -- single run, no rescheduling
- `DAILY` / `WEEKLY` / `MONTHLY` -- `calculateNextRun()` sets `nextRunAt` after each run

Use `isDue()` to check if a scheduled report needs to run.

## API

### Models

| Export | Description |
|--------|------------|
| `AnalyticsProperty` | GA4 property or Plausible site. AI methods: `analyzePerformance()`, `isPerformingWell()` |
| `AnalyticsDataStream` | Data stream within a property (web/iOS/Android). `getPlatformId()` returns measurementId or firebaseAppId |
| `AnalyticsEvent` | Server-side tracking event with retry queue. `toTrackEvent()` builds SDK payload |
| `AnalyticsReport` | Saved report config with dimensions/metrics, scheduling, result caching. AI methods: `analyzeResults()`, `hasPositiveTrends()` |

### Collections

`AnalyticsPropertyCollection`, `AnalyticsDataStreamCollection`, `AnalyticsEventCollection`, `AnalyticsReportCollection`

### Enums

| Export | Description |
|--------|------------|
| `AnalyticsProvider` | `ga4`, `plausible` |
| `AnalyticsPropertyStatus` | `active`, `inactive`, `pending` |
| `DataStreamType` | `WEB_DATA_STREAM`, `ANDROID_APP_DATA_STREAM`, `IOS_APP_DATA_STREAM` |
| `DataStreamStatus` | `active`, `inactive` |
| `TrackingEventStatus` | `pending`, `sent`, `failed` |
| `ReportStatus` | `draft`, `scheduled`, `running`, `completed`, `failed` |
| `ReportFrequency` | `once`, `daily`, `weekly`, `monthly` |
| `CountingMethod` | `ONCE_PER_EVENT`, `ONCE_PER_SESSION` |
| `CustomDimensionScope` | `EVENT`, `USER`, `ITEM` |

### SDK Types

Re-exported from `./types` for SDK compatibility: `AnalyticsInterface`, `AnalyticsCapabilities`, `SDKProperty`, `SDKDataStream`, `SDKTrackEvent`, `SDKPageviewEvent`, `SDKReportOptions`, `SDKReportResult`, `SDKCustomDimension`, `SDKCustomMetric`, `SDKKeyEvent`, `PropertyStatsWithTrend`.

## Dependencies

- `@happyvertical/smrt-core` -- ORM and code generation
- Peer: `svelte` (optional, for Svelte components via `@happyvertical/smrt-analytics/svelte`)
