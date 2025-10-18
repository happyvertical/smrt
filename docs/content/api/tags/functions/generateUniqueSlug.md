# Function: generateUniqueSlug()

> **generateUniqueSlug**(`name`, `context`, `tagCollection`): `Promise`\<`string`\>

Defined in: [tags/src/utils.ts:100](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/tags/src/utils.ts#L100)

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
