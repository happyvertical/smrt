# Interface: NoteMetadata

Defined in: [smrt/packages/core/src/system/types.ts:29](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/system/types.ts#L29)

Note metadata structure
Optimized for storing AI-learned strategies

## Indexable

\[`key`: `string`\]: `any`

Allow any other properties

## Properties

### aiConfidence?

> `optional` **aiConfidence**: `number`

Defined in: [smrt/packages/core/src/system/types.ts:35](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/system/types.ts#L35)

Original AI confidence

***

### aiModel?

> `optional` **aiModel**: `string`

Defined in: [smrt/packages/core/src/system/types.ts:33](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/system/types.ts#L33)

AI model used

***

### aiProvider?

> `optional` **aiProvider**: `string`

Defined in: [smrt/packages/core/src/system/types.ts:31](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/system/types.ts#L31)

AI provider used for learning

***

### expectedCount?

> `optional` **expectedCount**: `number`

Defined in: [smrt/packages/core/src/system/types.ts:41](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/system/types.ts#L41)

Expected result count

***

### humanReviewed?

> `optional` **humanReviewed**: `boolean`

Defined in: [smrt/packages/core/src/system/types.ts:53](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/system/types.ts#L53)

Whether human reviewed

***

### importance?

> `optional` **importance**: `number`

Defined in: [smrt/packages/core/src/system/types.ts:47](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/system/types.ts#L47)

Importance score

***

### pageHash?

> `optional` **pageHash**: `string`

Defined in: [smrt/packages/core/src/system/types.ts:43](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/system/types.ts#L43)

Hash of page HTML for change detection

***

### patterns?

> `optional` **patterns**: `string`[]

Defined in: [smrt/packages/core/src/system/types.ts:37](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/system/types.ts#L37)

Regex patterns

***

### replacesVersion?

> `optional` **replacesVersion**: `number`

Defined in: [smrt/packages/core/src/system/types.ts:51](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/system/types.ts#L51)

Version this replaces

***

### reviewedBy?

> `optional` **reviewedBy**: `string`

Defined in: [smrt/packages/core/src/system/types.ts:55](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/system/types.ts#L55)

Reviewer identifier

***

### reviewNotes?

> `optional` **reviewNotes**: `string`

Defined in: [smrt/packages/core/src/system/types.ts:57](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/system/types.ts#L57)

Review notes

***

### selectors?

> `optional` **selectors**: `string`[]

Defined in: [smrt/packages/core/src/system/types.ts:39](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/system/types.ts#L39)

CSS selectors

***

### source?

> `optional` **source**: `string`

Defined in: [smrt/packages/core/src/system/types.ts:49](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/system/types.ts#L49)

Source of the strategy

***

### tags?

> `optional` **tags**: `string`[]

Defined in: [smrt/packages/core/src/system/types.ts:45](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/system/types.ts#L45)

Tags for categorization
