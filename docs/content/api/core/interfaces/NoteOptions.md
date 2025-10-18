# Interface: NoteOptions

Defined in: smrt/packages/core/src/system/types.ts:8

Options for storing a note

## Properties

### confidence?

> `optional` **confidence**: `number`

Defined in: smrt/packages/core/src/system/types.ts:18

Confidence score (0.0 to 1.0)

***

### expiresAt?

> `optional` **expiresAt**: `Date`

Defined in: smrt/packages/core/src/system/types.ts:22

Expiration date

***

### key

> **key**: `string`

Defined in: smrt/packages/core/src/system/types.ts:12

Normalized identifier (e.g., URL, entity ID)

***

### metadata?

> `optional` **metadata**: [`NoteMetadata`](NoteMetadata.md)

Defined in: smrt/packages/core/src/system/types.ts:16

Additional metadata

***

### scope

> **scope**: `string`

Defined in: smrt/packages/core/src/system/types.ts:10

Hierarchical scope (e.g., 'discovery/parser/domain.com')

***

### value

> **value**: `any`

Defined in: smrt/packages/core/src/system/types.ts:14

Strategy data (regex patterns, selectors, etc.)

***

### version?

> `optional` **version**: `number`

Defined in: smrt/packages/core/src/system/types.ts:20

Strategy version number
