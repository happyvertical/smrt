/**
 * EventParticipantCollection - Collection manager for EventParticipant objects
 *
 * Provides queries for participants by event, profile, role, and placement.
 */

import { SmrtCollection } from '@have/smrt';
import { EventParticipant } from '../models/EventParticipant';
import type { ParticipantRole, ParticipantSearchFilters } from '../types';

export class EventParticipantCollection extends SmrtCollection<EventParticipant> {
  static readonly _itemClass = EventParticipant;

  /**
   * Get participants for an event
   *
   * @param eventId - Event ID
   * @returns Array of EventParticipant instances
   */
  async getByEvent(eventId: string): Promise<EventParticipant[]> {
    return await this.list({ where: { eventId } });
  }

  /**
   * Get events for a participant (profile)
   *
   * @param profileId - Profile ID
   * @returns Array of EventParticipant instances
   */
  async getByProfile(profileId: string): Promise<EventParticipant[]> {
    return await this.list({ where: { profileId } });
  }

  /**
   * Get participants by role for an event
   *
   * @param eventId - Event ID
   * @param role - Participant role
   * @returns Array of EventParticipant instances
   */
  async getByRole(
    eventId: string,
    role: ParticipantRole | string,
  ): Promise<EventParticipant[]> {
    const participants = await this.getByEvent(eventId);
    return participants.filter((p) => p.role === role);
  }

  /**
   * Get participants ordered by placement
   *
   * @param eventId - Event ID
   * @returns Array of EventParticipant instances sorted by placement
   */
  async getByPlacement(eventId: string): Promise<EventParticipant[]> {
    const participants = await this.getByEvent(eventId);

    return participants.sort((a, b) => {
      if (a.placement === null && b.placement === null) return 0;
      if (a.placement === null) return 1;
      if (b.placement === null) return -1;
      return a.placement - b.placement;
    });
  }

  /**
   * Get participants by group
   *
   * @param eventId - Event ID
   * @param groupId - Group ID
   * @returns Array of EventParticipant instances
   */
  async getByGroup(
    eventId: string,
    groupId: string,
  ): Promise<EventParticipant[]> {
    const participants = await this.getByEvent(eventId);
    return participants.filter((p) => p.groupId === groupId);
  }

  /**
   * Get home participant(s) (placement = 0)
   *
   * @param eventId - Event ID
   * @returns Array of EventParticipant instances with placement 0
   */
  async getHome(eventId: string): Promise<EventParticipant[]> {
    const participants = await this.getByEvent(eventId);
    return participants.filter((p) => p.placement === 0);
  }

  /**
   * Get away participant(s) (placement = 1)
   *
   * @param eventId - Event ID
   * @returns Array of EventParticipant instances with placement 1
   */
  async getAway(eventId: string): Promise<EventParticipant[]> {
    const participants = await this.getByEvent(eventId);
    return participants.filter((p) => p.placement === 1);
  }

  /**
   * Search participants with filters
   *
   * @param filters - Filter criteria
   * @returns Array of matching EventParticipant instances
   */
  async search(filters: ParticipantSearchFilters): Promise<EventParticipant[]> {
    let participants = await this.list({});

    if (filters.eventId) {
      participants = participants.filter((p) => p.eventId === filters.eventId);
    }
    if (filters.profileId) {
      participants = participants.filter(
        (p) => p.profileId === filters.profileId,
      );
    }
    if (filters.role) {
      participants = participants.filter((p) => p.role === filters.role);
    }
    if (filters.groupId) {
      participants = participants.filter((p) => p.groupId === filters.groupId);
    }

    return participants;
  }

  /**
   * Get participant statistics for a profile
   *
   * @param profileId - Profile ID
   * @param eventTypeId - Optional event type filter
   * @returns Statistics object
   */
  async getParticipantStats(
    profileId: string,
    eventTypeId?: string,
  ): Promise<{
    totalEvents: number;
    byRole: Record<string, number>;
    byPlacement: Record<number, number>;
  }> {
    const participants = await this.getByProfile(profileId);

    // Filter by event type if provided
    let filteredParticipants = participants;
    if (eventTypeId) {
      filteredParticipants = [];
      for (const participant of participants) {
        const event = await participant.getEvent();
        if (event && event.typeId === eventTypeId) {
          filteredParticipants.push(participant);
        }
      }
    }

    // Calculate statistics
    const byRole: Record<string, number> = {};
    const byPlacement: Record<number, number> = {};

    for (const participant of filteredParticipants) {
      // Count by role
      byRole[participant.role] = (byRole[participant.role] || 0) + 1;

      // Count by placement
      if (participant.placement !== null) {
        byPlacement[participant.placement] =
          (byPlacement[participant.placement] || 0) + 1;
      }
    }

    return {
      totalEvents: filteredParticipants.length,
      byRole,
      byPlacement,
    };
  }
}
