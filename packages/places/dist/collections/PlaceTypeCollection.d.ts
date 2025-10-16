import { SmrtCollection } from '@smrt/core';
import { PlaceType } from '../models/PlaceType';
export declare class PlaceTypeCollection extends SmrtCollection<PlaceType> {
    static readonly _itemClass: typeof PlaceType;
    /**
     * Get or create a place type by slug
     *
     * @param slug - PlaceType slug (e.g., 'city', 'building')
     * @param name - Optional display name (defaults to capitalized slug)
     * @returns PlaceType instance
     */
    getOrCreate(slug: string, name?: string): Promise<PlaceType>;
    /**
     * Get a place type by slug
     *
     * @param slug - PlaceType slug to search for
     * @returns PlaceType instance or null if not found
     */
    getBySlug(slug: string): Promise<PlaceType | null>;
    /**
     * Initialize default place types
     *
     * Creates standard types if they don't exist:
     * - country
     * - region (state/province)
     * - city
     * - address
     * - building
     * - room
     * - zone (for abstract/virtual places)
     *
     * @returns Array of created/existing place types
     */
    initializeDefaults(): Promise<PlaceType[]>;
}
//# sourceMappingURL=PlaceTypeCollection.d.ts.map