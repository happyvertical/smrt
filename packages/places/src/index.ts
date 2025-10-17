/**
 * @have/places
 *
 * Hierarchical place management with geo integration and SMRT framework support
 *
 * @packageDocumentation
 */

// Export collections
export { PlaceCollection } from './collections/PlaceCollection';
export { PlaceTypeCollection } from './collections/PlaceTypeCollection';
// Export models
export { Place } from './models/Place';
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
