import { SmrtObject } from '@smrt/core';
import { EventTypeOptions } from '../types';
export declare class EventType extends SmrtObject {
    description: string;
    schema: string;
    participantSchema: string;
    createdAt: Date;
    updatedAt: Date;
    constructor(options?: EventTypeOptions);
    /**
     * Get schema as parsed object
     *
     * @returns Parsed schema object or empty object if no schema
     */
    getSchema(): Record<string, any>;
    /**
     * Set schema from object
     *
     * @param data - Schema object to store
     */
    setSchema(data: Record<string, any>): void;
    /**
     * Get participant schema as parsed object
     *
     * @returns Parsed participant schema object or empty object
     */
    getParticipantSchema(): Record<string, any>;
    /**
     * Set participant schema from object
     *
     * @param data - Participant schema object to store
     */
    setParticipantSchema(data: Record<string, any>): void;
    /**
     * Convenience method for slug-based lookup
     *
     * @param slug - The slug to search for
     * @returns EventType instance or null if not found
     */
    static getBySlug(slug: string): Promise<EventType | null>;
}
//# sourceMappingURL=EventType.d.ts.map