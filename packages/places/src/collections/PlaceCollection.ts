/**
 * PlaceCollection - Collection manager for Place objects
 *
 * Provides hierarchy traversal and organic place database growth via
 * lookupOrCreate method that integrates with @happyvertical/geo.
 */

import type { GeoAdapter, Location } from '@happyvertical/geo';
import { getGeoAdapter } from '@happyvertical/geo';
import type { Asset } from '@happyvertical/smrt-assets';
import {
  addOwnedAssetFromCollection,
  getOwnedAssetsFromCollection,
  removeOwnedAssetFromCollection,
} from '@happyvertical/smrt-assets';
import { SmrtCollection } from '@happyvertical/smrt-core';
import { Place } from '../models/Place';
import type {
  DiscoverNearbyOptions,
  LookupOrCreateOptions,
  ResolveTrackPlacesOptions,
  TrackPlacesResult,
  TrackPoint,
} from '../types';
import { PlaceTypeCollection } from './PlaceTypeCollection';

export class PlaceCollection extends SmrtCollection<Place> {
  static readonly _itemClass = Place;

  /**
   * Look up a place by query or coordinates, creating it if not found
   *
   * This is the key method for organic database growth:
   * 1. Search local database first
   * 2. If not found, query @happyvertical/geo
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

    // Step 3: Query @happyvertical/geo for location data
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
      // Cast to access Place-specific properties
      const placeObj = place as Place;
      if (placeObj.latitude === null || placeObj.longitude === null) continue;

      const latDiff = Math.abs(placeObj.latitude - latitude);
      const lngDiff = Math.abs(placeObj.longitude - longitude);

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
   * Geocode query or coordinates using @happyvertical/geo
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
    const geo = await this.getGeoAdapter(provider);

    // Use reverse geocode if coords provided, otherwise forward geocode
    if (coords) {
      return await geo.reverseGeocode(coords.lat, coords.lng);
    }

    return await geo.lookup(query);
  }

  /**
   * Find a place by the provider's native id (Google place_id, OSM
   * osm-node-N, etc.). Used as the primary idempotency key by
   * `discoverNearby` so repeat POI searches don't create duplicate rows.
   */
  private async findByExternalId(externalId: string): Promise<Place | null> {
    if (!externalId) return null;
    const matches = await this.list({
      where: { externalId },
      limit: 1,
    });
    return matches[0] ?? null;
  }

  /**
   * Idempotent "find or create" for a geo Location. Keyed purely on the
   * provider's externalId (Google place_id, osm-node-*, etc.), which is
   * stable per POI across repeat searches. The older `lookupOrCreate`
   * keeps its own fallback chain (name/address/coordinate matching) for
   * address-style workflows where externalId isn't reliable.
   *
   * Returns `{ place, created }` so callers can distinguish fresh rows
   * from reused ones without re-querying the table — this is how
   * `resolveTrackPlaces` derives its `cacheHitCount` without a full
   * scan per bucket.
   */
  private async ensureFromLocation(
    location: Location,
    typeSlug?: string,
    parentId?: string,
  ): Promise<{ place: Place; created: boolean }> {
    if (location.id) {
      const existing = await this.findByExternalId(location.id);
      if (existing) return { place: existing, created: false };
    }
    const place = await this.createFromLocation(location, typeSlug, parentId);
    return { place, created: true };
  }

  /**
   * Create place from @happyvertical/geo Location data
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
      metadata: JSON.stringify({ raw: location.raw ?? null }),
    });
  }

  /**
   * Discover POIs near a coordinate and persist them as Place rows.
   *
   * Composes `@happyvertical/geo`'s `findPoisNear` with `ensureFromLocation`
   * so every returned POI is either reused from the local DB (when the
   * provider returns an id matching an existing Place `externalId`) or
   * created fresh otherwise. The cache is effectively automatic because
   * the provider's own place_id becomes the Place row's `externalId`, so
   * calling `discoverNearby` twice for the same area on the same provider
   * is a no-op after the first run when the provider returns stable ids.
   *
   * Requires a geo provider that implements `findPoisNear`. Throws a clear
   * error otherwise so consumers can fall back to `lookupOrCreate` or
   * switch providers.
   */
  async discoverNearby(
    latitude: number,
    longitude: number,
    radiusMeters: number,
    options: DiscoverNearbyOptions = {},
  ): Promise<Place[]> {
    if (!(radiusMeters > 0)) {
      throw new Error(
        `discoverNearby: radiusMeters must be > 0 (got ${radiusMeters})`,
      );
    }
    const detailed = await this.discoverNearbyDetailed(
      latitude,
      longitude,
      radiusMeters,
      options,
    );
    return detailed.map((d) => d.place);
  }

