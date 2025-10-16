import { SmrtCollection } from '@smrt/core';
import { Place } from '../models/Place';
import { LookupOrCreateOptions } from '../types';
export declare class PlaceCollection extends SmrtCollection<Place> {
    static readonly _itemClass: typeof Place;
    /**
     * Look up a place by query or coordinates, creating it if not found
     *
     * This is the key method for organic database growth:
     * 1. Search local database first
     * 2. If not found, query @have/geo
     * 3. Create place from geocoding result
     * 4. Return place
     *
     * @param query - Address or location query string
     * @param options - Lookup options (provider, type, parent, etc.)
     * @returns Place instance
     */
    lookupOrCreate(query: string, options?: LookupOrCreateOptions): Promise<Place | null>;
    /**
     * Find place by coordinates (within small threshold)
     *
     * @param latitude - Latitude to search
     * @param longitude - Longitude to search
     * @param threshold - Max distance in degrees (default: 0.0001 ~11m)
     * @returns Place instance or null
     */
    private findByCoordinates;
    /**
     * Find place by query text (matches name, city, region, country)
     *
     * @param query - Search query
     * @returns Place instance or null
     */
    private findByQuery;
    /**
     * Geocode query or coordinates using @have/geo
     *
     * @param query - Address query
     * @param coords - Optional coordinates for reverse geocoding
     * @param provider - Geo provider to use
     * @returns Array of Location results
     */
    private geocode;
    /**
     * Create place from @have/geo Location data
     *
     * @param location - Location from geocoding
     * @param typeSlug - Optional type slug override
     * @param parentId - Optional parent place ID
     * @returns Created Place instance
     */
    private createFromLocation;
    /**
     * Get immediate children of a parent place
     *
     * @param parentId - The parent place ID
     * @returns Array of child places
     */
    getChildren(parentId: string): Promise<Place[]>;
    /**
     * Get root places (no parent)
     *
     * @returns Array of root places
     */
    getRootPlaces(): Promise<Place[]>;
    /**
     * Get places by type
     *
     * @param typeSlug - PlaceType slug
     * @returns Array of places of that type
     */
    getByType(typeSlug: string): Promise<Place[]>;
    /**
     * Get place hierarchy (all ancestors and descendants)
     *
     * @param placeId - The place ID
     * @returns Object with ancestors, current place, and descendants
     */
    getHierarchy(placeId: string): Promise<{
        ancestors: Place[];
        current: Place;
        descendants: Place[];
    }>;
    /**
     * Search places by proximity to coordinates
     *
     * @param latitude - Center latitude
     * @param longitude - Center longitude
     * @param radiusKm - Search radius in kilometers
     * @returns Array of places within radius, sorted by distance
     */
    searchByProximity(latitude: number, longitude: number, radiusKm?: number): Promise<Place[]>;
    /**
     * Calculate distance between two coordinates using Haversine formula
     *
     * @param lat1 - First latitude
     * @param lng1 - First longitude
     * @param lat2 - Second latitude
     * @param lng2 - Second longitude
     * @returns Distance in kilometers
     */
    private calculateDistance;
    /**
     * Convert degrees to radians
     */
    private toRad;
}
//# sourceMappingURL=PlaceCollection.d.ts.map