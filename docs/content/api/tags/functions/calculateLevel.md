# Function: calculateLevel()

> **calculateLevel**(`parentSlug`, `tagCollection`): `Promise`\<`number`\>

Defined in: [tags/src/utils.ts:78](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/tags/src/utils.ts#L78)

Calculate hierarchy level

Determines the level (depth) of a tag based on its parent.
Root tags have level 0, their children have level 1, etc.

## Parameters

### parentSlug

The parent tag slug (null for root)

`string` | `null`

### tagCollection

[`TagCollection`](../classes/TagCollection.md)

TagCollection instance for queries

## Returns

`Promise`\<`number`\>

The calculated level
