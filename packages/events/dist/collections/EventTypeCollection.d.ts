import { SmrtCollection } from '@smrt/core';
import { EventType } from '../models/EventType';
export declare class EventTypeCollection extends SmrtCollection<EventType> {
    static readonly _itemClass: typeof EventType;
    /**
     * Get or create an event type by slug
     *
     * @param slug - EventType slug (e.g., 'basketball-game', 'concert')
     * @param name - Optional display name (defaults to capitalized slug)
     * @returns EventType instance
     */
    getOrCreate(slug: string, name?: string): Promise<EventType>;
    /**
     * Get an event type by slug
     *
     * @param slug - EventType slug to search for
     * @returns EventType instance or null if not found
     */
    getBySlug(slug: string): Promise<EventType | null>;
    /**
     * Initialize default event types
     *
     * Creates common event types if they don't exist:
     * - Sports: game, period, goal, assist, penalty
     * - Entertainment: concert, performance, song
     * - Professional: conference, session, presentation, workshop
     * - Community: meeting, agenda-item, motion, vote
     *
     * @returns Array of created/existing event types
     */
    initializeDefaults(): Promise<EventType[]>;
}
//# sourceMappingURL=EventTypeCollection.d.ts.map