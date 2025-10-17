/**
 * EventSeries model - Groups related events (season, tour, conference, etc.)
 *
 * Examples: '2024 NBA Finals', 'Summer Tour 2024', 'Town Council 2024'
 */

import { SmrtObject, type SmrtObjectOptions, smrt } from '@smrt/core';
import type { EventSeriesOptions, RecurrencePattern } from '../types';

@smrt({
  api: { include: ['list', 'get', 'create', 'update', 'delete'] },
  mcp: { include: ['list', 'get', 'create', 'update'] },
  cli: true,
})
export class EventSeries extends SmrtObject {
  // id, slug, name inherited from SmrtObject

  typeId = ''; // FK to EventType
  organizerId = ''; // FK to Profile (from @smrt/profiles)
  description = '';
  startDate: Date | null = null;
  endDate: Date | null = null;
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
   * Get metadata as parsed object
   *
   * @returns Parsed metadata object or empty object
   */
  getMetadata(): Record<string, any> {
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
  setMetadata(data: Record<string, any>): void {
    this.metadata = JSON.stringify(data);
  }

  /**
   * Update metadata by merging with existing values
   *
   * @param updates - Partial metadata to merge
   */
  updateMetadata(updates: Record<string, any>): void {
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

    // Import Profile from @smrt/profiles
    try {
      const { ProfileCollection } = await import('@smrt/profiles');
      const collection = await ProfileCollection.create(this.options);

      return await collection.get({ id: this.organizerId });
    } catch {
      // @smrt/profiles not available
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
