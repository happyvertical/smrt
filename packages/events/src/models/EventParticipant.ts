/**
 * EventParticipant model - Links participants to events
 *
 * Tracks who participated in an event with role and placement
 */

import { SmrtObject, type SmrtObjectOptions, smrt } from '@smrt/core';
import type { EventParticipantOptions, ParticipantRole } from '../types';

@smrt({
  api: { include: ['list', 'get', 'create', 'update', 'delete'] },
  mcp: { include: ['list', 'get', 'create', 'update'] },
  cli: true,
})
export class EventParticipant extends SmrtObject {
  // id inherited from SmrtObject

  eventId = ''; // FK to Event
  profileId = ''; // FK to Profile (from @have/profiles)
  role: string = ''; // Participant role (ParticipantRole or custom)
  placement: number | null = null; // Numeric position/placement
  groupId = ''; // Optional grouping (e.g., team ID for individual players)
  metadata = ''; // JSON metadata (stored as text)
  externalId = ''; // External system identifier
  source = ''; // Source system

  // Timestamps
  createdAt = new Date();
  updatedAt = new Date();

  constructor(options: EventParticipantOptions = {}) {
    super(options);

    if (options.eventId) this.eventId = options.eventId;
    if (options.profileId) this.profileId = options.profileId;
    if (options.role !== undefined) this.role = options.role;
    if (options.placement !== undefined) this.placement = options.placement;
    if (options.groupId !== undefined) this.groupId = options.groupId;
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
   * Get the event for this participant
   *
   * @returns Event instance or null
   */
  async getEvent() {
    if (!this.eventId) return null;

    const { EventCollection } = await import('../collections/EventCollection');
    const collection = new EventCollection(this.options);
    await collection.initialize();

    return await collection.get({ id: this.eventId });
  }

  /**
   * Get the profile for this participant
   *
   * @returns Profile instance or null
   */
  async getProfile() {
    if (!this.profileId) return null;

    try {
      const { ProfileCollection } = await import('@have/profiles');
      const collection = await ProfileCollection.create(this.options);

      return await collection.get({ id: this.profileId });
    } catch {
      // @have/profiles not available
      return null;
    }
  }

  /**
   * Get group participants (others with same groupId)
   *
   * @returns Array of EventParticipant instances
   */
  async getGroupParticipants(): Promise<EventParticipant[]> {
    if (!this.groupId) return [];

    const { EventParticipantCollection } = await import(
      '../collections/EventParticipantCollection'
    );
    const collection = new EventParticipantCollection(this.options);
    await collection.initialize();

    const participants = await collection.list({
      where: { eventId: this.eventId, groupId: this.groupId },
    });

    // Exclude self from results
    return participants.filter((p) => p.id !== this.id);
  }

  /**
   * Check if this is a home participant (placement = 0)
   *
   * @returns True if placement is 0
   */
  isHome(): boolean {
    return this.placement === 0;
  }

  /**
   * Check if this is an away participant (placement = 1)
   *
   * @returns True if placement is 1
   */
  isAway(): boolean {
    return this.placement === 1;
  }
}
