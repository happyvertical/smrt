/**
 * PlaceCollection - Collection manager for Place objects
 *
 * Provides hierarchy traversal and organic place database growth via
 * lookupOrCreate method that integrates with @have/geo.
 */

import type { Location } from '@have/geo';
import { getGeoAdapter } from '@have/geo';
import { SmrtCollection } from '@smrt/core';
import { Place } from '../models/Place';
import type { LookupOrCreateOptions } from '../types';
import { PlaceTypeCollection } from './PlaceTypeCollection';

export class PlaceCollection extends SmrtCollection<Place> {
  static readonly _itemClass = Place;

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
  async lookupOrCreate(
    query: string,
    options: LookupOrCreateOptions = {},
  ): Promise<Place | null> {
    const {
      geoProvider = 'openstreetmap',
      typeSlug,
      parentId,
      createIfNotFound = true,
      coords,
    } = options;

    // Step 1: Try to find existing place
    let existingPlace: Place | null = null;

    // Search by coordinates if provided
    if (coords) {
      existingPlace = await this.findByCoordinates(coords.lat, coords.lng);
    }

    // Search by query text if coordinates didn't match
    if (!existingPlace) {
      existingPlace = await this.findByQuery(query);
    }

    if (existingPlace) {
      return existingPlace;
    }

    // Step 2: If not found and createIfNotFound is false, return null
    if (!createIfNotFound) {
      return null;
    }

    // Step 3: Query @have/geo for location data
    const locations = await this.geocode(
      query,
      coords,
      geoProvider as 'google' | 'openstreetmap',
    );

    if (locations.length === 0) {
      return null;
    }

    // Use first result (most relevant)
    const location = locations[0];

    // Step 4: Create place from location data
    return await this.createFromLocation(location, typeSlug, parentId);
  }

  /**
   * Find place by coordinates (within small threshold)
   *
   * @param latitude - Latitude to search
   * @param longitude - Longitude to search
   * @param threshold - Max distance in degrees (default: 0.0001 ~11m)
   * @returns Place instance or null
   */
  private async findByCoordinates(
    latitude: number,
    longitude: number,
    threshold: number = 0.0001,
  ): Promise<Place | null> {
    // Get all places with coordinates
    const places = await this.list({
      where: {
        latitude: { $ne: null },
        longitude: { $ne: null },
      },
    });

    // Find closest match within threshold
    for (const place of places) {
      if (place.latitude === null || place.longitude === null) continue;

      const latDiff = Math.abs(place.latitude - latitude);
      const lngDiff = Math.abs(place.longitude - longitude);

      if (latDiff < threshold && lngDiff < threshold) {
        return place;
      }
    }

    return null;
  }

  /**
   * Find place by query text (matches name, city, region, country)
   *
   * @param query - Search query
   * @returns Place instance or null
   */
  private async findByQuery(query: string): Promise<Place | null> {
    const normalizedQuery = query.toLowerCase().trim();

    // Try exact match on name first
    const places = await this.list({});

    for (const place of places) {
      // Match on name
      if (place.name.toLowerCase().includes(normalizedQuery)) {
        return place;
      }

      // Match on full address components
      const addressParts = [
        place.streetNumber,
        place.streetName,
        place.city,
        place.region,
        place.country,
      ]
        .filter((p) => p)
        .join(' ')
        .toLowerCase();

      if (addressParts.includes(normalizedQuery)) {
        return place;
      }
    }

    return null;
  }

  /**
   * Geocode query or coordinates using @have/geo
   *
   * @param query - Address query
   * @param coords - Optional coordinates for reverse geocoding
   * @param provider - Geo provider to use
   * @returns Array of Location results
   */
  private async geocode(
    query: string,
    coords?: { lat: number; lng: number },
    provider: 'google' | 'openstreetmap' = 'openstreetmap',
  ): Promise<Location[]> {
    // Get geo adapter based on provider
    const geoOptions =
      provider === 'google'
        ? {
            provider: 'google' as const,
            apiKey: process.env.GOOGLE_MAPS_API_KEY || '',
          }
        : {
            provider: 'openstreetmap' as const,
            userAgent: '@have/places',
          };

    const geo = await getGeoAdapter(geoOptions);

    // Use reverse geocode if coords provided, otherwise forward geocode
    if (coords) {
      return await geo.reverseGeocode(coords.lat, coords.lng);
    }

    return await geo.lookup(query);
  }

