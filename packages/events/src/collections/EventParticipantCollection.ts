/**
 * EventParticipantCollection — junction collection for Event ↔ Profile links.
 *
 * The generic junction surface (byLeft/byRight/attach/detach/setLinks) comes
 * from `SmrtJunction`. Domain-specific helpers (placement-ordered queries,
 * home/away accessors, statistics, tenant scoping) live alongside.
 */

import { SmrtJunction, smrt } from '@happyvertical/smrt-core';
import { queryGlobal, queryWithGlobals } from '@happyvertical/smrt-tenancy';
import { EventParticipant } from '../models/EventParticipant';
import type { ParticipantSearchFilters } from '../types';

// Decorator with empty config — only needed so the scanner detects the
// class. See FactContentCollection for the full rationale.
@smrt()
export class EventParticipantCollection extends SmrtJunction<EventParticipant> {
  static readonly _itemClass = EventParticipant;
  protected leftField = 'eventId';
  protected rightField = 'profileId';
  // EventParticipant has no sortOrder column; `placement` is domain ordering
  // (0=home, 1=away) and must not be auto-assigned by setLinks.
  protected sortField: string | null = null;
  protected positionField: string | null = null;

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

  /**
   * Find all global participants (no tenant association).
   *
   * Routes through the shared tenant-global helper so it does not throw under
   * an active tenant context (an explicit `tenant_id IS NULL` filter would be
   * flagged as an isolation violation). (#1600)
   */
  async findGlobal(): Promise<EventParticipant[]> {
    return queryGlobal<EventParticipant>(this);
  }

  /**
   * Find participants for a tenant plus all global participants.
   *
   * Fails closed if an active tenant context requests a different tenant's
   * rows; the admin/system path keeps the cross-tenant capability. (#1600)
   */
  async findWithGlobals(tenantId: string): Promise<EventParticipant[]> {
    return queryWithGlobals<EventParticipant>(
      this,
      tenantId,
      'EventParticipant.findWithGlobals',
    );
  }
}
