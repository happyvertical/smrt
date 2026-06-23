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
   * Offset of `timeZone` at `instant`, in milliseconds (wall-clock minus UTC).
   *
   * Reads the zone's wall-clock Y/M/D h:m:s for `instant` via
   * `Intl.DateTimeFormat` parts and subtracts the real UTC instant. Positive
   * east of UTC, negative west (e.g. `America/Los_Angeles` returns roughly
   * `-7h`/`-8h` depending on DST).
   *
   * @throws RangeError if `timeZone` is not a valid IANA identifier.
   */
  private zoneOffsetMs(instant: Date, timeZone: string): number {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).formatToParts(instant);
    const lookup = (type: Intl.DateTimeFormatPartTypes): number =>
      Number.parseInt(parts.find((p) => p.type === type)?.value ?? '0', 10);
    let hour = lookup('hour');
    // Intl can emit hour "24" for midnight under hour12:false; normalize to 0.
    if (hour === 24) hour = 0;
    const asUtc = Date.UTC(
      lookup('year'),
      lookup('month') - 1,
      lookup('day'),
      hour,
      lookup('minute'),
      lookup('second'),
    );
    return asUtc - instant.getTime();
  }

  /**
   * Resolve the UTC instant marking the start of the calendar day (00:00) that
   * `instant` falls on **within the given IANA time zone**.
   *
   * Day-over-day buckets ("today vs yesterday") must respect the property's
   * configured `timeZone` (defaults to `America/Los_Angeles`), otherwise a
   * pageview at 11:30pm local time — already the next UTC day — is bucketed
   * into the wrong day. We read the wall-clock civil date for the zone, then
   * map that date's local midnight back to a UTC instant, correcting for the
   * zone offset (and re-correcting once across a DST boundary).
   *
   * Invalid/unknown zone identifiers fall back to UTC day boundaries (matching
   * the previous behaviour) rather than throwing.
   *
   * @param instant - Reference instant.
   * @param timeZone - IANA time zone (e.g. `America/Los_Angeles`).
   * @returns UTC `Date` for local midnight of the day `instant` is in.
   */
  protected startOfDayInZone(instant: Date, timeZone: string): Date {
    let civil: { year: number; month: number; day: number };
    try {
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).formatToParts(instant);
      const lookup = (type: Intl.DateTimeFormatPartTypes): number =>
        Number.parseInt(parts.find((p) => p.type === type)?.value ?? '0', 10);
      civil = {
        year: lookup('year'),
        month: lookup('month'),
        day: lookup('day'),
      };
    } catch {
      // Unknown/invalid time zone -> UTC day boundary.
      return new Date(
        Date.UTC(
          instant.getUTCFullYear(),
          instant.getUTCMonth(),
          instant.getUTCDate(),
        ),
      );
    }

    // Local midnight of `civil`, as a UTC instant: treat civil-midnight as if
    // UTC, then subtract the zone offset at that guess. Re-derive the offset at
    // the corrected instant and re-correct once if it changed (DST edge).
    const guess = Date.UTC(civil.year, civil.month - 1, civil.day);
    const offset = this.zoneOffsetMs(new Date(guess), timeZone);
    let utc = guess - offset;
    const offset2 = this.zoneOffsetMs(new Date(utc), timeZone);
    if (offset2 !== offset) utc = guess - offset2;
    return new Date(utc);
  }

  /**
   * Resolve the UTC instant for the start of the day *before* `todayStart`'s
   * local day, in `timeZone`.
   *
   * Steps back 12h from local midnight (landing safely inside the previous
   * civil day regardless of DST — a naive `- 24h` skips a day across
   * spring-forward), then re-resolves start-of-day.
   *
   * @param todayStart - Local-midnight UTC instant from {@link startOfDayInZone}.
   * @param timeZone - IANA time zone.
   * @returns UTC `Date` for local midnight of the prior calendar day.
   */
  protected startOfYesterdayInZone(todayStart: Date, timeZone: string): Date {
    return this.startOfDayInZone(
      new Date(todayStart.getTime() - 12 * 3_600_000),
      timeZone,
    );
  }

  /**
   * Classify a day-over-day change into a trend direction + percent.
   *
   * - `yesterday > 0`: percent = rounded delta; >5% up, <-5% down, else flat.
   * - `yesterday === 0 && today > 0`: a brand-new surge from a zero baseline —
   *   classified `up` with a `null` percent (no finite percentage exists), so
   *   the UI renders "new" rather than a misleading flat 0%.
   * - `yesterday === 0 && today === 0`: flat, 0%.
   *
   * @param today - Today's count.
   * @param yesterday - Yesterday's count.
   * @returns Trend direction and percent (null when growing from zero).
   */
  protected classifyTrend(
    today: number,
    yesterday: number,
  ): { trend: 'up' | 'down' | 'flat'; trendPercent: number | null } {
    if (yesterday > 0) {
      const change = ((today - yesterday) / yesterday) * 100;
      const trendPercent = Math.round(change);
      let trend: 'up' | 'down' | 'flat' = 'flat';
      if (change > 5) trend = 'up';
      else if (change < -5) trend = 'down';
      return { trend, trendPercent };
    }
    if (today > 0) {
      // Growth from a zero baseline: a real surge, no finite percentage.
      return { trend: 'up', trendPercent: null };
    }
    return { trend: 'flat', trendPercent: 0 };
  }

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
   * to classify 'up' vs 'down' vs 'flat'; growth from a zero baseline is
   * classified `up` with a `null` percent (see {@link classifyTrend}).
   *
   * Day boundaries are computed in `timeZone` (an IANA identifier such as the
   * property's `AnalyticsProperty.timeZone`, which defaults to
   * `America/Los_Angeles`) so an event near local midnight buckets into the
   * correct calendar day. Defaults to `'UTC'` when omitted.
   *
   * @param propertyId - Property ID
   * @param now - Optional current date (for testing)
   * @param timeZone - IANA time zone for day boundaries (default `'UTC'`)
   * @returns Stats with trend
   */
  async getPropertyStatsWithTrend(
    propertyId: string,
    now?: Date,
    timeZone: string = 'UTC',
  ): Promise<PropertyStatsWithTrend> {
    const currentTime = now || new Date();
    const todayStart = this.startOfDayInZone(currentTime, timeZone);
    const yesterdayStart = this.startOfYesterdayInZone(todayStart, timeZone);

    // Single query for both days to avoid concurrent DuckDB prepared statements
    const allPageviewEvents = await this.list({
      where: {
        propertyId,
        eventName: 'page_view',
        'eventTimestamp >=': yesterdayStart.toISOString(),
        'eventTimestamp <=': currentTime.toISOString(),
      },
    });

    const todayPageviewEvents = allPageviewEvents.filter(
      (e) => new Date(e.eventTimestamp) >= todayStart,
    );
    const yesterdayPageviewEvents = allPageviewEvents.filter(
      (e) => new Date(e.eventTimestamp) < todayStart,
    );

    // Count unique clients (users)
    const todayClients = new Set(todayPageviewEvents.map((e) => e.clientId));
    const yesterdayClients = new Set(
      yesterdayPageviewEvents.map((e) => e.clientId),
    );

    const todayPageviews = todayPageviewEvents.length;
    const yesterdayPageviews = yesterdayPageviewEvents.length;

    const { trend, trendPercent } = this.classifyTrend(
      todayPageviews,
      yesterdayPageviews,
    );

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
   * Day boundaries are computed in `timeZone` (default `'UTC'`); see
   * {@link getPropertyStatsWithTrend}. A single zone applies to the whole
   * batch, so callers mixing properties with different `timeZone` values
   * should batch per zone (or fall back to per-property calls).
   *
   * @param propertyIds - Array of property IDs
   * @param now - Optional current date (for testing)
   * @param timeZone - IANA time zone for day boundaries (default `'UTC'`)
   * @returns Map of propertyId to stats
   */
  async getBatchPropertyStats(
    propertyIds: string[],
    now?: Date,
    timeZone: string = 'UTC',
  ): Promise<Map<string, PropertyStatsWithTrend>> {
    const results = new Map<string, PropertyStatsWithTrend>();

    // Fetch all date-ranged events once to avoid N+1 queries
    const currentTime = now || new Date();
    const todayStart = this.startOfDayInZone(currentTime, timeZone);
    const yesterdayStart = this.startOfYesterdayInZone(todayStart, timeZone);

    // Single query for both days to avoid concurrent DuckDB prepared statements
    const allEvents = await this.list({
      where: {
        eventName: 'page_view',
        'eventTimestamp >=': yesterdayStart.toISOString(),
        'eventTimestamp <=': currentTime.toISOString(),
      },
    });

    // Pre-group events by propertyId and day in a single pass
    const todayByProperty = new Map<string, AnalyticsEvent[]>();
    const yesterdayByProperty = new Map<string, AnalyticsEvent[]>();
    for (const e of allEvents) {
      const isToday = new Date(e.eventTimestamp) >= todayStart;
      const map = isToday ? todayByProperty : yesterdayByProperty;
      const list = map.get(e.propertyId);
      if (list) list.push(e);
      else map.set(e.propertyId, [e]);
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

      const { trend, trendPercent } = this.classifyTrend(
        todayPageviews,
        yesterdayPageviews,
      );

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
