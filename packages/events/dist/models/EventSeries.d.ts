import { SmrtObject } from '../../../../core/smrt/src';
import { EventSeriesOptions, RecurrencePattern } from '../types';
export declare class EventSeries extends SmrtObject {
    typeId: string;
    organizerId: string;
    description: string;
    startDate: Date | null;
    endDate: Date | null;
    recurrence: string;
    metadata: string;
    externalId: string;
    source: string;
    createdAt: Date;
    updatedAt: Date;
    constructor(options?: EventSeriesOptions);
    /**
     * Get recurrence pattern as parsed object
     *
     * @returns Parsed recurrence pattern or null
     */
    getRecurrence(): RecurrencePattern | null;
    /**
     * Set recurrence pattern from object
     *
     * @param pattern - Recurrence pattern to store
     */
    setRecurrence(pattern: RecurrencePattern): void;
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
     * Get the event type for this series
     *
     * @returns EventType instance or null
     */
    getType(): Promise<any>;
    /**
     * Get the organizer profile for this series
     *
     * @returns Profile instance or null
     */
    getOrganizer(): Promise<any>;
    /**
     * Get all events in this series
     *
     * @returns Array of Event instances
     */
    getEvents(): Promise<any>;
    /**
     * Check if series is currently active
     *
     * @returns True if current date is between start and end
     */
    isActive(): boolean;
}
//# sourceMappingURL=EventSeries.d.ts.map