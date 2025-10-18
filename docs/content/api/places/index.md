# @smrt/places

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)

Hierarchical place management with geo integration and SMRT framework support.

## Overview

The `@smrt/places` package provides a comprehensive place management system with support for hierarchical relationships, geographic data integration, and automatic database growth through geocoding. It seamlessly integrates with `@have/geo` for location lookups and supports both real-world places (with coordinates) and abstract places (virtual worlds, game zones).

Key capabilities:

- **Hierarchical Organization**: Model places as trees with parent-child relationships (Country → Region → City → Building → Room)
- **Geocoding Integration**: Automatic place creation from addresses or coordinates using OpenStreetMap or Google Maps
- **Organic Growth**: `lookupOrCreate()` method checks local database first, then geocodes and creates if needed
- **Flexible Structure**: Optional geo fields support both real-world and abstract places
- **Spatial Queries**: Search by proximity, calculate distances, find nearby places
- **SMRT Framework**: Auto-generated REST APIs, CLI commands, and MCP tools

## Features

- **Place Hierarchy Management**: Parent-child relationships with recursive ancestor/descendant traversal
- **Place Types**: Categorize places (country, city, building, zone, room, etc.) with slug-based lookup
- **Geo Integration**: Seamless integration with `@have/geo` for geocoding and reverse geocoding
- **Coordinate Validation**: Validate and normalize geographic coordinates
- **Distance Calculations**: Haversine formula for accurate distance calculations
- **Proximity Search**: Find places within a radius of given coordinates
- **Metadata Storage**: JSON metadata support for additional place information
- **Auto-Generated APIs**: REST endpoints, CLI commands, and MCP tools via `@smrt()` decorator
- **Type Safety**: Full TypeScript support with comprehensive type definitions

## Installation

```bash
# Install with pnpm (recommended for monorepo)
pnpm add @smrt/places

# Or with npm
npm install @smrt/places

# Or with yarn
yarn add @smrt/places

# Or with bun
bun add @smrt/places
```

## Quick Start

### Basic Place Creation

```typescript
import { PlaceCollection, PlaceTypeCollection } from '@smrt/places';

// Create place type
const typeCollection = await PlaceTypeCollection.create();
const cityType = await typeCollection.create({
  name: 'City',
  slug: 'city',
  description: 'A city or town'
});

// Create place
const placeCollection = await PlaceCollection.create();
const sanFrancisco = await placeCollection.create({
  typeId: cityType.id,
  name: 'San Francisco',
  latitude: 37.7749,
  longitude: -122.4194,
  city: 'San Francisco',
  region: 'California',
  country: 'United States',
  countryCode: 'US',
  timezone: 'America/Los_Angeles'
});

console.log(`Created place: ${sanFrancisco.name}`);
console.log(`Coordinates: ${sanFrancisco.latitude}, ${sanFrancisco.longitude}`);
```

### Hierarchical Places

```typescript
// Create hierarchy: Country → State → City
const country = await placeCollection.create({
  typeId: (await typeCollection.getOrCreate('country')).id,
  name: 'United States',
  countryCode: 'US'
});

const state = await placeCollection.create({
  typeId: (await typeCollection.getOrCreate('region')).id,
  parentId: country.id,
  name: 'California',
  region: 'California'
});

const city = await placeCollection.create({
  typeId: (await typeCollection.getOrCreate('city')).id,
  parentId: state.id,
  name: 'San Francisco',
  city: 'San Francisco'
});

// Get hierarchy
const hierarchy = await city.getHierarchy();
console.log('Ancestors:', hierarchy.ancestors.map(p => p.name)); // ['United States', 'California']
console.log('Current:', hierarchy.current.name); // 'San Francisco'
```

### Organic Database Growth with lookupOrCreate

```typescript
// Lookup or create place from address
const place = await placeCollection.lookupOrCreate('1600 Amphitheatre Parkway, Mountain View, CA');

if (place) {
  console.log(`Place: ${place.name}`);
  console.log(`Coordinates: ${place.latitude}, ${place.longitude}`);
  console.log(`Source: ${place.source}`); // 'openstreetmap' or 'google'
}

// Lookup with coordinates (reverse geocoding)
const placeFromCoords = await placeCollection.lookupOrCreate('Current Location', {
  coords: { lat: 37.7749, lng: -122.4194 },
  geoProvider: 'google'
});

// Lookup without creating
const existing = await placeCollection.lookupOrCreate('Some Address', {
  createIfNotFound: false
});

if (!existing) {
  console.log('Place not found and not created');
}
```

