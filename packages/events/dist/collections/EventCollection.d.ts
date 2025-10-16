import { SmrtCollection } from '../../../../core/smrt/src';
import { Event } from '../models/Event';
import { EventSearchFilters, EventStatus } from '../types';
export declare class EventCollection extends SmrtCollection<Event> {
    static readonly _itemClass: typeof Event;
    /**
     * Get events by series
     *
     * @param seriesId - EventSeries ID
     * @returns Array of Event instances
     */
    getBySeriesId(seriesId: string): Promise<Event[]>;
    /**
     * Get events at a specific place
     *
     * @param placeId - Place ID
     * @returns Array of Event instances
     */
    getByPlace(placeId: string): Promise<Event[]>;
    /**
     * Get events by date range
     *
     * @param startDate - Start of date range
     * @param endDate - End of date range
     * @returns Array of Event instances
     */
    getByDateRange(startDate: Date, endDate: Date): Promise<Event[]>;
    /**
     * Get upcoming events
     *
     * @param limit - Maximum number of events to return
     * @returns Array of Event instances starting in the future
     */
    getUpcoming(limit?: number): Promise<Event[]>;
    /**
     * Get events by status
     *
     * @param status - Event status to filter by
     * @returns Array of Event instances
     */
    getByStatus(status: EventStatus): Promise<Event[]>;
    /**
     * Get events by type
     *
     * @param typeId - EventType ID
     * @returns Array of Event instances
     */
    getByType(typeId: string): Promise<Event[]>;
    /**
     * Get root events (no parent)
     *
     * @returns Array of Event instances with no parent
     */
    getRootEvents(): Promise<Event[]>;
    /**
     * Get children of a parent event
     *
     * @param parentEventId - Parent event ID
     * @returns Array of child Event instances
     */
    getByParent(parentEventId: string): Promise<Event[]>;
    /**
     * Get full event tree (hierarchy)
     *
     * @param eventId - Root event ID
     * @returns Object with root event and nested children
     */
    getEventTree(eventId: string): Promise<Event | null>;
    /**
     * Search events with filters
     *
     * @param query - Search query for name/description
     * @param filters - Additional filter criteria
     * @returns Array of matching Event instances
     */
    search(query: string, filters?: EventSearchFilters): Promise<Event[]>;
    /**
     * Get events in progress
     *
     * @returns Array of Event instances currently in progress
     */
    getInProgress(): Promise<Event[]>;
}
//# sourceMappingURL=EventCollection.d.ts.map