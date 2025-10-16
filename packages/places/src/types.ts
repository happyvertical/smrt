/**
 * Type definitions for @have/places package
 */

import type { SmrtObjectOptions } from '@smrt/core';

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
