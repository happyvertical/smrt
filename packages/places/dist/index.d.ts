/**
 * @have/places
 *
 * Hierarchical place management with geo integration and SMRT framework support
 *
 * @packageDocumentation
 */
export { PlaceCollection } from './collections/PlaceCollection';
export { PlaceTypeCollection } from './collections/PlaceTypeCollection';
export { Place } from './models/Place';
export { PlaceType } from './models/PlaceType';
export type { GeoData, LookupOrCreateOptions, PlaceHierarchy, PlaceOptions, PlaceTypeOptions, } from './types';
export { areCoordinatesNear, calculateDistance, formatCoordinates, generateDisplayName, locationToGeoData, mapLocationTypeToPlaceType, normalizeAddressComponents, parseCoordinates, validateCoordinates, } from './utils';
//# sourceMappingURL=index.d.ts.map