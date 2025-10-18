# Function: generateUniqueSlug()

> **generateUniqueSlug**(`name`, `context`, `tagCollection`): `Promise`\<`string`\>

Defined in: tags/src/utils.ts:100

Generate a unique slug from a name

Creates a slug and ensures uniqueness by appending a number if needed.

## Parameters

### name

`string`

The name to convert to slug

### context

`string`

The context for uniqueness checking

### tagCollection

[`TagCollection`](../classes/TagCollection.md)

TagCollection instance for queries

## Returns

`Promise`\<`string`\>

Unique slug
