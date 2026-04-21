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
   */
  private async ensureFromLocation(
    location: Location,
    typeSlug?: string,
    parentId?: string,
  ): Promise<Place> {
    if (location.id) {
      const existing = await this.findByExternalId(location.id);
      if (existing) return existing;
    }
    return await this.createFromLocation(location, typeSlug, parentId);
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
   * so every returned POI is either reused from the local DB (matched by
   * provider externalId or coordinate proximity) or created as a fresh
   * Place. The cache is effectively automatic because the provider's own
   * place_id becomes the Place row's `externalId`, so calling
   * `discoverNearby` twice for the same area on the same provider is a
   * no-op after the first run.
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

    const places: Place[] = [];
    for (const result of results) {
      const place = await this.ensureFromLocation(result, typeSlug, parentId);
      places.push(place);
    }
    return places;
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

    // Collapse points into buckets keyed by rounded-grid coordinate; use
    // the first point that lands in each bucket as the query center so the
    // radius still covers the points that were collapsed into it.
    const bucketCenters = new Map<string, TrackPoint>();
    for (const point of points) {
      if (!Number.isFinite(point.lat) || !Number.isFinite(point.lng)) continue;
      const key = this.bucketKey(point.lat, point.lng, bucketMeters);
      if (!bucketCenters.has(key)) bucketCenters.set(key, point);
    }

    const result: TrackPlacesResult = {
      places: [],
      requestCount: 0,
      cacheHitCount: 0,
      bucketCount: bucketCenters.size,
    };
    const seen = new Map<string, Place>();

    let lastCallAt = 0;
    for (const center of bucketCenters.values()) {
      const wait = lastCallAt + throttleMs - Date.now();
      if (wait > 0) {
        await new Promise((resolve) => setTimeout(resolve, wait));
      }

      const before = await this.countExistingNearby(
        center.lat,
        center.lng,
        radiusMeters,
      );
      const places = await this.discoverNearby(
        center.lat,
        center.lng,
        radiusMeters,
        options,
      );
      lastCallAt = Date.now();
      result.requestCount += 1;

      // If no new Places were created (all matched existing externalIds or
      // coordinates), count this bucket as a cache hit. This is a
      // best-effort signal for observability, not a correctness guarantee.
      const createdAny = places.some(
        (place) =>
          !place.createdAt ||
          Date.now() - new Date(place.createdAt).getTime() < throttleMs * 2,
      );
      if (!createdAny && before > 0 && places.length > 0) {
        result.cacheHitCount += 1;
      }

      for (const place of places) {
        if (place.id && !seen.has(place.id)) seen.set(place.id, place);
      }
    }

    result.places = [...seen.values()];
    return result;
  }

  /**
   * Count existing Places within `radiusMeters` of a point. Used by
   * `resolveTrackPlaces` to classify buckets as cache hits vs fresh
   * provider work.
   *
   * Uses an in-memory scan rather than `searchByProximity`, which relies
   * on `where: { latitude: { $ne: null } }`. The `$ne: null` operator
   * doesn't round-trip cleanly through every SQL adapter's parameter
   * binding (SQL wants `IS NOT NULL`, not `!= NULL`). The scan is
   * inexpensive at realistic Place-table sizes and `resolveTrackPlaces`
   * only calls this once per unique bucket.
   */
  private async countExistingNearby(
    latitude: number,
    longitude: number,
    radiusMeters: number,
  ): Promise<number> {
    const all = await this.list({});
    const radiusKm = radiusMeters / 1000;
    let count = 0;
    for (const place of all) {
      if (place.latitude == null || place.longitude == null) continue;
      const distance = this.calculateDistance(
        latitude,
        longitude,
        place.latitude,
        place.longitude,
      );
      if (distance <= radiusKm) count += 1;
    }
    return count;
  }

  /**
   * Rounded-grid bucket key. Two points within `bucketMeters` of each
   * other map to the same key; longitude shrinks by cos(lat) at high
   * latitudes to keep bucket cells roughly square on the ground.
   */
  private bucketKey(
    latitude: number,
    longitude: number,
    bucketMeters: number,
  ): string {
    const latStep = bucketMeters / 111_000;
    const cosLat = Math.cos((latitude * Math.PI) / 180);
    const lngStep = bucketMeters / (111_000 * Math.max(cosLat, 0.01));
    const latCell = Math.round(latitude / latStep);
    const lngCell = Math.round(longitude / lngStep);
    return `${latCell}:${lngCell}`;
  }

  /**
   * Build a geo adapter configured for this call. Factored out of
   * `geocode` so `discoverNearby` can reuse the same env + key wiring
   * without having to pipe options through the lookupOrCreate path.
   */
  private async getGeoAdapter(
    provider: 'google' | 'openstreetmap',
  ): Promise<GeoAdapter> {
    if (provider === 'google') {
      return getGeoAdapter({
        provider: 'google',
        apiKey: process.env.GOOGLE_MAPS_API_KEY || '',
      });
    }
    return getGeoAdapter({
      provider: 'openstreetmap',
      userAgent: '@have/places',
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
