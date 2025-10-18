# Interface: NoteOptions

Defined in: [smrt/packages/core/src/system/types.ts:8](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/system/types.ts#L8)

Options for storing a note

## Properties

### confidence?

> `optional` **confidence**: `number`

Defined in: [smrt/packages/core/src/system/types.ts:18](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/system/types.ts#L18)

Confidence score (0.0 to 1.0)

***

### expiresAt?

> `optional` **expiresAt**: `Date`

Defined in: [smrt/packages/core/src/system/types.ts:22](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/system/types.ts#L22)

Expiration date

***

### key

> **key**: `string`

Defined in: [smrt/packages/core/src/system/types.ts:12](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/system/types.ts#L12)

Normalized identifier (e.g., URL, entity ID)

***

### metadata?

> `optional` **metadata**: [`NoteMetadata`](NoteMetadata.md)

Defined in: [smrt/packages/core/src/system/types.ts:16](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/system/types.ts#L16)

Additional metadata

***

### scope

> **scope**: `string`

Defined in: [smrt/packages/core/src/system/types.ts:10](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/system/types.ts#L10)

Hierarchical scope (e.g., 'discovery/parser/domain.com')

***

### value

> **value**: `any`

Defined in: [smrt/packages/core/src/system/types.ts:14](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/system/types.ts#L14)

Strategy data (regex patterns, selectors, etc.)

***

### version?

> `optional` **version**: `number`

Defined in: [smrt/packages/core/src/system/types.ts:20](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/system/types.ts#L20)

Strategy version number
