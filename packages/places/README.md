# @happyvertical/smrt-places

Hierarchical place management with geocoding integration and spatial queries. Supports both real-world locations (with coordinates) and abstract places (virtual worlds, game zones).

## Installation

```bash
pnpm add @happyvertical/smrt-places
```

## Usage

### Lookup or create places with organic database growth

```typescript
import { PlaceCollection, PlaceTypeCollection } from '@happyvertical/smrt-places';

const places = await PlaceCollection.create();
const types = await PlaceTypeCollection.create();

// DB-first lookup, geocodes and creates if not found
const place = await places.lookupOrCreate('1600 Amphitheatre Parkway, Mountain View, CA');

if (place) {
  console.log(`${place.name}: ${place.latitude}, ${place.longitude}`);
  console.log(`Source: ${place.source}`); // 'openstreetmap' or 'google'
}

// Build hierarchy: Country > State > City
const country = await places.create({
  typeId: (await types.getOrCreate('country')).id,
  name: 'United States',
  countryCode: 'US',
});

const city = await places.create({
  typeId: (await types.getOrCreate('city')).id,
  parentId: country.id,
  name: 'San Francisco',
  latitude: 37.7749,
  longitude: -122.4194,
});

// Hierarchy traversal
const hierarchy = await city.getHierarchy();
console.log(hierarchy.ancestors.map(p => p.name)); // ['United States']

// Proximity search (Haversine distance, sorted nearest-first)
const nearby = await places.searchByProximity(37.7749, -122.4194, 10); // 10km radius
```

## API

### Models

| Export | Description |
|--------|------------|
| `Place` | Hierarchical place with optional geo fields, STI enabled |
| `PlaceType` | Slug-based classification (country, city, building, zone, room) |

### Collections

| Export | Description |
|--------|------------|
| `PlaceCollection` | CRUD + `lookupOrCreate()`, `searchByProximity()`, `findByCoordinates()`, `getRootPlaces()`, `getByType()`, `findWithGlobals()` |
| `PlaceTypeCollection` | CRUD + `getOrCreate()` for idempotent type creation |

### Types

| Export | Description |
|--------|------------|
| `GeoData` | Geographic data structure |
| `LookupOrCreateOptions` | Options for `lookupOrCreate()` |
| `PlaceHierarchy` | Hierarchy traversal result |
| `PlaceOptions` | Place creation options |
| `PlaceTypeOptions` | PlaceType creation options |

### Utilities

| Export | Description |
|--------|------------|
| `calculateDistance` | Haversine distance between two coordinates (km) |
| `areCoordinatesNear` | Check if two coordinates are within threshold |
| `validateCoordinates` | Validate lat/lng values |
| `parseCoordinates` | Parse coordinate string to lat/lng |
| `formatCoordinates` | Format lat/lng as string |
| `generateDisplayName` | Build display name from address components |
| `locationToGeoData` | Convert location response to GeoData |
| `mapLocationTypeToPlaceType` | Map geocoder location type to PlaceType slug |
| `normalizeAddressComponents` | Normalize address components from geocoder |

### Instance Methods (Place)

`getParent()`, `getChildren()`, `getAncestors()`, `getDescendants()`, `getHierarchy()` -- hierarchy traversal on any Place instance.

## Dependencies

| Package | Purpose |
|---------|---------|
| `@happyvertical/smrt-core` | SmrtObject/SmrtCollection base classes |
| `@happyvertical/smrt-tenancy` | Optional tenant scoping |
| `@happyvertical/geo` | Geocoding providers (OpenStreetMap, Google Maps) |
| `@happyvertical/sql` | Database operations |
| `@happyvertical/ai` | AI integration |