  /**
   * Internal variant of `discoverNearby` that exposes whether each
   * returned Place was created during this call (`true`) or reused from
   * an earlier call (`false`). Used by `resolveTrackPlaces` to classify
   * buckets as cache hits without having to re-scan the Place table.
   */
  private async discoverNearbyDetailed(
    latitude: number,
    longitude: number,
    radiusMeters: number,
    options: DiscoverNearbyOptions = {},
  ): Promise<Array<{ place: Place; created: boolean }>> {
    const {
      geoProvider = 'openstreetmap',
      types,
      keyword,
      limit,
      language,
      typeSlug,
      parentId,
    } = options;

    const geo = await this.getGeoAdapter(geoProvider);
    if (typeof geo.findPoisNear !== 'function') {
      throw new Error(
        `Geo provider '${geoProvider}' does not implement findPoisNear`,
      );
    }

    const results = await geo.findPoisNear(latitude, longitude, radiusMeters, {
      types,
      keyword,
      limit,
      language,
    });

    const detailed: Array<{ place: Place; created: boolean }> = [];
    for (const result of results) {
      detailed.push(await this.ensureFromLocation(result, typeSlug, parentId));
    }
    return detailed;
  }

  /**
   * Resolve POIs along a GPS track (e.g. a video's per-frame path).
   *
   * Naively walking every point would hammer the provider with redundant
   * requests — consecutive samples are usually within a few meters. This
   * method buckets points into a `bucketMeters`-wide grid, calls
   * `discoverNearby` once per distinct bucket, and throttles requests per
   * `throttleMs` so free tiers (Overpass, Nominatim) stay inside their
   * community rate limits without the caller having to manage a queue.
   *
   * The returned `places` are deduped across buckets by Place id, so a
   * POI that falls within several overlapping search radii appears once.
   */
  async resolveTrackPlaces(
    points: ReadonlyArray<TrackPoint>,
    options: ResolveTrackPlacesOptions = {},
  ): Promise<TrackPlacesResult> {
    const radiusMeters = options.radiusMeters ?? 50;
    const bucketMeters = options.bucketMeters ?? 50;
    const throttleMs = options.throttleMs ?? 1100;

    if (!(radiusMeters > 0)) {
      throw new Error(
        `resolveTrackPlaces: radiusMeters must be > 0 (got ${radiusMeters})`,
      );
    }
    if (!(bucketMeters > 0)) {
      // Grid/greedy bucketing both divide by bucketMeters; a non-positive
      // value would either NaN the math or produce "everything in one
      // bucket", neither of which the caller likely meant.
      throw new Error(
        `resolveTrackPlaces: bucketMeters must be > 0 (got ${bucketMeters})`,
      );
    }
    if (throttleMs < 0 || !Number.isFinite(throttleMs)) {
      throw new Error(
        `resolveTrackPlaces: throttleMs must be a finite non-negative number (got ${throttleMs})`,
      );
    }

    // Greedy proximity-based bucketing: each new point joins the nearest
    // existing bucket within `bucketMeters` (Haversine), otherwise seeds a
    // new bucket with itself as the center. This matches the documented
    // semantic ("points within bucketMeters of each other collapse into
    // one request") more faithfully than a `Math.round`-on-grid scheme,
    // which can split two points ~0.2m apart if they straddle a cell
    // boundary and inflate requestCount exactly when the user was trying
    // to rate-limit.
    const bucketMetersKm = bucketMeters / 1000;
    const bucketCenters: TrackPoint[] = [];
    for (const point of points) {
      if (!Number.isFinite(point.lat) || !Number.isFinite(point.lng)) continue;
      let bestIdx = -1;
      let bestKm = Number.POSITIVE_INFINITY;
      for (let i = 0; i < bucketCenters.length; i += 1) {
        const c = bucketCenters[i];
        const km = this.calculateDistance(c.lat, c.lng, point.lat, point.lng);
        if (km <= bucketMetersKm && km < bestKm) {
          bestKm = km;
          bestIdx = i;
        }
      }
      if (bestIdx < 0) bucketCenters.push(point);
    }

    const result: TrackPlacesResult = {
      places: [],
      requestCount: 0,
      cacheHitCount: 0,
      bucketCount: bucketCenters.length,
    };
    const seen = new Map<string, Place>();

    let lastCallAt = 0;
    for (const center of bucketCenters) {
      const wait = lastCallAt + throttleMs - Date.now();
      if (wait > 0) {
        await new Promise((resolve) => setTimeout(resolve, wait));
      }

      const detailed = await this.discoverNearbyDetailed(
        center.lat,
        center.lng,
        radiusMeters,
        options,
      );
      lastCallAt = Date.now();
      result.requestCount += 1;

      // Cache hit = the provider returned results and every one of them
      // matched a Place that already existed (explicit `created === false`
      // from ensureFromLocation). No timestamp heuristics, no re-scan.
      if (detailed.length > 0 && detailed.every((d) => !d.created)) {
        result.cacheHitCount += 1;
      }

      for (const { place } of detailed) {
        if (place.id && !seen.has(place.id)) seen.set(place.id, place);
      }
    }

    result.places = [...seen.values()];
    return result;
  }

