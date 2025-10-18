# Interface: LookupOrCreateOptions

Defined in: [places/src/types.ts:71](https://github.com/happyvertical/smrt/blob/71a16025d52b026725fd522a392015e67e1d6489/packages/places/src/types.ts#L71)

Options for lookupOrCreate method

## Properties

### coords?

> `optional` **coords**: `object`

Defined in: [places/src/types.ts:95](https://github.com/happyvertical/smrt/blob/71a16025d52b026725fd522a392015e67e1d6489/packages/places/src/types.ts#L95)

Coordinates for reverse geocoding

#### lat

> **lat**: `number`

#### lng

> **lng**: `number`

***

### createIfNotFound?

> `optional` **createIfNotFound**: `boolean`

Defined in: [places/src/types.ts:90](https://github.com/happyvertical/smrt/blob/71a16025d52b026725fd522a392015e67e1d6489/packages/places/src/types.ts#L90)

Whether to create if not found (default: true)

***

### geoProvider?

> `optional` **geoProvider**: `"google"` \| `"openstreetmap"`

Defined in: [places/src/types.ts:75](https://github.com/happyvertical/smrt/blob/71a16025d52b026725fd522a392015e67e1d6489/packages/places/src/types.ts#L75)

Which geo provider to use for lookups

***

### parentId?

> `optional` **parentId**: `string`

Defined in: [places/src/types.ts:85](https://github.com/happyvertical/smrt/blob/71a16025d52b026725fd522a392015e67e1d6489/packages/places/src/types.ts#L85)

Set parent place if known

***

### typeSlug?

> `optional` **typeSlug**: `string`

Defined in: [places/src/types.ts:80](https://github.com/happyvertical/smrt/blob/71a16025d52b026725fd522a392015e67e1d6489/packages/places/src/types.ts#L80)

Force a specific place type
