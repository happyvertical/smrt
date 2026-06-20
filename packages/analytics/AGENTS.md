# @happyvertical/smrt-analytics

GA4/Plausible/Matomo analytics integration with server-side event tracking and AI-powered reporting.

## Models

- **AnalyticsProperty**: GA4 property, Plausible site, or Matomo site. Provider metadata, status, sync timestamps.
- **AnalyticsDataStream**: web/iOS/Android data streams. Measurement IDs (G-XXXXXX for GA4, Firebase app ID for mobile).
- **AnalyticsEvent**: tracked events with params (JSON), retry queue, conversion classification.
- **AnalyticsReport**: saved report configs with dimensions/metrics (JSON), scheduling (daily/weekly/monthly), result caching.

All models use STI (`tableStrategy: 'sti'`).

All four persisted models are `@TenantScoped({ mode: 'optional' })` with a nullable `tenantId` (#1410), matching the framework convention used by sibling domain packages (ads/jobs/commerce). **When a tenant context is active**, the interceptor auto-filters `list`/`get`/raw reads and binds `create`/`save` writes to that tenant, keeping one tenant's properties, data streams, events (end-user PII), and cached report rows from reaching another. Because the mode is `optional`, the interceptor intentionally passes **through unfiltered when no tenant context is established** — so a surface is only safe insofar as it establishes tenant context first. Generated SvelteKit routes do this (#1540); the CLI/MCP code paths do not yet, which is a known framework-level residual (fail-closed tenant context for CLI/MCP) tracked outside this package, not an analytics-specific gap.

## Key Collection Methods

`findByExternalId()`, `findByProvider()`, `findNeedingSync()`, `findGA4Properties()`, `findPlausibleSites()`, `findMatomoSites()`

## AI Operations

`analyzePerformance()`, `analyzeResults()`, `hasPositiveTrends()` route through registered prompts (see Prompt Registry below) so tenant overrides apply via `resolvePrompt()`. `isPerformingWell()` still uses the inline `is()` shortcut.

## Prompt Registry

Three prompts are registered at module-load time via `definePrompt()` from `@happyvertical/smrt-prompts`. Re-exported from the package root for tenant override targeting.

| Key | Method | Variables (PII-conscious) |
|-----|--------|---------------------------|
| `smrtAnalytics.property.analyzePerformance` | `AnalyticsProperty.analyzePerformance()` | `period`, `propertyDisplayName`, `propertyProvider` |
| `smrtAnalytics.report.analyzeResults` | `AnalyticsReport.analyzeResults()` | `reportName`, `reportDimensions`, `reportMetrics`, `dateRangeStart`, `dateRangeEnd`, `rowCount`, `reportData` |
| `smrtAnalytics.report.hasPositiveTrends` | `AnalyticsReport.hasPositiveTrends()` | `reportMetrics`, `reportData` |

**Excluded from variables (never reach the AI provider):**
- `id`, `propertyId`, `tenantId`, `externalId` — internal foreign keys / UUIDs that link to identifying records.
- `apiSecret`, `measurementId`, `siteDomain` — provider credentials and platform-specific identifiers (GA4 API secrets, Matomo `idSite`, custom `G-XXXX` measurement IDs).
- `providerMetadata` — extensible JSON blob that may contain credentials, account IDs, or other configuration secrets.
- `lastError`, raw `dimensionFilter` / `metricFilter` JSON — internal error strings (may contain auth tokens) and filter expressions that may reference cookie IDs, user-pseudo-IDs, or IP-derived geos.

**`resultData` is forwarded verbatim.** This package does not — and cannot — strip PII from result rows, because the row schema is determined by the dimensions/metrics the caller asked the analytics provider to return. If the caller persists rows containing a `userPseudoId`, `clientId`, IP-derived geolocation, or any other identifier, those fields WILL reach the AI provider. Callers must:

- exclude PII-bearing dimensions before persisting `resultData` (e.g. don't request `userPseudoId` as a GA4 dimension), or
- apply a column allowlist at the call site before invoking `analyzeResults()`, or
- override the prompt template via `PromptOverride` to redact rows.

The forwarding contract is pinned by a regression test in `src/__tests__/analytics-report-prompt.test.ts`.

See `src/prompts.ts` for the full rationale block.

## UI Registry

Svelte components live in `src/svelte/` and auto-register with `ModuleUIRegistry` from `@happyvertical/smrt-svelte/registry` when `@happyvertical/smrt-analytics/svelte` is imported.

Slot declarations live in `src/ui.ts`, exported via the `./ui` package subpath. The slots are: `analytics-summary`, `events-table`, `property-info`, `property-status-badge`, `stat-card`, `trend-badge` (see `ANALYTICS_UI_SLOTS` for icons / categories / display order).

```typescript
import '@happyvertical/smrt-analytics/svelte'; // side-effect: registers slots
import { ModuleUIRegistry } from '@happyvertical/smrt-svelte/registry';
const StatCard = ModuleUIRegistry.get('@happyvertical/smrt-analytics', 'stat-card');
```

## Gotchas

- **`apiSecret` / `providerMetadata` stripped from API/MCP**: marked `@field({ sensitive: true })` (#1540) so they never appear in generated responses or `where` filters. They are still stored at rest **unencrypted** — envelope encryption via `@happyvertical/smrt-secrets` is a separate, breaking follow-up (tracked, not done here).
- **Event retry at model level**: no background job integration
- **JSON fields**: params, dimensions, metrics use string storage with getter/setter helpers
- **Measurement IDs differ per platform**: G-XXXXXX (GA4 web) vs Firebase app ID (mobile)
- **`analyzeResults` is now a single AI call**: previously issued a second freeform `do()` to summarize "top 3 insights"; folded into the registered template, and `insights` mirrors `analysis` in the response shape.