  /**
   * Provider wiring (env keys, user-agent string, etc.) that `geocode`
   * and `discoverNearby` share so the two code paths can't drift. Kept
   * separate from the adapter call itself so tests and future providers
   * can inspect or override the options before construction.
   */
  private getGeoAdapterOptions(
    provider: 'google' | 'openstreetmap',
  ):
    | { provider: 'google'; apiKey: string }
    | { provider: 'openstreetmap'; userAgent: string } {
    if (provider === 'google') {
      return {
        provider: 'google',
        apiKey: process.env.GOOGLE_MAPS_API_KEY || '',
      };
    }
    return { provider: 'openstreetmap', userAgent: '@have/places' };
  }

  /**
   * Build a geo adapter configured for this call. Single source of truth
   * for provider wiring — `geocode` and `discoverNearby` both come through
   * here.
   */
  private async getGeoAdapter(
    provider: 'google' | 'openstreetmap',
  ): Promise<GeoAdapter> {
    return getGeoAdapter(this.getGeoAdapterOptions(provider));
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

  async getAssets(placeId: string, relationship?: string): Promise<Asset[]> {
    return getOwnedAssetsFromCollection(this, placeId, relationship);
  }

  async addAsset(
    placeId: string,
    asset: Asset,
    relationship = 'attachment',
    sortOrder = 0,
  ): Promise<void> {
    await addOwnedAssetFromCollection(
      this,
      'Place',
      placeId,
      asset,
      relationship,
      sortOrder,
    );
  }

  async removeAsset(
    placeId: string,
    assetId: string,
    relationship?: string,
  ): Promise<void> {
    await removeOwnedAssetFromCollection(
      this,
      'Place',
      placeId,
      assetId,
      relationship,
    );
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
      .filter(
        (p): p is { place: Place; distance: number } =>
          p !== null && p.distance <= radiusKm,
      )
      .sort((a, b) => a.distance - b.distance);

    return placesWithDistance.map((p) => p.place);
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

  // ─────────────────────────────────────────────────────────────────────────────
  // Tenant Helper Methods
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Find all places belonging to a specific tenant
   *
   * @param tenantId - The tenant ID to filter by
   * @returns Array of places for the tenant
   */
  async findByTenant(tenantId: string): Promise<Place[]> {
    return this.list({ where: { tenantId } });
  }

  /**
   * Find all global places (not associated with any tenant)
   *
   * @returns Array of global places
   */
  async findGlobal(): Promise<Place[]> {
    return this.list({ where: { tenantId: null } });
  }

  /**
   * Find places for a tenant including global places
   *
   * @param tenantId - The tenant ID to include
   * @returns Array of tenant-specific and global places
   */
  async findWithGlobals(tenantId: string): Promise<Place[]> {
    return this.query(
      `SELECT * FROM ${this.tableName} WHERE tenant_id = ? OR tenant_id IS NULL`,
      [tenantId],
    );
  }
}
