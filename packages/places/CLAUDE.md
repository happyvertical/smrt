# @happyvertical/smrt-places

Hierarchical geographic database with organic growth via geocoding integration.

## Models

- **Place** (STI): hierarchical via `parentId`. Optional geo fields (all nullable — supports abstract places like game zones). `externalId`/`source` from geocoder. Metadata JSON.
- **PlaceType**: slug-based classification (country, city, building, zone, room, region).

## Key Collection Methods

| Method | Purpose |
|--------|---------|
| `lookupOrCreate(query)` | DB first → geocode if not found → create. Organic growth pattern. |
| `findByCoordinates(lat, lng, threshold)` | Default 0.0001° ≈ 11m tolerance at equator |
| `searchByProximity(lat, lng, radiusKm)` | Haversine distance, sorted by proximity |
| `findWithGlobals(tenantId)` | Tenant + global (tenantId=null) places |
| `getRootPlaces()`, `getByType(slug)` | Hierarchy + type queries |

Hierarchy traversal: `getParent()`, `getChildren()`, `getAncestors()`, `getDescendants()`, `getHierarchy()`.

## Gotchas

- **Geo providers**: Google Maps needs `GOOGLE_MAPS_API_KEY`; OpenStreetMap is default
- **Abstract places allowed**: lat/lng nullable — supports non-geographic locations
- **Coordinate tolerance varies by latitude**: 0.0001° ≈ 11m at equator, less at poles
- **Optional tenancy** with nullable tenantId
