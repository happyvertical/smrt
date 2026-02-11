/**
 * Types and enums for smrt-analytics package
 */

/**
 * Analytics provider types
 */
export enum AnalyticsProvider {
  GA4 = 'ga4',
  PLAUSIBLE = 'plausible',
}

/**
 * Status for analytics properties
 */
export enum AnalyticsPropertyStatus {
  ACTIVE = 'active',
  INACTIVE = 'inactive',
  PENDING = 'pending',
}

/**
 * Data stream types (matching SDK types)
 */
export enum DataStreamType {
  WEB = 'WEB_DATA_STREAM',
  ANDROID = 'ANDROID_APP_DATA_STREAM',
  IOS = 'IOS_APP_DATA_STREAM',
}

/**
 * Status for data streams
 */
export enum DataStreamStatus {
  ACTIVE = 'active',
  INACTIVE = 'inactive',
}

/**
 * Report status
 */
export enum ReportStatus {
  DRAFT = 'draft',
  SCHEDULED = 'scheduled',
  RUNNING = 'running',
  COMPLETED = 'completed',
  FAILED = 'failed',
}

/**
 * Report frequency for scheduled reports
 */
export enum ReportFrequency {
  ONCE = 'once',
  DAILY = 'daily',
  WEEKLY = 'weekly',
  MONTHLY = 'monthly',
}

/**
 * Custom dimension scope (matching SDK types)
 */
export enum CustomDimensionScope {
  EVENT = 'EVENT',
  USER = 'USER',
  ITEM = 'ITEM',
}

/**
 * Event tracking status
 */
export enum TrackingEventStatus {
  PENDING = 'pending',
  SENT = 'sent',
  FAILED = 'failed',
}

/**
 * Key event counting method (matching SDK types)
 */
export enum CountingMethod {
  ONCE_PER_EVENT = 'ONCE_PER_EVENT',
  ONCE_PER_SESSION = 'ONCE_PER_SESSION',
}

// ============================================================================
// Analytics aggregation types
// ============================================================================

/**
 * Day-over-day property stats with trend calculation
 */
export interface PropertyStatsWithTrend {
  todayPageviews: number;
  todayUsers: number;
  yesterdayPageviews: number;
  yesterdayUsers: number;
  trend: 'up' | 'down' | 'flat';
  trendPercent: number;
}

// ============================================================================
// SDK-compatible type definitions
// These mirror the types from @happyvertical/analytics for when SDK is not installed
// ============================================================================

/**
 * Analytics property/site representation (SDK-compatible)
 */
export interface SDKProperty {
  id: string;
  name: string;
  displayName: string;
  createTime: string;
  updateTime?: string;
  timeZone?: string;
  currencyCode?: string;
  industryCategory?: string;
  serviceLevel?: 'STANDARD' | 'PREMIUM';
}

/**
 * Data stream representation (SDK-compatible)
 */
export interface SDKDataStream {
  id: string;
  type: 'WEB_DATA_STREAM' | 'ANDROID_APP_DATA_STREAM' | 'IOS_APP_DATA_STREAM';
  displayName: string;
  measurementId?: string;
  firebaseAppId?: string;
  defaultUri?: string;
  createTime: string;
  updateTime?: string;
}

/**
 * Custom dimension representation (SDK-compatible)
 */
export interface SDKCustomDimension {
  id: string;
  name: string;
  parameterName: string;
  displayName: string;
  description?: string;
  scope: 'EVENT' | 'USER' | 'ITEM';
  disallowAdsPersonalization?: boolean;
}

/**
 * Custom metric representation (SDK-compatible)
 */
export interface SDKCustomMetric {
  id: string;
  name: string;
  parameterName: string;
  displayName: string;
  description?: string;
  scope: 'EVENT';
  measurementUnit: string;
  restrictedMetricType?: 'COST_DATA' | 'REVENUE_DATA';
}

/**
 * Key event (conversion) representation (SDK-compatible)
 */
export interface SDKKeyEvent {
  id: string;
  name: string;
  eventName: string;
  createTime: string;
  countingMethod?: 'ONCE_PER_EVENT' | 'ONCE_PER_SESSION';
  defaultValue?: {
    numericValue?: number;
    currencyCode?: string;
  };
}

/**
 * Report options (SDK-compatible)
 */
export interface SDKReportOptions {
  dateRanges: Array<{
    startDate: string;
    endDate: string;
    name?: string;
  }>;
  dimensions?: Array<{ name: string }>;
  metrics: Array<{ name: string }>;
  offset?: number;
  limit?: number;
  orderBys?: Array<{
    metric?: { metricName: string };
    dimension?: { dimensionName: string };
    desc?: boolean;
  }>;
  keepEmptyRows?: boolean;
  returnPropertyQuota?: boolean;
}

/**
 * Report result (SDK-compatible)
 */
export interface SDKReportResult {
  dimensionHeaders: Array<{ name: string }>;
  metricHeaders: Array<{ name: string; type: string }>;
  rows: Array<{
    dimensionValues: Array<{ value: string }>;
    metricValues: Array<{ value: string }>;
  }>;
  rowCount?: number;
  metadata?: {
    currencyCode?: string;
    timeZone?: string;
    dataLossFromOtherRow?: boolean;
    emptyReason?: string;
  };
}

/**
 * Track event payload (SDK-compatible)
 */
export interface SDKTrackEvent {
  name: string;
  params?: Record<string, string | number | boolean>;
  clientId?: string;
  userId?: string;
  timestamp?: number;
  nonPersonalizedAds?: boolean;
}

/**
 * Pageview event payload (SDK-compatible)
 */
export interface SDKPageviewEvent {
  pagePath: string;
  pageTitle?: string;
  pageLocation?: string;
  clientId?: string;
  userId?: string;
  params?: Record<string, string | number | boolean>;
}

/**
 * Analytics provider capabilities (SDK-compatible)
 */
export interface AnalyticsCapabilities {
  propertyManagement: boolean;
  dataStreams: boolean;
  customDimensions: boolean;
  customMetrics: boolean;
  keyEvents: boolean;
  reporting: boolean;
  realtimeReporting: boolean;
  serverSideTracking: boolean;
  clientSideSnippet: boolean;
  userIdentification: boolean;
  batchTracking: boolean;
}

/**
 * Analytics interface (SDK-compatible)
 * This is a subset of the full SDK interface for type compatibility
 */
export interface AnalyticsInterface {
  createProperty(options: {
    displayName: string;
    timeZone?: string;
    currencyCode?: string;
  }): Promise<SDKProperty>;
  listProperties(): Promise<SDKProperty[]>;
  getProperty(propertyId: string): Promise<SDKProperty>;
  getDataStreams(propertyId: string): Promise<SDKDataStream[]>;
  runReport(
    propertyId: string,
    options: SDKReportOptions,
  ): Promise<SDKReportResult>;
  track(event: SDKTrackEvent): Promise<void>;
  trackPageview(pageview: SDKPageviewEvent): Promise<void>;
  trackBatch(events: SDKTrackEvent[]): Promise<void>;
  getCapabilities(): Promise<AnalyticsCapabilities>;
}
