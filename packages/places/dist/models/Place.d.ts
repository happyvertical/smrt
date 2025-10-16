import { SmrtObject } from '@smrt/core';
import { PlaceOptions, GeoData } from '../types';
export declare class Place extends SmrtObject {
    typeId: string;
    parentId: string;
    name: string;
    description: string;
    latitude: number | null;
    longitude: number | null;
    streetNumber: string;
    streetName: string;
    city: string;
    region: string;
    country: string;
    postalCode: string;
    countryCode: string;
    timezone: string;
    externalId: string;
    source: string;
    metadata: string;
    createdAt: Date;
    updatedAt: Date;
    constructor(options?: PlaceOptions);
    /**
     * Get geographic data for this place
     *
     * @returns GeoData object with all geo fields
     */
    getGeoData(): GeoData;
    /**
     * Check if this place has geographic coordinates
     *
     * @returns True if latitude and longitude are set
     */
    hasCoordinates(): boolean;
    /**
     * Get metadata as parsed object
     *
     * @returns Parsed metadata object or empty object if no metadata
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
     * Get the place type
     *
     * @returns PlaceType instance or null if not found
     */
    getType(): Promise<any>;
    /**
     * Get the parent place
     *
     * @returns Parent Place instance or null if no parent
     */
    getParent(): Promise<Place | null>;
    /**
     * Get immediate child places
     *
     * @returns Array of child Place instances
     */
    getChildren(): Promise<Place[]>;
    /**
     * Get all ancestor places (recursive)
     *
     * @returns Array of ancestor places from root to immediate parent
     */
    getAncestors(): Promise<Place[]>;
    /**
     * Get all descendant places (recursive)
     *
     * @returns Array of all descendant places
     */
    getDescendants(): Promise<Place[]>;
    /**
     * Get full hierarchy for this place
     *
     * @returns PlaceHierarchy with ancestors, current, and descendants
     */
    getHierarchy(): Promise<{
        ancestors: Place[];
        current: Place;
        descendants: Place[];
    }>;
}
//# sourceMappingURL=Place.d.ts.map