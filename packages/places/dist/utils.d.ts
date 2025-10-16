import { Location } from '@have/geo';
import { GeoData } from './types';
/**
 * Map Location type from @have/geo to PlaceType slug
 *
 * @param locationType - Location type from geocoding provider
 * @returns PlaceType slug
 */
export declare function mapLocationTypeToPlaceType(locationType: string): string;
/**
 * Convert Location from @have/geo to GeoData
 *
 * @param location - Location from geocoding
 * @returns GeoData object
 */
export declare function locationToGeoData(location: Location): GeoData;
/**
 * Validate geographic coordinates
 *
 * @param latitude - Latitude value
 * @param longitude - Longitude value
 * @returns Object with valid flag and optional error message
 */
export declare function validateCoordinates(latitude: number, longitude: number): {
    valid: boolean;
    error?: string;
};
/**
 * Calculate distance between two coordinates using Haversine formula
 *
 * @param lat1 - First latitude
 * @param lng1 - First longitude
 * @param lat2 - Second latitude
 * @param lng2 - Second longitude
 * @returns Distance in kilometers
 */
export declare function calculateDistance(lat1: number, lng1: number, lat2: number, lng2: number): number;
/**
 * Format coordinates as string
 *
 * @param latitude - Latitude value
 * @param longitude - Longitude value
 * @param precision - Number of decimal places (default: 6)
 * @returns Formatted coordinate string
 */
export declare function formatCoordinates(latitude: number, longitude: number, precision?: number): string;
/**
 * Parse coordinate string to lat/lng
 *
 * Supports formats:
 * - "lat, lng"
 * - "lat,lng"
 * - "lat lng"
 *
 * @param coordString - Coordinate string
 * @returns Object with lat and lng, or null if invalid
 */
export declare function parseCoordinates(coordString: string): {
    lat: number;
    lng: number;
} | null;
/**
 * Normalize address components by trimming and removing empty values
 *
 * @param components - Address components
 * @returns Normalized components
 */
export declare function normalizeAddressComponents(components: Partial<GeoData>): Partial<GeoData>;
/**
 * Generate a display name from address components
 *
 * @param components - Address components
 * @returns Formatted display name
 */
export declare function generateDisplayName(components: Partial<GeoData>): string;
/**
 * Check if two coordinates are within a threshold distance
 *
 * @param lat1 - First latitude
 * @param lng1 - First longitude
 * @param lat2 - Second latitude
 * @param lng2 - Second longitude
 * @param thresholdKm - Distance threshold in kilometers
 * @returns True if coordinates are within threshold
 */
export declare function areCoordinatesNear(lat1: number, lng1: number, lat2: number, lng2: number, thresholdKm?: number): boolean;
//# sourceMappingURL=utils.d.ts.map