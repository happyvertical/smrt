/**
 * @have/places
 *
 * Hierarchical place management with geo integration and SMRT framework support
 *
 * @packageDocumentation
 */

// Export models
export { Place } from './models/Place';
export { PlaceType } from './models/PlaceType';

// Export collections
export { PlaceCollection } from './collections/PlaceCollection';
export { PlaceTypeCollection } from './collections/PlaceTypeCollection';

// Export types
export type {
  PlaceOptions,
  PlaceTypeOptions,
  GeoData,
  LookupOrCreateOptions,
  PlaceHierarchy,
} from './types';

// Export utilities
export {
  mapLocationTypeToPlaceType,
  locationToGeoData,
  validateCoordinates,
  calculateDistance,
  formatCoordinates,
  parseCoordinates,
  normalizeAddressComponents,
  generateDisplayName,
  areCoordinatesNear,
} from './utils';
