import { SmrtCollection } from '@smrt/core';
import { EventParticipant } from '../models/EventParticipant';
import { ParticipantRole, ParticipantSearchFilters } from '../types';
export declare class EventParticipantCollection extends SmrtCollection<EventParticipant> {
    static readonly _itemClass: typeof EventParticipant;
    /**
     * Get participants for an event
     *
     * @param eventId - Event ID
     * @returns Array of EventParticipant instances
     */
    getByEvent(eventId: string): Promise<EventParticipant[]>;
    /**
     * Get events for a participant (profile)
     *
     * @param profileId - Profile ID
     * @returns Array of EventParticipant instances
     */
    getByProfile(profileId: string): Promise<EventParticipant[]>;
    /**
     * Get participants by role for an event
     *
     * @param eventId - Event ID
     * @param role - Participant role
     * @returns Array of EventParticipant instances
     */
    getByRole(eventId: string, role: ParticipantRole | string): Promise<EventParticipant[]>;
    /**
     * Get participants ordered by placement
     *
     * @param eventId - Event ID
     * @returns Array of EventParticipant instances sorted by placement
     */
    getByPlacement(eventId: string): Promise<EventParticipant[]>;
    /**
     * Get participants by group
     *
     * @param eventId - Event ID
     * @param groupId - Group ID
     * @returns Array of EventParticipant instances
     */
    getByGroup(eventId: string, groupId: string): Promise<EventParticipant[]>;
    /**
     * Get home participant(s) (placement = 0)
     *
     * @param eventId - Event ID
     * @returns Array of EventParticipant instances with placement 0
     */
    getHome(eventId: string): Promise<EventParticipant[]>;
    /**
     * Get away participant(s) (placement = 1)
     *
     * @param eventId - Event ID
     * @returns Array of EventParticipant instances with placement 1
     */
    getAway(eventId: string): Promise<EventParticipant[]>;
    /**
     * Search participants with filters
     *
     * @param filters - Filter criteria
     * @returns Array of matching EventParticipant instances
     */
    search(filters: ParticipantSearchFilters): Promise<EventParticipant[]>;
    /**
     * Get participant statistics for a profile
     *
     * @param profileId - Profile ID
     * @param eventTypeId - Optional event type filter
     * @returns Statistics object
     */
    getParticipantStats(profileId: string, eventTypeId?: string): Promise<{
        totalEvents: number;
        byRole: Record<string, number>;
        byPlacement: Record<number, number>;
    }>;
}
//# sourceMappingURL=EventParticipantCollection.d.ts.map