# @happyvertical/smrt-analytics

GA4/Plausible/Matomo analytics integration with server-side event tracking and AI-powered reporting.

## Models

- **AnalyticsProperty**: GA4 property, Plausible site, or Matomo site. Provider metadata, status, sync timestamps.
- **AnalyticsDataStream**: web/iOS/Android data streams. Measurement IDs (G-XXXXXX for GA4, Firebase app ID for mobile).
- **AnalyticsEvent**: tracked events with params (JSON), retry queue, conversion classification.
- **AnalyticsReport**: saved report configs with dimensions/metrics (JSON), scheduling (daily/weekly/monthly), result caching.

All models use STI (`tableStrategy: 'sti'`).

## Key Collection Methods

`findByExternalId()`, `findByProvider()`, `findNeedingSync()`, `findGA4Properties()`, `findPlausibleSites()`, `findMatomoSites()`

## AI Operations

`analyzePerformance()`, `isPerformingWell()`, `analyzeResults()`, `hasPositiveTrends()` — uses `do()` and `is()`.

## Gotchas

- **Tokens stored plaintext**: GA4 API secrets in DB — no encryption yet
- **Event retry at model level**: no background job integration
- **JSON fields**: params, dimensions, metrics use string storage with getter/setter helpers
- **Measurement IDs differ per platform**: G-XXXXXX (GA4 web) vs Firebase app ID (mobile)
