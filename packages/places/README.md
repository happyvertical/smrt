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

### Discover POIs around a coordinate

`discoverNearby` composes `@happyvertical/geo`'s `findPoisNear` with the
collection's idempotent-persist logic. Each POI returned by the provider is
either reused from the local DB (matched by provider `externalId`) or
created as a fresh Place row. Repeat calls for the same area are effectively
free — the provider's own id becomes `Place.externalId`, so a second scan
doesn't duplicate anything.

```typescript
const pois = await places.discoverNearby(53.5461, -113.4938, 250, {
  geoProvider: 'openstreetmap', // default
  types: ['cafe'], // optional filter — passed through to the provider
  limit: 10,
});

for (const poi of pois) {
  console.log(poi.name, poi.externalId);
}
```

Requires a geo provider that implements `findPoisNear`. Throws a clear error
otherwise so callers can fall back to `lookupOrCreate` (address-level) or
switch providers.

### Resolve POIs along a GPS track

For workflows like "what places does this drive/hike pass through?",
`resolveTrackPlaces` walks an ordered array of points, collapses close
samples into grid cells, throttles the provider between requests, and
returns the deduplicated Place rows.

```typescript
const track = [
  { lat: 53.5461, lng: -113.4938 },
  { lat: 53.5465, lng: -113.4942 },
  { lat: 53.5470, lng: -113.4950 },
  // ...hundreds more along a route
];

const result = await places.resolveTrackPlaces(track, {
  radiusMeters: 50,       // per-point POI search radius
  bucketMeters: 50,       // collapse points within this distance into one request
  throttleMs: 1100,       // ≥1s is safe for public Overpass/Nominatim
  types: ['cafe', 'restaurant'],
});

console.log(`Hit ${result.requestCount} buckets, ${result.cacheHitCount} cached, ${result.places.length} distinct places`);
```

Bucketing is the main cost-saver: a 20-minute drive at 1 Hz GPS produces
1200 raw samples but often only 100–200 distinct 50 m cells, so the
provider only gets called 100–200 times. `throttleMs` keeps you within
Overpass/Nominatim's 1 req/sec community limit out of the box; drop it to
100 ms or so on paid tiers.

### Owned assets

```typescript
import { AssetCollection } from '@happyvertical/smrt-assets';

const assets = await AssetCollection.create();
const floorplan = await assets.create({
  name: 'main-hall-floorplan.png',
  sourceUri: 'file:///tmp/main-hall-floorplan.png',
  mimeType: 'image/png',
});

await place.addAsset(floorplan, 'floorplan');
await places.addAsset(place.id!, floorplan, 'gallery', 1);

const floorplans = await place.getAssets('floorplan');
const galleryAssets = await places.getAssets(place.id!, 'gallery');
```

## API

### Models

| Export | Description |
|--------|------------|
| `Place` | Hierarchical place with optional geo fields, STI enabled |
| `PlaceType` | Slug-based classification (country, city, building, zone, room) |
| `PlaceAsset` | Dedicated owned-asset join stored in `place_assets` with `relationship` and `sortOrder` |

### Collections

| Export | Description |
|--------|------------|
| `PlaceCollection` | CRUD + `lookupOrCreate()`, `searchByProximity()`, `findByCoordinates()`, `getRootPlaces()`, `getByType()`, `findWithGlobals()` |
| `PlaceAssetCollection` | Direct access to `place_assets` rows plus asset helper wrappers |
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

Owned asset helpers are available on both `Place` and `PlaceCollection` via
`getAssets()`, `addAsset()`, and `removeAsset()`. Common relationships include
`hero`, `floorplan`, `gallery`, and `attachment`.

## Dependencies

| Package | Purpose |
|---------|---------|
| `@happyvertical/smrt-core` | SmrtObject/SmrtCollection base classes |
| `@happyvertical/smrt-tenancy` | Optional tenant scoping |
| `@happyvertical/geo` | Geocoding providers (OpenStreetMap, Google Maps) |
| `@happyvertical/sql` | Database operations |
| `@happyvertical/ai` | AI integration |
