/**
 * Analytics Module UI Slot Declarations
 *
 * This file defines the UI extension points for the analytics module.
 * UI components are implemented in the ./svelte subpath and auto-register
 * with `ModuleUIRegistry` when that subpath is imported.
 *
 * @example Usage
 * ```typescript
 * import { ANALYTICS_MODULE_META } from '@happyvertical/smrt-analytics/ui';
 * console.log(ANALYTICS_MODULE_META.uiSlots);
 * ```
 */

import type { ModuleUISlot, SmrtModuleMeta } from '@happyvertical/smrt-types';

/**
 * Analytics module UI slots
 */
export const ANALYTICS_UI_SLOTS: Record<string, ModuleUISlot> = {
  'analytics-summary': {
    id: 'analytics-summary',
    label: 'Analytics Summary',
    description:
      'Summary cards for pageviews, users, and trend deltas across today/yesterday',
    icon: 'bar-chart-3',
    category: 'display',
    order: 1,
    propsInterface: 'AnalyticsSummaryProps',
  },
  'events-table': {
    id: 'events-table',
    label: 'Events Table',
    description: 'Tabular display of recent analytics events with filters',
    icon: 'list',
    category: 'list',
    order: 2,
    propsInterface: 'EventsTableProps',
  },
  'property-info': {
    id: 'property-info',
    label: 'Property Info',
    description: 'Display analytics property identifiers and configuration',
    icon: 'info',
    category: 'display',
    order: 3,
    propsInterface: 'PropertyInfoProps',
  },
  'property-status-badge': {
    id: 'property-status-badge',
    label: 'Property Status Badge',
    description: 'Compact status indicator for an analytics property',
    icon: 'badge',
    category: 'display',
    order: 4,
    propsInterface: 'PropertyStatusBadgeProps',
  },
  'stat-card': {
    id: 'stat-card',
    label: 'Stat Card',
    description:
      'Single-metric card with label, value, optional trend and subtitle',
    icon: 'trending-up',
    category: 'display',
    order: 5,
    propsInterface: 'StatCardProps',
  },
  'trend-badge': {
    id: 'trend-badge',
    label: 'Trend Badge',
    description: 'Up/down/flat trend indicator with percentage delta',
    icon: 'arrow-up-right',
    category: 'display',
    order: 6,
    propsInterface: 'TrendBadgeProps',
  },
};

/**
 * Analytics module metadata
 */
export const ANALYTICS_MODULE_META: SmrtModuleMeta = {
  name: '@happyvertical/smrt-analytics',
  displayName: 'Analytics',
  description:
    'Analytics integration models for GA4, Plausible, and Matomo with server-side event tracking and AI-powered reporting',
  uiSlots: ANALYTICS_UI_SLOTS,
  models: [
    'AnalyticsProperty',
    'AnalyticsDataStream',
    'AnalyticsEvent',
    'AnalyticsReport',
  ],
  collections: [
    'AnalyticsPropertyCollection',
    'AnalyticsDataStreamCollection',
    'AnalyticsEventCollection',
    'AnalyticsReportCollection',
  ],
};
