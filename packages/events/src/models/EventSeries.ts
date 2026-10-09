/**
 * EventSeries model - Groups related events (season, tour, conference, etc.)
 *
 * Examples: '2024 NBA Finals', 'Summer Tour 2024', 'Town Council 2024'
 */

import {
  crossPackageRef,
  field,
  foreignKey,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import { expandRecurrence } from '../recurrence';
import type { EventSeriesOptions, RecurrencePattern } from '../types';

@TenantScoped({ mode: 'optional' })
@smrt({
  tableStrategy: 'sti',
  api: { include: ['list', 'get', 'create', 'update', 'delete'] },
  mcp: { include: ['list', 'get', 'create', 'update'] },
  cli: { skipApiCheck: true },
})
export class EventSeries extends SmrtObject {
  @tenantId({ nullable: true })
  tenantId: string | null = null;

  @field({ description: 'What the series is called.' })
  name: string = '';
  @field({ description: 'The kind of event in this series.' })
  @foreignKey('EventType')
  typeId = ''; // FK to EventType
  @field({ description: 'Who runs the series.' })
  @crossPackageRef('@happyvertical/smrt-profiles:Profile')
  organizerId = ''; // FK to Profile (from @happyvertical/smrt-profiles)
  @field({ description: 'What the series is about.' })
  description = '';
  @field({ description: 'When the series begins.' })
  startDate: Date | null = null;
  @field({ description: 'When the series ends.' })
  endDate: Date | null = null;
  @field({ description: 'How often it repeats.' })
  recurrence = ''; // JSON recurrence pattern (stored as text)
  metadata = ''; // JSON metadata (stored as text)
  externalId = ''; // External system identifier
  source = ''; // Source system (e.g., 'ticketmaster', 'espn')

  // Timestamps
  createdAt = new Date();
  updatedAt = new Date();

  constructor(options: EventSeriesOptions = {}) {
    super(options);

    if (options.typeId) this.typeId = options.typeId;
    if (options.organizerId) this.organizerId = options.organizerId;
    if (options.description !== undefined)
      this.description = options.description;
    if (options.startDate !== undefined)
      this.startDate = options.startDate || null;
    if (options.endDate !== undefined) this.endDate = options.endDate || null;
    if (options.externalId !== undefined) this.externalId = options.externalId;
    if (options.source !== undefined) this.source = options.source;

    // Handle recurrence - can be object or JSON string
    if (options.recurrence !== undefined) {
      if (typeof options.recurrence === 'string') {
        this.recurrence = options.recurrence;
      } else {
        this.recurrence = JSON.stringify(options.recurrence);
      }
    }

    // Handle metadata - can be object or JSON string
    if (options.metadata !== undefined) {
      if (typeof options.metadata === 'string') {
        this.metadata = options.metadata;
      } else {
        this.metadata = JSON.stringify(options.metadata);
      }
    }

    if (options.createdAt) this.createdAt = options.createdAt;
    if (options.updatedAt) this.updatedAt = options.updatedAt;
  }

  /**
   * Get recurrence pattern as parsed object
   *
   * @returns Parsed recurrence pattern or null
   */
  getRecurrence(): RecurrencePattern | null {
    if (!this.recurrence) return null;
    try {
      return JSON.parse(this.recurrence) as RecurrencePattern;
    } catch {
      return null;
    }
  }

  /**
   * Set recurrence pattern from object
   *
   * @param pattern - Recurrence pattern to store
   */
  setRecurrence(pattern: RecurrencePattern): void {
    this.recurrence = JSON.stringify(pattern);
  }

  /**
   * Expand this series' recurrence into occurrence start instants within a
   * window. The first occurrence is `startDate` (or `options.start`); its
   * wall-clock time in the time zone is kept for every occurrence, and
   * `endDate` caps the series like an inclusive `until`.
   *
   * @param rangeStart - Inclusive window start
   * @param rangeEnd - Inclusive window end
   * @param options - Time zone (defaults to the pattern's `timeZone`, then UTC) and optional first occurrence
   * @returns Occurrence start instants, or an empty array without a pattern or start
   */
  getOccurrences(
    rangeStart: Date,
    rangeEnd: Date,
    options: { timeZone?: string; start?: Date; limit?: number } = {},
  ): Date[] {
    const pattern = this.getRecurrence();
    const start = options.start ?? this.startDate;
    if (!pattern || !start) return [];
    const end =
      this.endDate && this.endDate.getTime() < rangeEnd.getTime()
        ? this.endDate
        : rangeEnd;
    return expandRecurrence(pattern, {
      start,
      rangeStart,
      rangeEnd: end,
      timeZone: options.timeZone,
      limit: options.limit,
    });
  }

  /**
   * Get metadata as parsed object
   *
   * @returns Parsed metadata object or empty object
   */
  getMetadata(): Record<string, unknown> {
    if (!this.metadata) return {};
    try {
      return JSON.parse(this.metadata);
    } catch {
      return {};
    }
  }

  /**
   * Set metadata from object
   *
   * @param data - Metadata object to store
   */
  setMetadata(data: Record<string, unknown>): void {
    this.metadata = JSON.stringify(data);
  }

  /**
   * Update metadata by merging with existing values
   *
   * @param updates - Partial metadata to merge
   */
  updateMetadata(updates: Record<string, unknown>): void {
    const current = this.getMetadata();
    this.setMetadata({ ...current, ...updates });
  }

  /**
   * Get the event type for this series
   *
   * @returns EventType instance or null
   */
  async getType() {
    if (!this.typeId) return null;

    const { EventTypeCollection } = await import(
      '../collections/EventTypeCollection'
    );
    const collection = await EventTypeCollection.create(this.options);

    return await collection.get({ id: this.typeId });
  }

  /**
   * Get the organizer profile for this series
   *
   * @returns Profile instance or null
   */
  async getOrganizer() {
    if (!this.organizerId) return null;

    // Import Profile from @happyvertical/smrt-profiles
    try {
      const { ProfileCollection } = await import(
        '@happyvertical/smrt-profiles'
      );
      const collection = await ProfileCollection.create(this.options);

      return await collection.get({ id: this.organizerId });
    } catch {
      // @happyvertical/smrt-profiles not available
      return null;
    }
  }

  /**
   * Get all events in this series
   *
   * @returns Array of Event instances
   */
  async getEvents() {
    const { EventCollection } = await import('../collections/EventCollection');
    const collection = await EventCollection.create(this.options);

    return await collection.list({ where: { seriesId: this.id } });
  }

  /**
   * Check if series is currently active
   *
   * @returns True if current date is between start and end
   */
  isActive(): boolean {
    const now = new Date();
    if (this.startDate && now < this.startDate) return false;
    if (this.endDate && now > this.endDate) return false;
    return true;
  }
}
