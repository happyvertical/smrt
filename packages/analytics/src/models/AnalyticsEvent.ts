/**
 * AnalyticsEvent model - Tracked events log
 * @packageDocumentation
 */

import { SmrtObject, smrt } from '@happyvertical/smrt-core';
import { TrackingEventStatus } from '../types/index.js';

/**
 * AnalyticsEvent represents a tracked analytics event (server-side tracking log).
 *
 * @example
 * ```typescript
 * const event = await events.create({
 *   propertyId: property.id,
 *   eventName: 'purchase',
 *   clientId: 'user-123',
 *   params: JSON.stringify({ value: 99.99, currency: 'USD' })
 * });
 * await event.send();
 * ```
 */
@smrt({
  tableStrategy: 'sti',
  api: { include: ['list', 'get', 'create'] },
  mcp: { include: ['list', 'get', 'track'] },
  cli: true,
})
export class AnalyticsEvent extends SmrtObject {
  /**
   * Parent property ID (references AnalyticsProperty)
   */
  propertyId: string = '';

  /**
   * Event name (e.g., 'purchase', 'page_view', 'sign_up')
   */
  eventName: string = '';

  /**
   * Client ID for anonymous tracking
   */
  clientId: string = '';

  /**
   * User ID for identified tracking
   */
  userId: string = '';

  /**
   * Event parameters (JSON)
   */
  params: string = '{}';

  /**
   * Event timestamp
   */
  eventTimestamp: Date = new Date();

  /**
   * Tracking status
   */
  status: TrackingEventStatus = TrackingEventStatus.PENDING;

  /**
   * Timestamp when sent to provider
   */
  sentAt: Date | null = null;

  /**
   * Error message if sending failed
   */
  errorMessage: string = '';

  /**
   * Retry count
   */
  retryCount: number = 0;

  /**
   * Disable personalized ads
   */
  nonPersonalizedAds: boolean = false;

  /**
   * Session ID
   */
  sessionId: string = '';

  /**
   * Page path (for pageview events)
   */
  pagePath: string = '';

  /**
   * Page title (for pageview events)
   */
  pageTitle: string = '';

  /**
   * User agent
   */
  userAgent: string = '';

  /**
   * IP address (anonymized)
   */
  ipAddress: string = '';

  constructor(options: any = {}) {
    super(options);
    if (options.propertyId !== undefined) this.propertyId = options.propertyId;
    if (options.eventName !== undefined) this.eventName = options.eventName;
    if (options.clientId !== undefined) this.clientId = options.clientId;
    if (options.userId !== undefined) this.userId = options.userId;
    if (options.params !== undefined) this.params = options.params;
    if (options.eventTimestamp !== undefined)
      this.eventTimestamp = options.eventTimestamp;
    if (options.status !== undefined) this.status = options.status;
    if (options.sentAt !== undefined) this.sentAt = options.sentAt;
    if (options.errorMessage !== undefined)
      this.errorMessage = options.errorMessage;
    if (options.retryCount !== undefined) this.retryCount = options.retryCount;
    if (options.nonPersonalizedAds !== undefined)
      this.nonPersonalizedAds = options.nonPersonalizedAds;
    if (options.sessionId !== undefined) this.sessionId = options.sessionId;
    if (options.pagePath !== undefined) this.pagePath = options.pagePath;
    if (options.pageTitle !== undefined) this.pageTitle = options.pageTitle;
    if (options.userAgent !== undefined) this.userAgent = options.userAgent;
    if (options.ipAddress !== undefined) this.ipAddress = options.ipAddress;
  }

  /**
   * Get parsed event parameters
   */
  getParams(): Record<string, string | number | boolean> {
    try {
      return JSON.parse(this.params);
    } catch {
      return {};
    }
  }

  /**
   * Set event parameters
   */
  setParams(params: Record<string, string | number | boolean>): void {
    this.params = JSON.stringify(params);
  }

  /**
   * Add a parameter to the event
   */
  addParam(key: string, value: string | number | boolean): void {
    const params = this.getParams();
    params[key] = value;
    this.setParams(params);
  }

  /**
   * Check if this is a pageview event
   */
  isPageview(): boolean {
    return this.eventName === 'page_view' || this.eventName === 'pageview';
  }

  /**
   * Check if this is a conversion event
   */
  isConversion(): boolean {
    const conversionEvents = [
      'purchase',
      'sign_up',
      'generate_lead',
      'begin_checkout',
    ];
    return conversionEvents.includes(this.eventName);
  }

  /**
   * Mark as sent successfully
   */
  markSent(): void {
    this.status = TrackingEventStatus.SENT;
    this.sentAt = new Date();
    this.errorMessage = '';
  }

  /**
   * Mark as failed
   */
  markFailed(error: string): void {
    this.status = TrackingEventStatus.FAILED;
    this.errorMessage = error;
    this.retryCount++;
  }

  /**
   * Reset for retry
   */
  resetForRetry(): void {
    this.status = TrackingEventStatus.PENDING;
    this.sentAt = null;
  }

  /**
   * Check if event should be retried
   */
  shouldRetry(maxRetries: number = 3): boolean {
    return (
      this.status === TrackingEventStatus.FAILED && this.retryCount < maxRetries
    );
  }

  /**
   * Build SDK TrackEvent object
   */
  toTrackEvent(): {
    name: string;
    params?: Record<string, string | number | boolean>;
    clientId?: string;
    userId?: string;
    timestamp?: number;
    nonPersonalizedAds?: boolean;
  } {
    return {
      name: this.eventName,
      params: this.getParams(),
      clientId: this.clientId || undefined,
      userId: this.userId || undefined,
      timestamp: this.eventTimestamp.getTime() * 1000, // Convert to microseconds
      nonPersonalizedAds: this.nonPersonalizedAds,
    };
  }
}

export default AnalyticsEvent;
