/**
 * Type definitions for @have/places package
 */

import type { SmrtObjectOptions } from '@happyvertical/smrt-core';

/**
 * Geographic data structure
 * All fields optional to support both real-world and abstract places
 */
export interface GeoData {
  latitude: number | null;
  longitude: number | null;
  streetNumber?: string;
  streetName?: string;
  city?: string;
  region?: string;
  country?: string;
  postalCode?: string;
  countryCode?: string;
  timezone?: string;
}

/**
 * Options for creating/updating a Place
 */
export interface PlaceOptions extends SmrtObjectOptions {
  id?: string;
  tenantId?: string | null;
  typeId?: string;
  parentId?: string;
  name?: string;
  description?: string;

  // Optional geo fields (all nullable for abstract places)
  latitude?: number | null;
  longitude?: number | null;
  streetNumber?: string;
  streetName?: string;
  city?: string;
  region?: string;
  country?: string;
  postalCode?: string;
  countryCode?: string;
  timezone?: string;

  // Metadata
  externalId?: string;
  source?: string;
  metadata?: Record<string, any> | string;

  // Timestamps
  createdAt?: Date;
  updatedAt?: Date;
}

/**
 * Options for creating/updating a PlaceType
 */
export interface PlaceTypeOptions extends SmrtObjectOptions {
  id?: string;
  slug?: string;
  name?: string;
  description?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

/**
 * Options for lookupOrCreate method
 */
export interface LookupOrCreateOptions {
  /**
   * Which geo provider to use for lookups
   */
  geoProvider?: 'google' | 'openstreetmap';

  /**
   * Force a specific place type
   */
  typeSlug?: string;

  /**
   * Set parent place if known
   */
  parentId?: string;

  /**
   * Whether to create if not found (default: true)
   */
  createIfNotFound?: boolean;

  /**
   * Coordinates for reverse geocoding
   */
  coords?: {
    lat: number;
    lng: number;
  };
}

/**
 * Place hierarchy structure
 */
export interface PlaceHierarchy {
  ancestors: any[]; // Place[] - avoiding circular ref
  current: any; // Place
  descendants: any[]; // Place[]
}

/**
 * Options for `PlaceCollection.discoverNearby`. Mirrors the inputs to
 * `@happyvertical/geo`'s `findPoisNear` plus a couple of persistence knobs
 * (PlaceType override, parent linkage) to match `lookupOrCreate`'s shape.
 */
export interface DiscoverNearbyOptions {
  /** Which geo provider to use. Defaults to openstreetmap. */
  geoProvider?: 'google' | 'openstreetmap';
  /**
   * POI category filter, forwarded to the provider. See
   * `@happyvertical/geo`'s `PoiSearchOptions.types` for provider-specific
   * interpretation.
   */
  types?: string[];
  /** Free-text keyword filter (provider-dependent; Google only). */
  keyword?: string;
  /** Max results per provider call. Default 20. */
  limit?: number;
  /** Preferred language for place names (Google only). */
  language?: string;
  /** Override the PlaceType slug assigned to created rows. */
  typeSlug?: string;
  /** Set parent place on created rows. */
  parentId?: string;
}

/**
 * A single point along a track. Matches the `{ lat, lng }` convention used
 * by `LookupOrCreateOptions.coords` so callers don't have to shuffle shapes.
 */
export interface TrackPoint {
  lat: number;
  lng: number;
}

/**
 * Options for `PlaceCollection.resolveTrackPlaces`. Extends
 * `DiscoverNearbyOptions` with per-track knobs that control how the track
 * is bucketed + throttled before hitting the geo provider.
 */
export interface ResolveTrackPlacesOptions extends DiscoverNearbyOptions {
  /**
   * Per-point POI search radius in meters. Default 50.
   */
  radiusMeters?: number;
  /**
   * Collapse points within this distance (m) into a single bucket so we
   * don't re-query the same ~50m area dozens of times for a slow drive-by.
   * Default 50.
   */
  bucketMeters?: number;
  /**
   * Minimum delay between provider requests. Default 1100ms — safely above
   * OSM's 1 req/sec community limit. Google can usually handle faster; set
   * to 100ms or less for paid tiers.
   */
  throttleMs?: number;
}

/**
 * Result of `PlaceCollection.resolveTrackPlaces`. Tracks are typically
 * long-running operations so the return payload includes counters that let
 * callers surface progress or estimate cost without re-walking.
 */
export interface TrackPlacesResult {
  /** De-duplicated Place rows touched during resolution. */
  places: any[]; // Place[] - avoiding circular ref
  /** Number of provider requests issued. */
  requestCount: number;
  /** Number of bucketed points that reused existing Place rows. */
  cacheHitCount: number;
  /** Number of distinct geographic buckets walked. */
  bucketCount: number;
}
