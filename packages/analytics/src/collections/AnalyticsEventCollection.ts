/**
 * AnalyticsEventCollection - Collection manager for AnalyticsEvent objects
 * @packageDocumentation
 */

import { SmrtCollection } from '@happyvertical/smrt-core';
import { AnalyticsEvent } from '../models/AnalyticsEvent.js';
import {
  type PropertyStatsWithTrend,
  TrackingEventStatus,
} from '../types/index.js';

export class AnalyticsEventCollection extends SmrtCollection<AnalyticsEvent> {
  static readonly _itemClass = AnalyticsEvent;

  /**
   * Find events by property
   *
   * @param propertyId - Parent property ID
   * @returns Array of events
   */
  async findByProperty(propertyId: string): Promise<AnalyticsEvent[]> {
    return await this.list({
      where: { propertyId },
      orderBy: 'eventTimestamp DESC',
    });
  }

  /**
   * Find events by event name
   *
   * @param eventName - Event name to filter by
   * @returns Array of matching events
   */
  async findByEventName(eventName: string): Promise<AnalyticsEvent[]> {
    return await this.list({
      where: { eventName },
      orderBy: 'eventTimestamp DESC',
    });
  }

  /**
   * Find events by client ID
   *
   * @param clientId - Client ID
   * @returns Array of events for this client
   */
  async findByClientId(clientId: string): Promise<AnalyticsEvent[]> {
    return await this.list({
      where: { clientId },
      orderBy: 'eventTimestamp DESC',
    });
  }

  /**
   * Find events by user ID
   *
   * @param userId - User ID
   * @returns Array of events for this user
   */
  async findByUserId(userId: string): Promise<AnalyticsEvent[]> {
    return await this.list({
      where: { userId },
      orderBy: 'eventTimestamp DESC',
    });
  }

  /**
   * Find events by status
   *
   * @param status - Tracking event status
   * @returns Array of matching events
   */
  async findByStatus(status: TrackingEventStatus): Promise<AnalyticsEvent[]> {
    return await this.list({
      where: { status },
      orderBy: 'eventTimestamp DESC',
    });
  }

  /**
   * Find all pending events
   */
  async findPending(): Promise<AnalyticsEvent[]> {
    return await this.findByStatus(TrackingEventStatus.PENDING);
  }

  /**
   * Find all sent events
   */
  async findSent(): Promise<AnalyticsEvent[]> {
    return await this.findByStatus(TrackingEventStatus.SENT);
  }

  /**
   * Find all failed events
   */
  async findFailed(): Promise<AnalyticsEvent[]> {
    return await this.findByStatus(TrackingEventStatus.FAILED);
  }

  /**
   * Find events that should be retried
   *
   * @param maxRetries - Maximum retry count
   * @returns Array of events eligible for retry
   */
  async findForRetry(maxRetries: number = 3): Promise<AnalyticsEvent[]> {
    const failed = await this.findFailed();
    return failed.filter((e) => e.shouldRetry(maxRetries));
  }

  /**
   * Find pending events for a property
   *
   * @param propertyId - Parent property ID
   * @returns Array of pending events
   */
  async findPendingByProperty(propertyId: string): Promise<AnalyticsEvent[]> {
    return await this.list({
      where: {
        propertyId,
        status: TrackingEventStatus.PENDING,
      },
      orderBy: 'eventTimestamp ASC', // Process oldest first
    });
  }

  /**
   * Find events by date range
   *
   * @param startDate - Start date
   * @param endDate - End date
   * @returns Array of events in date range
   */
  async findByDateRange(
    startDate: Date,
    endDate: Date,
  ): Promise<AnalyticsEvent[]> {
    return await this.list({
      where: {
        'eventTimestamp >=': startDate.toISOString(),
        'eventTimestamp <=': endDate.toISOString(),
      },
      orderBy: 'eventTimestamp DESC',
    });
  }

  /**
   * Find conversion events
   *
   * @param propertyId - Optional property ID filter
   * @returns Array of conversion events
   */
  async findConversions(propertyId?: string): Promise<AnalyticsEvent[]> {
    const conversionEvents = [
      'purchase',
      'sign_up',
      'generate_lead',
      'begin_checkout',
    ];
    const all = propertyId
      ? await this.findByProperty(propertyId)
      : await this.list({ orderBy: 'eventTimestamp DESC' });

    return all.filter((e) => conversionEvents.includes(e.eventName));
  }

  /**
   * Find pageview events
   *
   * @param propertyId - Optional property ID filter
   * @returns Array of pageview events
   */
  async findPageviews(propertyId?: string): Promise<AnalyticsEvent[]> {
    const where: Record<string, unknown> = { eventName: 'page_view' };
    if (propertyId) {
      where.propertyId = propertyId;
    }
    return await this.list({
      where,
      orderBy: 'eventTimestamp DESC',
    });
  }

  /**
   * Count events by event name for a property
   *
   * @param propertyId - Property ID
   * @returns Map of event name to count
   */
  async countByEventName(propertyId: string): Promise<Map<string, number>> {
    const events = await this.findByProperty(propertyId);
    const counts = new Map<string, number>();

    for (const event of events) {
      const current = counts.get(event.eventName) || 0;
      counts.set(event.eventName, current + 1);
    }

    return counts;
  }

  /**
   * Get event stats for a property
   *
   * @param propertyId - Property ID
   * @returns Event statistics
   */
  async getPropertyStats(propertyId: string): Promise<{
    total: number;
    pending: number;
    sent: number;
    failed: number;
    conversions: number;
    pageviews: number;
  }> {
    const events = await this.findByProperty(propertyId);

    return {
      total: events.length,
      pending: events.filter((e) => e.status === TrackingEventStatus.PENDING)
        .length,
      sent: events.filter((e) => e.status === TrackingEventStatus.SENT).length,
      failed: events.filter((e) => e.status === TrackingEventStatus.FAILED)
        .length,
      conversions: events.filter((e) => e.isConversion()).length,
      pageviews: events.filter((e) => e.isPageview()).length,
    };
  }

