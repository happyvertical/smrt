# Function: calculateLevel()

> **calculateLevel**(`parentSlug`, `tagCollection`): `Promise`\<`number`\>

Defined in: tags/src/utils.ts:78

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
