import { SmrtObject } from '../../../../core/smrt/src';
import { EventParticipantOptions } from '../types';
export declare class EventParticipant extends SmrtObject {
    eventId: string;
    profileId: string;
    role: string;
    placement: number | null;
    groupId: string;
    metadata: string;
    externalId: string;
    source: string;
    createdAt: Date;
    updatedAt: Date;
    constructor(options?: EventParticipantOptions);
    /**
     * Get metadata as parsed object
     *
     * @returns Parsed metadata object or empty object
     */
    getMetadata(): Record<string, any>;
    /**
     * Set metadata from object
     *
     * @param data - Metadata object to store
     */
    setMetadata(data: Record<string, any>): void;
    /**
     * Update metadata by merging with existing values
     *
     * @param updates - Partial metadata to merge
     */
    updateMetadata(updates: Record<string, any>): void;
    /**
     * Get the event for this participant
     *
     * @returns Event instance or null
     */
    getEvent(): Promise<any>;
    /**
     * Get the profile for this participant
     *
     * @returns Profile instance or null
     */
    getProfile(): Promise<any>;
    /**
     * Get group participants (others with same groupId)
     *
     * @returns Array of EventParticipant instances
     */
    getGroupParticipants(): Promise<EventParticipant[]>;
    /**
     * Check if this is a home participant (placement = 0)
     *
     * @returns True if placement is 0
     */
    isHome(): boolean;
    /**
     * Check if this is an away participant (placement = 1)
     *
     * @returns True if placement is 1
     */
    isAway(): boolean;
}
//# sourceMappingURL=EventParticipant.d.ts.map