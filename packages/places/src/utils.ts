/**
 * Utility functions for @have/places package
 */

import type { Location } from '@have/geo';
import type { GeoData } from './types';

/**
 * Map Location type from @have/geo to PlaceType slug
 *
 * @param locationType - Location type from geocoding provider
 * @returns PlaceType slug
 */
export function mapLocationTypeToPlaceType(locationType: string): string {
  const typeMap: Record<string, string> = {
    // Standard types
    country: 'country',
    region: 'region',
    city: 'city',
    address: 'address',
    point_of_interest: 'point_of_interest',

    // Additional mappings
    state: 'region',
    province: 'region',
    town: 'city',
    village: 'city',
    building: 'building',
    room: 'room',
    zone: 'zone',
  };

  return typeMap[locationType.toLowerCase()] || 'address';
}

/**
 * Convert Location from @have/geo to GeoData
 *
 * @param location - Location from geocoding
 * @returns GeoData object
 */
export function locationToGeoData(location: Location): GeoData {
  const components = location.addressComponents || {};

  return {
    latitude: location.latitude,
    longitude: location.longitude,
    streetNumber: components.streetNumber,
    streetName: components.streetName,
    city: components.city,
    region: components.region,
    country: components.country,
    postalCode: components.postalCode,
    countryCode: location.countryCode,
    timezone: location.timezone,
  };
}

/**
 * Validate geographic coordinates
 *
 * @param latitude - Latitude value
 * @param longitude - Longitude value
 * @returns Object with valid flag and optional error message
 */
export function validateCoordinates(
  latitude: number,
  longitude: number,
): { valid: boolean; error?: string } {
  if (latitude < -90 || latitude > 90) {
    return { valid: false, error: 'Invalid latitude (must be -90 to 90)' };
  }

  if (longitude < -180 || longitude > 180) {
    return { valid: false, error: 'Invalid longitude (must be -180 to 180)' };
  }

  return { valid: true };
}

/**
 * Calculate distance between two coordinates using Haversine formula
 *
 * @param lat1 - First latitude
 * @param lng1 - First longitude
 * @param lat2 - Second latitude
 * @param lng2 - Second longitude
 * @returns Distance in kilometers
 */
export function calculateDistance(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const R = 6371; // Earth radius in km
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLng / 2) *
      Math.sin(dLng / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/**
 * Convert degrees to radians
 */
function toRad(degrees: number): number {
  return degrees * (Math.PI / 180);
}

/**
 * Format coordinates as string
 *
 * @param latitude - Latitude value
 * @param longitude - Longitude value
 * @param precision - Number of decimal places (default: 6)
 * @returns Formatted coordinate string
 */
export function formatCoordinates(
  latitude: number,
  longitude: number,
  precision: number = 6,
): string {
  return `${latitude.toFixed(precision)}, ${longitude.toFixed(precision)}`;
}

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
export function parseCoordinates(
  coordString: string,
): { lat: number; lng: number } | null {
  // Remove extra whitespace and split
  const parts = coordString
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/,\s*/g, ',')
    .split(/[,\s]+/);

  if (parts.length !== 2) return null;

  const lat = parseFloat(parts[0]);
  const lng = parseFloat(parts[1]);

  if (isNaN(lat) || isNaN(lng)) return null;

  const validation = validateCoordinates(lat, lng);
  if (!validation.valid) return null;

  return { lat, lng };
}

/**
 * Normalize address components by trimming and removing empty values
 *
 * @param components - Address components
 * @returns Normalized components
 */
export function normalizeAddressComponents(
  components: Partial<GeoData>,
): Partial<GeoData> {
  const normalized: Partial<GeoData> = {};

  for (const [key, value] of Object.entries(components)) {
    if (value === null || value === undefined) continue;

    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed) {
        normalized[key as keyof GeoData] = trimmed as any;
      }
    } else {
      normalized[key as keyof GeoData] = value as any;
    }
  }

  return normalized;
}

/**
 * Generate a display name from address components
 *
 * @param components - Address components
 * @returns Formatted display name
 */
export function generateDisplayName(components: Partial<GeoData>): string {
  const parts: string[] = [];

  if (components.streetNumber && components.streetName) {
    parts.push(`${components.streetNumber} ${components.streetName}`);
  } else if (components.streetName) {
    parts.push(components.streetName);
  }

  if (components.city) parts.push(components.city);
  if (components.region) parts.push(components.region);
  if (components.country) parts.push(components.country);

  return parts.join(', ');
}

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
export function areCoordinatesNear(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
  thresholdKm: number = 0.1,
): boolean {
  const distance = calculateDistance(lat1, lng1, lat2, lng2);
  return distance <= thresholdKm;
}
