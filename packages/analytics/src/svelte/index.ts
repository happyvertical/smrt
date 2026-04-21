/**
 * Svelte components for analytics dashboards.
 *
 * @example
 * ```svelte
 * <script>
 *   import { AnalyticsSummary, PropertyInfo, EventsTable } from '@happyvertical/smrt-analytics/svelte';
 * </script>
 * ```
 *
 * @packageDocumentation
 */

// Self-register this package's manifest for consumers that import via this
// subpath without the main entry. See src/__smrt-register__.ts (issue #1132).
import '../__smrt-register__.js';

export { default as AnalyticsSummary } from './AnalyticsSummary.svelte';
export { default as EventsTable } from './EventsTable.svelte';
export { default as PropertyInfo } from './PropertyInfo.svelte';
export { default as PropertyStatusBadge } from './PropertyStatusBadge.svelte';
export { default as StatCard } from './StatCard.svelte';
export { default as TrendBadge } from './TrendBadge.svelte';
