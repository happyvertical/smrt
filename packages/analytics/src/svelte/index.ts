/**
 * Analytics Module Svelte Components
 *
 * Optional Svelte UI components for analytics dashboards. Auto-registers
 * components with `ModuleUIRegistry` on import.
 *
 * @example Direct imports
 * ```typescript
 * import { AnalyticsSummary, EventsTable } from '@happyvertical/smrt-analytics/svelte';
 * ```
 *
 * @example Registry-based discovery
 * ```typescript
 * import { ModuleUIRegistry } from '@happyvertical/smrt-svelte/registry';
 * import '@happyvertical/smrt-analytics/svelte'; // Auto-registers components
 *
 * const Component = ModuleUIRegistry.get('@happyvertical/smrt-analytics', 'analytics-summary');
 * ```
 *
 * @packageDocumentation
 */

import { ModuleUIRegistry } from '@happyvertical/smrt-svelte/registry';
import { ANALYTICS_MODULE_META } from '../ui.js';
import AnalyticsSummary from './AnalyticsSummary.svelte';
import EventsTable from './EventsTable.svelte';
import PropertyInfo from './PropertyInfo.svelte';
import PropertyStatusBadge from './PropertyStatusBadge.svelte';
import StatCard from './StatCard.svelte';
import TrendBadge from './TrendBadge.svelte';

// Export components
export {
  AnalyticsSummary,
  EventsTable,
  PropertyInfo,
  PropertyStatusBadge,
  StatCard,
  TrendBadge,
};

// Auto-register module and components with ModuleUIRegistry
ModuleUIRegistry.registerModule(ANALYTICS_MODULE_META);
ModuleUIRegistry.register(
  '@happyvertical/smrt-analytics',
  'analytics-summary',
  AnalyticsSummary,
);
ModuleUIRegistry.register(
  '@happyvertical/smrt-analytics',
  'events-table',
  EventsTable,
);
ModuleUIRegistry.register(
  '@happyvertical/smrt-analytics',
  'property-info',
  PropertyInfo,
);
ModuleUIRegistry.register(
  '@happyvertical/smrt-analytics',
  'property-status-badge',
  PropertyStatusBadge,
);
ModuleUIRegistry.register(
  '@happyvertical/smrt-analytics',
  'stat-card',
  StatCard,
);
ModuleUIRegistry.register(
  '@happyvertical/smrt-analytics',
  'trend-badge',
  TrendBadge,
);
