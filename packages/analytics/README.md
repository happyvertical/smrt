# @happyvertical/smrt-analytics

Analytics integration models for the SMRT framework. Manages analytics properties (GA4, Plausible), data streams, server-side event tracking, and AI-powered report generation.

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
  AnalyticsProvider
} from '@happyvertical/smrt-analytics';

// Create a property
const properties = new AnalyticsPropertyCollection(db);
const property = await properties.create({
  name: 'Main Site',
  provider: AnalyticsProvider.GA4,
  propertyId: 'G-XXXXXXXX',
  status: 'active',
});
await property.save();

// Add a data stream
const streams = new AnalyticsDataStreamCollection(db);
await streams.create({
  analyticsPropertyId: property.id,
  type: 'web',
  name: 'Web Traffic',
  status: 'active',
});

// Track a server-side event
const events = new AnalyticsEventCollection(db);
await events.create({
  analyticsPropertyId: property.id,
  name: 'purchase',
  status: 'pending',
});
```

## API

### Models

| Export | Description |
|--------|------------|
| `AnalyticsProperty` | Analytics account/property (GA4 or Plausible) |
| `AnalyticsDataStream` | Data stream within a property (web/iOS/Android) |
| `AnalyticsEvent` | Server-side tracking event |
| `AnalyticsReport` | AI-powered analytics report with scheduling |

### Collections

`AnalyticsPropertyCollection`, `AnalyticsDataStreamCollection`, `AnalyticsEventCollection`, `AnalyticsReportCollection`

### Enums

| Export | Description |
|--------|------------|
| `AnalyticsProvider` | Provider type (GA4, Plausible) |
| `AnalyticsPropertyStatus` | Property lifecycle status |
| `DataStreamType` | Stream type |
| `DataStreamStatus` | Stream lifecycle status |
| `TrackingEventStatus` | Event processing status |
| `ReportStatus` | Report generation status |
| `ReportFrequency` | Report scheduling frequency |
| `CountingMethod` | Event counting method |
| `CustomDimensionScope` | Custom dimension scope |

### SDK Types

Re-exports analytics types from `@happyvertical/analytics`: `AnalyticsInterface`, `AnalyticsCapabilities`, `SDKProperty`, `SDKDataStream`, `SDKTrackEvent`, `SDKPageviewEvent`, `SDKReportOptions`, `SDKReportResult`, and more.

## Dependencies

- `@happyvertical/smrt-core` — ORM and code generation
