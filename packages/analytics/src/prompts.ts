/**
 * Prompt registrations for the @happyvertical/smrt-analytics package.
 *
 * Prompts are registered at module-load time via `definePrompt()` so that
 * tenant-aware overrides can be applied at call time via `resolvePrompt()`.
 *
 * Mirrors the pattern used by `@happyvertical/smrt-properties` (see
 * `prompts.ts`) and `@happyvertical/smrt-content` (see `content-prompts.ts`).
 *
 * PII / internal-field exclusion policy:
 * The variables sent to the AI provider deliberately exclude:
 *   - `id`, `tenantId`, `propertyId` and other foreign-key/UUID fields —
 *     they identify internal records and provide no analytic value.
 *   - `apiSecret`, `measurementId`, `externalId`, `siteDomain` — these are
 *     provider credentials or platform-specific identifiers (e.g. GA4 API
 *     secrets, Matomo `idSite`, custom `G-XXXX` measurement IDs) that may
 *     be tenant-private configuration.
 *   - `providerMetadata` — extensible JSON blob that may contain
 *     credentials, account IDs, or other configuration secrets.
 *   - `lastError`, `dimensionFilter`, `metricFilter`, `resultData` raw
 *     payloads — only aggregate counts and computed deltas are passed; the
 *     raw rows can include cookie IDs, user-pseudo-IDs, IP-derived geos,
 *     and other PII the analytics provider returned.
 *
 * Acceptable variables: human-readable names, time periods, computed
 * aggregates (row counts, totals), and high-level dimension/metric labels.
 * If a downstream tenant needs richer context they can override the
 * template via PromptOverride.
 */

import {
  definePrompt,
  type ResolvedPromptAI,
} from '@happyvertical/smrt-prompts';

/**
 * `AnalyticsProperty.analyzePerformance()` prompt. Only the human-readable
 * display name, provider label, and the requested period reach the model;
 * provider IDs, API secrets, and the providerMetadata blob are excluded.
 */
export const smrtAnalyticsAnalyzePerformancePrompt = definePrompt({
  key: 'smrtAnalytics.property.analyzePerformance',
  template: `Analyze the analytics performance for this property over the last {period}.
Consider: traffic trends, user engagement, conversion patterns.
Property: {propertyDisplayName} ({propertyProvider})`,
  editable: {
    template: true,
    profile: true,
    model: true,
    params: true,
  },
});

/**
 * `AnalyticsReport.analyzeResults()` prompt. Surfaces report name, the
 * dimension/metric labels (which are public GA4/Plausible/Matomo schema
 * names — not user data), the date-range window, and the row count plus
 * a JSON-stringified `resultData` blob.
 *
 * **`resultData` is forwarded verbatim.** This package does not strip PII
 * from result rows — it cannot, because the row schema is determined by
 * the dimensions/metrics the caller asked the analytics provider to
 * return. If the caller persists rows containing a `userPseudoId`,
 * `clientId`, IP-derived geolocation, or any other identifier, those
 * fields WILL reach the AI provider. Either:
 *
 *   - exclude PII-bearing dimensions before persisting `resultData`
 *     (e.g. don't request `userPseudoId` as a GA4 dimension), or
 *   - apply a column allowlist at the call site before invoking
 *     `analyzeResults()`, or
 *   - override the prompt template via `PromptOverride` to redact rows.
 *
 * The forwarding contract is pinned by a regression test in
 * `__tests__/analytics-report-prompt.test.ts`.
 */
export const smrtAnalyticsAnalyzeResultsPrompt = definePrompt({
  key: 'smrtAnalytics.report.analyzeResults',
  template: `Analyze these analytics report results and provide insights:

Report: {reportName}
Dimensions: {reportDimensions}
Metrics: {reportMetrics}
Date Range: {dateRangeStart} to {dateRangeEnd}
Row Count: {rowCount}

Data: {reportData}

Provide:
1. Key findings
2. Trends or patterns
3. Actionable recommendations`,
  editable: {
    template: true,
    profile: true,
    model: true,
    params: true,
  },
});

/**
 * `AnalyticsReport.hasPositiveTrends()` boolean classifier prompt. Same
 * variables as `analyzeResults` minus the descriptive name — only the
 * provider-schema metric labels and the aggregate `resultData` payload are
 * needed to decide whether the trend is positive.
 */
export const smrtAnalyticsHasPositiveTrendsPrompt = definePrompt({
  key: 'smrtAnalytics.report.hasPositiveTrends',
  template: `Based on these report results, are the metrics showing positive trends?

Metrics: {reportMetrics}
Data: {reportData}

Consider: user growth, engagement, conversions as positive indicators.`,
  editable: {
    template: true,
    profile: true,
    model: true,
    params: true,
  },
});

/**
 * Build the message-options object passed to `aiClient.message()` from a
 * `ResolvedPromptAI` shape. Mirrors the helper in `smrt-properties` and
 * `smrt-content` so behavior across packages is identical.
 */
export function promptMessageOptions(ai: ResolvedPromptAI) {
  return {
    ...(ai.params || {}),
    ...(ai.model ? { model: ai.model } : {}),
    ...(typeof ai.temperature === 'number'
      ? { temperature: ai.temperature }
      : {}),
    ...(typeof ai.maxTokens === 'number' ? { maxTokens: ai.maxTokens } : {}),
  };
}
