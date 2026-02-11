# @happyvertical/smrt-places

Hierarchical place management with geocoding integration, spatial queries, and support for both real-world and abstract locations.

## Architecture

```
src/
  index.ts                      # Export barrel
  types.ts                      # PlaceOptions, GeoData, LookupOrCreateOptions
  utils.ts                      # Geocoding, coordinate utilities
  models/
    Place.ts                    # Core place entity with hierarchy and geo fields
    PlaceType.ts                # Place type lookup (country, city, building, etc.)
  collections/
    PlaceCollection.ts          # CRUD + hierarchy traversal + lookupOrCreate()
    PlaceTypeCollection.ts      # Type management
```

## Models

### Place

Tenancy-optional model with parent-child hierarchy and optional geo fields.

**Properties**: `name`, `description`, `placeType`, `parentId`, `latitude`, `longitude`, `address`, `metadata`

**Methods**:
- Hierarchy: `getParent()`, `getChildren()`, `getAncestors()`, `getDescendants()`, `getHierarchy()`
- Geo: `getGeoData()`, `hasCoordinates()`
- Metadata: `getMetadata()`, `setMetadata()`, `updateMetadata()`

### PlaceType

Simple lookup with `name` and `description`.

## Collections

### PlaceCollection

- `lookupOrCreate(address)` — Checks local DB first, then geocodes if not found (organic growth pattern)
- Proximity search, hierarchy traversal, type filtering

## Utilities

- `areCoordinatesNear(lat1, lon1, lat2, lon2, threshold)` — Distance check
- `generateDisplayName(place)` — Human-readable name
- Coordinate validation, formatting, parsing

## Key Patterns

- **Organic growth**: `lookupOrCreate()` grows the database organically via geocoding
- **Abstract places**: Latitude/longitude are optional — supports locations without coordinates
- **Hierarchy**: Country > Region > City > Building > Room

## Dependencies

- `@happyvertical/smrt-core`, `@happyvertical/smrt-tenancy`
- `@happyvertical/geo`, `@happyvertical/cache`
- `@happyvertical/ai`, `@happyvertical/sql`, `@happyvertical/files`, `@happyvertical/utils`, `@happyvertical/logger`
