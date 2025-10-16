import { SmrtCollection } from '@smrt/core';
import { EventSeries } from '../models/EventSeries';
import { EventSeriesSearchFilters } from '../types';
export declare class EventSeriesCollection extends SmrtCollection<EventSeries> {
    static readonly _itemClass: typeof EventSeries;
    /**
     * Get series by organizer
     *
     * @param organizerId - Profile ID of the organizer
     * @returns Array of EventSeries instances
     */
    getByOrganizer(organizerId: string): Promise<EventSeries[]>;
    /**
     * Get currently active series
     *
     * @returns Array of EventSeries instances active today
     */
    getActive(): Promise<EventSeries[]>;
    /**
     * Get upcoming series
     *
     * @param limit - Maximum number of series to return
     * @returns Array of EventSeries instances starting in the future
     */
    getUpcoming(limit?: number): Promise<EventSeries[]>;
    /**
     * Get series by type
     *
     * @param typeId - EventType ID
     * @returns Array of EventSeries instances
     */
    getByType(typeId: string): Promise<EventSeries[]>;
    /**
     * Search series with filters
     *
     * @param query - Search query for name/description
     * @param filters - Additional filter criteria
     * @returns Array of matching EventSeries instances
     */
    search(query: string, filters?: EventSeriesSearchFilters): Promise<EventSeries[]>;
}
//# sourceMappingURL=EventSeriesCollection.d.ts.map