/**
 * @happyvertical/smrt-analytics
 *
 * Analytics integration models for SMRT framework.
 * Provides SMRT-wrapped models for managing analytics properties, data streams,
 * reports, and event tracking with integration to @happyvertical/analytics SDK.
 *
 * @packageDocumentation
 */

// Self-register this package's manifest before any @smrt() decorator fires
// downstream. Must come first so the side effect runs ahead of the class
// module loads below. See __smrt-register__.ts for issue #1132 context.
import './__smrt-register__.js';
// Register prompts at module-load time so consumers and tenants can
// override them via `resolvePrompt()` without further plumbing.
import './prompts.js';

// Collections
export {
  AnalyticsDataStreamCollection,
  AnalyticsEventCollection,
  AnalyticsPropertyCollection,
  AnalyticsReportCollection,
} from './collections/index.js';

// Models
export {
  AnalyticsDataStream,
  AnalyticsEvent,
  AnalyticsProperty,
  AnalyticsReport,
} from './models/index.js';
// Prompt registrations — re-exported so consumers can reference the keys
// for tenant-aware overrides via `@happyvertical/smrt-prompts`.
export {
  promptMessageOptions,
  smrtAnalyticsAnalyzePerformancePrompt,
  smrtAnalyticsAnalyzeResultsPrompt,
  smrtAnalyticsHasPositiveTrendsPrompt,
} from './prompts.js';
// Re-export SDK types for convenience
export type {
  AnalyticsCapabilities,
  AnalyticsInterface,
  PropertyStatsWithTrend,
  SDKCustomDimension,
  SDKCustomMetric,
  SDKDataStream,
  SDKKeyEvent,
  SDKPageviewEvent,
  SDKProperty,
  SDKReportOptions,
  SDKReportResult,
  SDKTrackEvent,
} from './types/index.js';
// Types and enums
export {
  AnalyticsPropertyStatus,
  AnalyticsProvider,
  CountingMethod,
  CustomDimensionScope,
  DataStreamStatus,
  DataStreamType,
  ReportFrequency,
  ReportStatus,
  TrackingEventStatus,
} from './types/index.js';