### Proximity Search

```typescript
// Find places within 10km of coordinates
const nearbyPlaces = await placeCollection.searchByProximity(
  37.7749, // latitude
  -122.4194, // longitude
  10 // radius in km
);

console.log(`Found ${nearbyPlaces.length} places within 10km`);

for (const place of nearbyPlaces) {
  console.log(`- ${place.name}`);
}
```

### Working with Place Metadata

```typescript
// Create place with metadata
const museum = await placeCollection.create({
  typeId: (await typeCollection.getOrCreate('point_of_interest')).id,
  name: 'Museum of Modern Art',
  latitude: 40.7614,
  longitude: -73.9776,
  metadata: {
    hours: '10:00-17:30',
    admission: 25,
    website: 'https://www.moma.org'
  }
});

// Get metadata
const metadata = museum.getMetadata();
console.log(`Admission: $${metadata.admission}`);

// Update metadata
museum.updateMetadata({ admission: 30 });
await museum.save();
```

### Using Utilities

```typescript
import {
  calculateDistance,
  validateCoordinates,
  formatCoordinates,
  parseCoordinates,
  areCoordinatesNear,
  generateDisplayName
} from '@smrt/places';

// Validate coordinates
const validation = validateCoordinates(37.7749, -122.4194);
if (validation.valid) {
  console.log('Valid coordinates');
} else {
  console.log(`Invalid: ${validation.error}`);
}

// Calculate distance
const distance = calculateDistance(
  37.7749, -122.4194, // San Francisco
  34.0522, -118.2437  // Los Angeles
);
console.log(`Distance: ${distance.toFixed(2)} km`);

// Format coordinates
const formatted = formatCoordinates(37.7749, -122.4194);
console.log(formatted); // "37.774900, -122.419400"

// Parse coordinate string
const coords = parseCoordinates('37.7749, -122.4194');
if (coords) {
  console.log(`Lat: ${coords.lat}, Lng: ${coords.lng}`);
}

// Check if coordinates are near each other
const near = areCoordinatesNear(
  37.7749, -122.4194,
  37.7750, -122.4195,
  0.1 // threshold in km
);
console.log(near ? 'Coordinates are nearby' : 'Coordinates are far apart');

// Generate display name from address components
const displayName = generateDisplayName({
  streetNumber: '1600',
  streetName: 'Amphitheatre Parkway',
  city: 'Mountain View',
  region: 'CA',
  country: 'United States'
});
console.log(displayName); // "1600 Amphitheatre Parkway, Mountain View, CA, United States"
```

## Advanced Usage

### Traversing Place Hierarchies

```typescript
// Get all ancestors (bottom-up)
const ancestors = await place.getAncestors();
console.log('Hierarchy path:', ancestors.map(p => p.name).join(' → '));

// Get immediate children
const children = await place.getChildren();
console.log(`${place.name} has ${children.length} children`);

// Get all descendants (recursive)
const descendants = await place.getDescendants();
console.log(`Total descendants: ${descendants.length}`);

// Get parent
const parent = await place.getParent();
if (parent) {
  console.log(`Parent: ${parent.name}`);
}
```

### Working with Place Types

```typescript
const typeCollection = await PlaceTypeCollection.create();

// Create custom place types
const buildingType = await typeCollection.create({
  name: 'Building',
  slug: 'building',
  description: 'A physical structure'
});

const roomType = await typeCollection.create({
  name: 'Room',
  slug: 'room',
  description: 'A room within a building'
});

// Get places by type
const buildings = await placeCollection.getByType('building');
console.log(`Found ${buildings.length} buildings`);

// Get or create type (idempotent)
const zoneType = await typeCollection.getOrCreate('zone');
```

### Geocoding Provider Selection

```typescript
// Use OpenStreetMap (default, no API key required)
const place1 = await placeCollection.lookupOrCreate('Golden Gate Bridge', {
  geoProvider: 'openstreetmap'
});

// Use Google Maps (requires GOOGLE_MAPS_API_KEY environment variable)
const place2 = await placeCollection.lookupOrCreate('Eiffel Tower', {
  geoProvider: 'google'
});
```