  /**
   * Create place from @have/geo Location data
   *
   * @param location - Location from geocoding
   * @param typeSlug - Optional type slug override
   * @param parentId - Optional parent place ID
   * @returns Created Place instance
   */
  private async createFromLocation(
    location: Location,
    typeSlug?: string,
    parentId?: string,
  ): Promise<Place> {
    // Get or create place type
    const typeCollection = await (PlaceTypeCollection as any).create(
      this.options,
    );

    const slug = typeSlug || location.type || 'address';
    const placeType = await typeCollection.getOrCreate(slug);

    // Extract address components
    const components = location.addressComponents || {};

    // Create place
    return await this.create({
      typeId: placeType.id,
      parentId: parentId || '',
      name: location.name,
      description: '',

      // Geo fields from location
      latitude: location.latitude,
      longitude: location.longitude,
      streetNumber: components.streetNumber || '',
      streetName: components.streetName || '',
      city: components.city || '',
      region: components.region || '',
      country: components.country || '',
      postalCode: components.postalCode || '',
      countryCode: location.countryCode || '',
      timezone: location.timezone || '',

      // Metadata
      externalId: location.id,
      source: location.raw?.provider || 'unknown',
      metadata: { raw: location.raw },
    });
  }

  /**
   * Get immediate children of a parent place
   *
   * @param parentId - The parent place ID
   * @returns Array of child places
   */
  async getChildren(parentId: string): Promise<Place[]> {
    return await this.list({
      where: { parentId },
    });
  }

  /**
   * Get root places (no parent)
   *
   * @returns Array of root places
   */
  async getRootPlaces(): Promise<Place[]> {
    return await this.list({
      where: { parentId: '' },
    });
  }

  /**
   * Get places by type
   *
   * @param typeSlug - PlaceType slug
   * @returns Array of places of that type
   */
  async getByType(typeSlug: string): Promise<Place[]> {
    // Get type ID
    const typeCollection = await (PlaceTypeCollection as any).create(
      this.options,
    );

    const placeType = await typeCollection.getBySlug(typeSlug);
    if (!placeType) return [];

    return await this.list({
      where: { typeId: placeType.id },
    });
  }

  /**
   * Get place hierarchy (all ancestors and descendants)
   *
   * @param placeId - The place ID
   * @returns Object with ancestors, current place, and descendants
   */
  async getHierarchy(placeId: string) {
    const place = await this.get({ id: placeId });
    if (!place) throw new Error(`Place '${placeId}' not found`);

    return await place.getHierarchy();
  }

  /**
   * Search places by proximity to coordinates
   *
   * @param latitude - Center latitude
   * @param longitude - Center longitude
   * @param radiusKm - Search radius in kilometers
   * @returns Array of places within radius, sorted by distance
   */
  async searchByProximity(
    latitude: number,
    longitude: number,
    radiusKm: number = 10,
  ): Promise<Place[]> {
    // Get all places with coordinates
    const places = await this.list({
      where: {
        latitude: { $ne: null },
        longitude: { $ne: null },
      },
    });

    // Calculate distances and filter by radius
    const placesWithDistance = places
      .map((place) => {
        if (place.latitude === null || place.longitude === null) return null;

        const distance = this.calculateDistance(
          latitude,
          longitude,
          place.latitude,
          place.longitude,
        );

        return { place, distance };
      })
      .filter((p) => p !== null && p.distance <= radiusKm)
      .sort((a, b) => a?.distance - b?.distance);

    return placesWithDistance.map((p) => p?.place);
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
  private calculateDistance(
    lat1: number,
    lng1: number,
    lat2: number,
    lng2: number,
  ): number {
    const R = 6371; // Earth radius in km
    const dLat = this.toRad(lat2 - lat1);
    const dLng = this.toRad(lng2 - lng1);

    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(this.toRad(lat1)) *
        Math.cos(this.toRad(lat2)) *
        Math.sin(dLng / 2) *
        Math.sin(dLng / 2);

    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }

  /**
   * Convert degrees to radians
   */
  private toRad(degrees: number): number {
    return degrees * (Math.PI / 180);
  }
}
