/**
 * @happyvertical/smrt-analytics
 *
 * Analytics integration models for SMRT framework.
 * Provides SMRT-wrapped models for managing analytics properties, data streams,
 * reports, and event tracking with integration to @happyvertical/analytics SDK.
 *
 * @packageDocumentation
 */

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
