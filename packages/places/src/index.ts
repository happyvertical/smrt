/**
 * @have/places
 *
 * Hierarchical place management with geo integration and SMRT framework support
 *
 * @packageDocumentation
 */

// Self-register this package's manifest before any @smrt() decorator fires
// downstream. Must come first so the side effect runs ahead of the class
// module loads below. See __smrt-register__.ts for issue #1132 context.
import './__smrt-register__';

// Export collections
export { PlaceAssetCollection } from './collections/PlaceAssetCollection';
export { PlaceCollection } from './collections/PlaceCollection';
export { PlaceTypeCollection } from './collections/PlaceTypeCollection';
export { Place } from './models/Place';
// Export models
export type { PlaceAssetOptions } from './models/PlaceAsset';
export { PlaceAsset } from './models/PlaceAsset';
export { PlaceType } from './models/PlaceType';

// Export types
export type {
  GeoData,
  LookupOrCreateOptions,
  PlaceHierarchy,
  PlaceOptions,
  PlaceTypeOptions,
} from './types';

// Export utilities
export {
  areCoordinatesNear,
  calculateDistance,
  formatCoordinates,
  generateDisplayName,
  locationToGeoData,
  mapLocationTypeToPlaceType,
  normalizeAddressComponents,
  parseCoordinates,
  validateCoordinates,
} from './utils';
