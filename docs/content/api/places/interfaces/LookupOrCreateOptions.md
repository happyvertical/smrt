# Interface: LookupOrCreateOptions

Defined in: places/src/types.ts:71

Options for lookupOrCreate method

## Properties

### coords?

> `optional` **coords**: `object`

Defined in: places/src/types.ts:95

Coordinates for reverse geocoding

#### lat

> **lat**: `number`

#### lng

> **lng**: `number`

***

### createIfNotFound?

> `optional` **createIfNotFound**: `boolean`

Defined in: places/src/types.ts:90

Whether to create if not found (default: true)

***

### geoProvider?

> `optional` **geoProvider**: `"google"` \| `"openstreetmap"`

Defined in: places/src/types.ts:75

Which geo provider to use for lookups

***

### parentId?

> `optional` **parentId**: `string`

Defined in: places/src/types.ts:85

Set parent place if known

***

### typeSlug?

> `optional` **typeSlug**: `string`

Defined in: places/src/types.ts:80

Force a specific place type