### Abstract Places (No Geo Data)

```typescript
// Create virtual world places without coordinates
const virtualWorld = await placeCollection.create({
  typeId: (await typeCollection.getOrCreate('zone')).id,
  name: 'Virtual World Alpha',
  description: 'A virtual reality space'
  // No geo fields required
});

const virtualZone = await placeCollection.create({
  typeId: (await typeCollection.getOrCreate('zone')).id,
  parentId: virtualWorld.id,
  name: 'Zone 1',
  description: 'First zone in virtual world'
});

console.log(`Has coordinates: ${virtualWorld.hasCoordinates()}`); // false
```

### Querying Root Places

```typescript
// Get all top-level places (no parent)
const rootPlaces = await placeCollection.getRootPlaces();

for (const root of rootPlaces) {
  console.log(`Root place: ${root.name}`);
  const children = await root.getChildren();
  console.log(`  Children: ${children.length}`);
}
```

### Collection Methods

```typescript
// Get specific place
const place = await placeCollection.get({ id: 'place-id' });

// List all places
const allPlaces = await placeCollection.list({});

// List with filters
const citiesInCA = await placeCollection.list({
  where: {
    typeId: cityType.id,
    region: 'California'
  }
});

// Get immediate children of a place
const children = await placeCollection.getChildren('parent-place-id');

// Get full hierarchy for a place
const hierarchy = await placeCollection.getHierarchy('place-id');
```

## TypeScript Support

The package is written in TypeScript and provides comprehensive type definitions:

```typescript
import type {
  Place,
  PlaceType,
  PlaceOptions,
  PlaceTypeOptions,
  GeoData,
  PlaceHierarchy,
  LookupOrCreateOptions
} from '@smrt/places';

// Type-safe place creation
const placeOptions: PlaceOptions = {
  name: 'My Place',
  latitude: 37.7749,
  longitude: -122.4194,
  typeId: 'type-id'
};

// Type-safe geo data
const geoData: GeoData = {
  latitude: 37.7749,
  longitude: -122.4194,
  city: 'San Francisco',
  region: 'California',
  country: 'United States'
};
```

## Database Schema

Places are persisted with the following schema:

### Place
- `id`: UUID (primary key)
- `typeId`: Foreign key to PlaceType
- `parentId`: Foreign key to parent Place (nullable for root places)
- `name`: Place name/title
- `description`: Optional description
- `latitude`, `longitude`: Geographic coordinates (nullable)
- `streetNumber`, `streetName`, `city`, `region`, `country`, `postalCode`, `countryCode`, `timezone`: Address components
- `externalId`: External system identifier
- `source`: Geocoding provider used
- `metadata`: JSON metadata as text
- `createdAt`, `updatedAt`: Timestamps

### PlaceType
- `id`: UUID (primary key)
- `slug`: Unique slug identifier
- `name`: Display name
- `description`: Optional description
- `createdAt`, `updatedAt`: Timestamps

## Integration with @have/geo

This package seamlessly integrates with `@have/geo` for geocoding:

```typescript
import { getGeoAdapter } from '@have/geo';

// The PlaceCollection uses @have/geo internally
const place = await placeCollection.lookupOrCreate('Address', {
  geoProvider: 'openstreetmap'
});

// Or use @have/geo directly
const geo = await getGeoAdapter({
  provider: 'openstreetmap',
  userAgent: 'my-app'
});

const locations = await geo.lookup('1600 Amphitheatre Parkway');
console.log(locations[0].name);
```

## SMRT Framework Integration

Places and PlaceTypes are SMRT objects with auto-generated interfaces:

```typescript
// REST API endpoints (auto-generated)
// GET    /api/places
// GET    /api/places/:id
// POST   /api/places
// PUT    /api/places/:id
// DELETE /api/places/:id

// CLI commands (auto-generated)
// place list
// place get <id>
// place create --name "Name" --latitude 37.7749 --longitude -122.4194
// place update <id> --name "New Name"
// place delete <id>

// MCP tools (auto-generated)
// list_places
// get_place
// create_place
// update_place
```

## API Reference

For complete API documentation, see the [API Reference](/api/places/globals).

## License

This package is part of the SMRT framework and is licensed under the MIT License - see the [LICENSE](_media/LICENSE) file for details.
