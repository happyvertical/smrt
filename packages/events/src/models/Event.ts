/**
 * Event model - Hierarchical event instances
 *
 * Infinitely nestable: Game → Period → Goal → Assist
 */

import { SmrtObject, smrt } from '@smrt/core';
import type { EventOptions, EventStatus } from '../types';

@smrt({
  api: { include: ['list', 'get', 'create', 'update', 'delete'] },
  mcp: { include: ['list', 'get', 'create', 'update'] },
  cli: true,
})
export class Event extends SmrtObject {
  // id, slug, name inherited from SmrtObject

  seriesId = ''; // FK to EventSeries (nullable for standalone events)
  parentEventId = ''; // FK to Event (nullable, self-referencing for hierarchy)
  typeId = ''; // FK to EventType
  placeId = ''; // FK to Place (from @smrt/places)
  description = '';
  startDate: Date | null = null;
  endDate: Date | null = null;
  status: EventStatus = 'scheduled';
  round: number | null = null; // Sequence/round number in series
  metadata = ''; // JSON metadata (stored as text)
  externalId = ''; // External system identifier
  source = ''; // Source system

  // Timestamps
  createdAt = new Date();
  updatedAt = new Date();

  constructor(options: EventOptions = {}) {
    super(options);

    if (options.seriesId !== undefined) this.seriesId = options.seriesId;
    if (options.parentEventId !== undefined)
      this.parentEventId = options.parentEventId;
    if (options.typeId) this.typeId = options.typeId;
    if (options.placeId !== undefined) this.placeId = options.placeId;
    if (options.description !== undefined)
      this.description = options.description;
    if (options.startDate !== undefined)
      this.startDate = options.startDate || null;
    if (options.endDate !== undefined) this.endDate = options.endDate || null;
    if (options.status !== undefined) this.status = options.status;
    if (options.round !== undefined) this.round = options.round;
    if (options.externalId !== undefined) this.externalId = options.externalId;
    if (options.source !== undefined) this.source = options.source;

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
   * Update event status
   *
   * @param newStatus - New status to set
   */
  async updateStatus(newStatus: EventStatus): Promise<void> {
    this.status = newStatus;
    this.updatedAt = new Date();
    await this.save();
  }

  /**
   * Get the series for this event
   *
   * @returns EventSeries instance or null
   */
  async getSeries() {
    if (!this.seriesId) return null;

    const { EventSeriesCollection } = await import(
      '../collections/EventSeriesCollection'
    );
    const collection = await EventSeriesCollection.create(this.options);

    return await collection.get({ id: this.seriesId });
  }

  /**
   * Get the event type
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
   * Get the place for this event
   *
   * @returns Place instance or null
   */
  async getPlace() {
    if (!this.placeId) return null;

    try {
      const { PlaceCollection } = await import('@smrt/places');
      const collection = await PlaceCollection.create(this.options);

      return await collection.get({ id: this.placeId });
    } catch {
      // @smrt/places not available
      return null;
    }
  }

  /**
   * Get the parent event
   *
   * @returns Parent Event instance or null
   */
  async getParent(): Promise<Event | null> {
    if (!this.parentEventId) return null;

    const { EventCollection } = await import('../collections/EventCollection');
    const collection = await EventCollection.create(this.options);

    return await collection.get({ id: this.parentEventId });
  }

  /**
   * Get immediate child events
   *
   * @returns Array of child Event instances
   */
  async getChildren(): Promise<Event[]> {
    const { EventCollection } = await import('../collections/EventCollection');
    const collection = await EventCollection.create(this.options);

    return await collection.list({ where: { parentEventId: this.id } });
  }

  /**
   * Get all ancestor events (recursive)
   *
   * @returns Array of ancestor events from root to immediate parent
   */
  async getAncestors(): Promise<Event[]> {
    const ancestors: Event[] = [];
    let currentEvent: Event | null = this;

    while (currentEvent?.parentEventId) {
      const parent = await currentEvent.getParent();
      if (!parent) break;
      ancestors.unshift(parent); // Add to beginning
      currentEvent = parent;
    }

    return ancestors;
  }

  /**
   * Get all descendant events (recursive)
   *
   * @returns Array of all descendant events
   */
  async getDescendants(): Promise<Event[]> {
    const children = await this.getChildren();
    const descendants: Event[] = [...children];

    for (const child of children) {
      const childDescendants = await child.getDescendants();
      descendants.push(...childDescendants);
    }

    return descendants;
  }

  /**
   * Get root event (top-level event with no parent)
   *
   * @returns Root event instance
   */
  async getRootEvent(): Promise<Event> {
    const ancestors = await this.getAncestors();
    return ancestors.length > 0 ? ancestors[0] : this;
  }

  /**
   * Get full hierarchy for this event
   *
   * @returns Object with ancestors, current, and descendants
   */
  async getHierarchy(): Promise<{
    ancestors: Event[];
    current: Event;
    descendants: Event[];
  }> {
    const [ancestors, descendants] = await Promise.all([
      this.getAncestors(),
      this.getDescendants(),
    ]);

    return {
      ancestors,
      current: this,
      descendants,
    };
  }

  /**
   * Get all participants for this event
   *
   * @returns Array of EventParticipant instances
   */
  async getParticipants() {
    const { EventParticipantCollection } = await import(
      '../collections/EventParticipantCollection'
    );
    const collection = await EventParticipantCollection.create(this.options);

    return await collection.list({ where: { eventId: this.id } });
  }

  /**
   * Check if event is currently in progress
   *
   * @returns True if current time is between start and end
   */
  isInProgress(): boolean {
    if (this.status !== 'in_progress') return false;

    const now = new Date();
    if (this.startDate && now < this.startDate) return false;
    if (this.endDate && now > this.endDate) return false;

    return true;
  }

  /**
   * Check if event is a root event (no parent)
   *
   * @returns True if parentEventId is empty
   */
  isRoot(): boolean {
    return !this.parentEventId;
  }
}
