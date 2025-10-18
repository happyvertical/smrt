# Function: hasCircularReference()

> **hasCircularReference**(`slug`, `parentSlug`, `tagCollection`): `Promise`\<`boolean`\>

Defined in: tags/src/utils.ts:49

Validate hierarchy for circular references

Checks if setting a parent would create a circular reference
(e.g., making a tag its own ancestor).

## Parameters

### slug

`string`

The tag being moved

### parentSlug

`string`

The proposed new parent

### tagCollection

[`TagCollection`](../classes/TagCollection.md)

TagCollection instance for queries

## Returns

`Promise`\<`boolean`\>

True if circular reference detected