  /**
   * Get day-over-day pageview stats with trend for a property.
   *
   * Compares today's pageview count against yesterday's to produce a
   * trend direction and percentage change. A threshold of 5% is used
   * to classify 'up' vs 'down' vs 'flat'.
   *
   * @param propertyId - Property ID
   * @param now - Optional current date (for testing)
   * @returns Stats with trend
   */
  async getPropertyStatsWithTrend(
    propertyId: string,
    now?: Date,
  ): Promise<PropertyStatsWithTrend> {
    const currentTime = now || new Date();
    const todayStart = new Date(
      currentTime.getFullYear(),
      currentTime.getMonth(),
      currentTime.getDate(),
    );
    const yesterdayStart = new Date(todayStart.getTime() - 24 * 60 * 60 * 1000);
    const yesterdayEnd = new Date(todayStart.getTime() - 1);

    const [todayPageviewEvents, yesterdayPageviewEvents] = await Promise.all([
      this.list({
        where: {
          propertyId,
          eventName: 'page_view',
          'eventTimestamp >=': todayStart.toISOString(),
          'eventTimestamp <=': currentTime.toISOString(),
        },
      }),
      this.list({
        where: {
          propertyId,
          eventName: 'page_view',
          'eventTimestamp >=': yesterdayStart.toISOString(),
          'eventTimestamp <=': yesterdayEnd.toISOString(),
        },
      }),
    ]);

    // Count unique clients (users)
    const todayClients = new Set(todayPageviewEvents.map((e) => e.clientId));
    const yesterdayClients = new Set(
      yesterdayPageviewEvents.map((e) => e.clientId),
    );

    const todayPageviews = todayPageviewEvents.length;
    const yesterdayPageviews = yesterdayPageviewEvents.length;

    // Calculate trend
    let trend: 'up' | 'down' | 'flat' = 'flat';
    let trendPercent = 0;

    if (yesterdayPageviews > 0) {
      const change =
        ((todayPageviews - yesterdayPageviews) / yesterdayPageviews) * 100;
      trendPercent = Math.round(change);
      if (change > 5) trend = 'up';
      else if (change < -5) trend = 'down';
    }

    return {
      todayPageviews,
      todayUsers: todayClients.size,
      yesterdayPageviews,
      yesterdayUsers: yesterdayClients.size,
      trend,
      trendPercent,
    };
  }

  /**
   * Get day-over-day stats for multiple properties in batch.
   *
   * @param propertyIds - Array of property IDs
   * @param now - Optional current date (for testing)
   * @returns Map of propertyId to stats
   */
  async getBatchPropertyStats(
    propertyIds: string[],
    now?: Date,
  ): Promise<Map<string, PropertyStatsWithTrend>> {
    const results = new Map<string, PropertyStatsWithTrend>();

    // Fetch all date-ranged events once to avoid N+1 queries
    const currentTime = now || new Date();
    const todayStart = new Date(
      currentTime.getFullYear(),
      currentTime.getMonth(),
      currentTime.getDate(),
    );
    const yesterdayStart = new Date(todayStart.getTime() - 24 * 60 * 60 * 1000);
    const yesterdayEnd = new Date(todayStart.getTime() - 1);

    const [todayEvents, yesterdayEvents] = await Promise.all([
      this.list({
        where: {
          eventName: 'page_view',
          'eventTimestamp >=': todayStart.toISOString(),
          'eventTimestamp <=': currentTime.toISOString(),
        },
      }),
      this.list({
        where: {
          eventName: 'page_view',
          'eventTimestamp >=': yesterdayStart.toISOString(),
          'eventTimestamp <=': yesterdayEnd.toISOString(),
        },
      }),
    ]);

    // Pre-group events by propertyId in a single pass
    const todayByProperty = new Map<string, AnalyticsEvent[]>();
    const yesterdayByProperty = new Map<string, AnalyticsEvent[]>();
    for (const e of todayEvents) {
      const list = todayByProperty.get(e.propertyId);
      if (list) list.push(e);
      else todayByProperty.set(e.propertyId, [e]);
    }
    for (const e of yesterdayEvents) {
      const list = yesterdayByProperty.get(e.propertyId);
      if (list) list.push(e);
      else yesterdayByProperty.set(e.propertyId, [e]);
    }

    for (const propertyId of propertyIds) {
      const todayPageviewEvents = todayByProperty.get(propertyId) ?? [];
      const yesterdayPageviewEvents = yesterdayByProperty.get(propertyId) ?? [];

      const todayClients = new Set(todayPageviewEvents.map((e) => e.clientId));
      const yesterdayClients = new Set(
        yesterdayPageviewEvents.map((e) => e.clientId),
      );

      const todayPageviews = todayPageviewEvents.length;
      const yesterdayPageviews = yesterdayPageviewEvents.length;

      let trend: 'up' | 'down' | 'flat' = 'flat';
      let trendPercent = 0;

      if (yesterdayPageviews > 0) {
        const change =
          ((todayPageviews - yesterdayPageviews) / yesterdayPageviews) * 100;
        trendPercent = Math.round(change);
        if (change > 5) trend = 'up';
        else if (change < -5) trend = 'down';
      }

      results.set(propertyId, {
        todayPageviews,
        todayUsers: todayClients.size,
        yesterdayPageviews,
        yesterdayUsers: yesterdayClients.size,
        trend,
        trendPercent,
      });
    }

    return results;
  }
}
