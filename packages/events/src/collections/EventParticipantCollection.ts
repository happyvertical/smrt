/**
 * EventParticipantCollection — junction collection for Event ↔ Profile links.
 *
 * The generic junction surface (byLeft/byRight/attach/detach/setLinks) comes
 * from `SmrtJunction`. Domain-specific helpers (placement-ordered queries,
 * home/away accessors, statistics, tenant scoping) live alongside.
 */

import { SmrtJunction } from '@happyvertical/smrt-core';
import { EventParticipant } from '../models/EventParticipant';
import type { ParticipantSearchFilters } from '../types';

export class EventParticipantCollection extends SmrtJunction<EventParticipant> {
  static readonly _itemClass = EventParticipant;
  protected leftField = 'eventId';
  protected rightField = 'profileId';
  // EventParticipant rows have no sortOrder column; placement is domain ordering.
  protected sortField: string | null = null;

  // ============================================
  // Domain helpers
  // ============================================

  /**
   * Get participants ordered by placement (nulls last).
   */
  async getByPlacement(eventId: string): Promise<EventParticipant[]> {
    const participants = await this.byLeft(eventId);

    return participants.sort((a, b) => {
      if (a.placement === null && b.placement === null) return 0;
      if (a.placement === null) return 1;
      if (b.placement === null) return -1;
      return a.placement - b.placement;
    });
  }

  /**
   * Get participants by group within an event.
   */
  async getByGroup(
    eventId: string,
    groupId: string,
  ): Promise<EventParticipant[]> {
    return this.byLeft(eventId, { groupId });
  }

  /**
   * Get the home participant(s) — placement = 0.
   */
  async getHome(eventId: string): Promise<EventParticipant[]> {
    return this.byLeft(eventId, { placement: 0 });
  }

  /**
   * Get the away participant(s) — placement = 1.
   */
  async getAway(eventId: string): Promise<EventParticipant[]> {
    return this.byLeft(eventId, { placement: 1 });
  }

  /**
   * Search participants with optional filters.
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
   * Get participation statistics for a profile, optionally filtered by event type.
   */
  async getParticipantStats(
    profileId: string,
    eventTypeId?: string,
  ): Promise<{
    totalEvents: number;
    byRole: Record<string, number>;
    byPlacement: Record<number, number>;
  }> {
    const participants = await this.byRight(profileId);

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

    const byRole: Record<string, number> = {};
    const byPlacement: Record<number, number> = {};

    for (const participant of filteredParticipants) {
      byRole[participant.role] = (byRole[participant.role] || 0) + 1;

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

  // ============================================
  // Tenant helpers
  // ============================================

  async findByTenant(tenantId: string): Promise<EventParticipant[]> {
    return this.list({ where: { tenantId } });
  }

  async findGlobal(): Promise<EventParticipant[]> {
    return this.list({ where: { tenantId: null } });
  }

  async findWithGlobals(tenantId: string): Promise<EventParticipant[]> {
    return this.query(
      `SELECT * FROM ${this.tableName} WHERE tenant_id = ? OR tenant_id IS NULL`,
      [tenantId],
    );
  }
}
