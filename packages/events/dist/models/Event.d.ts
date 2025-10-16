import { SmrtObject } from '../../../../core/smrt/src';
import { EventOptions, EventStatus } from '../types';
export declare class Event extends SmrtObject {
    seriesId: string;
    parentEventId: string;
    typeId: string;
    placeId: string;
    description: string;
    startDate: Date | null;
    endDate: Date | null;
    status: EventStatus;
    round: number | null;
    metadata: string;
    externalId: string;
    source: string;
    createdAt: Date;
    updatedAt: Date;
    constructor(options?: EventOptions);
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
     * Update event status
     *
     * @param newStatus - New status to set
     */
    updateStatus(newStatus: EventStatus): Promise<void>;
    /**
     * Get the series for this event
     *
     * @returns EventSeries instance or null
     */
    getSeries(): Promise<any>;
    /**
     * Get the event type
     *
     * @returns EventType instance or null
     */
    getType(): Promise<any>;
    /**
     * Get the place for this event
     *
     * @returns Place instance or null
     */
    getPlace(): Promise<any>;
    /**
     * Get the parent event
     *
     * @returns Parent Event instance or null
     */
    getParent(): Promise<Event | null>;
    /**
     * Get immediate child events
     *
     * @returns Array of child Event instances
     */
    getChildren(): Promise<Event[]>;
    /**
     * Get all ancestor events (recursive)
     *
     * @returns Array of ancestor events from root to immediate parent
     */
    getAncestors(): Promise<Event[]>;
    /**
     * Get all descendant events (recursive)
     *
     * @returns Array of all descendant events
     */
    getDescendants(): Promise<Event[]>;
    /**
     * Get root event (top-level event with no parent)
     *
     * @returns Root event instance
     */
    getRootEvent(): Promise<Event>;
    /**
     * Get full hierarchy for this event
     *
     * @returns Object with ancestors, current, and descendants
     */
    getHierarchy(): Promise<{
        ancestors: Event[];
        current: Event;
        descendants: Event[];
    }>;
    /**
     * Get all participants for this event
     *
     * @returns Array of EventParticipant instances
     */
    getParticipants(): Promise<any>;
    /**
     * Check if event is currently in progress
     *
     * @returns True if current time is between start and end
     */
    isInProgress(): boolean;
    /**
     * Check if event is a root event (no parent)
     *
     * @returns True if parentEventId is empty
     */
    isRoot(): boolean;
}
//# sourceMappingURL=Event.d.ts.map