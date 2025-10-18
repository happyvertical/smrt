# Interface: NoteMetadata

Defined in: smrt/packages/core/src/system/types.ts:29

Note metadata structure
Optimized for storing AI-learned strategies

## Indexable

\[`key`: `string`\]: `any`

Allow any other properties

## Properties

### aiConfidence?

> `optional` **aiConfidence**: `number`

Defined in: smrt/packages/core/src/system/types.ts:35

Original AI confidence

***

### aiModel?

> `optional` **aiModel**: `string`

Defined in: smrt/packages/core/src/system/types.ts:33

AI model used

***

### aiProvider?

> `optional` **aiProvider**: `string`

Defined in: smrt/packages/core/src/system/types.ts:31

AI provider used for learning

***

### expectedCount?

> `optional` **expectedCount**: `number`

Defined in: smrt/packages/core/src/system/types.ts:41

Expected result count

***

### humanReviewed?

> `optional` **humanReviewed**: `boolean`

Defined in: smrt/packages/core/src/system/types.ts:53

Whether human reviewed

***

### importance?

> `optional` **importance**: `number`

Defined in: smrt/packages/core/src/system/types.ts:47

Importance score

***

### pageHash?

> `optional` **pageHash**: `string`

Defined in: smrt/packages/core/src/system/types.ts:43

Hash of page HTML for change detection

***

### patterns?

> `optional` **patterns**: `string`[]

Defined in: smrt/packages/core/src/system/types.ts:37

Regex patterns

***

### replacesVersion?

> `optional` **replacesVersion**: `number`

Defined in: smrt/packages/core/src/system/types.ts:51

Version this replaces

***

### reviewedBy?

> `optional` **reviewedBy**: `string`

Defined in: smrt/packages/core/src/system/types.ts:55

Reviewer identifier

***

### reviewNotes?

> `optional` **reviewNotes**: `string`

Defined in: smrt/packages/core/src/system/types.ts:57

Review notes

***

### selectors?

> `optional` **selectors**: `string`[]

Defined in: smrt/packages/core/src/system/types.ts:39

CSS selectors

***

### source?

> `optional` **source**: `string`

Defined in: smrt/packages/core/src/system/types.ts:49

Source of the strategy

***

### tags?

> `optional` **tags**: `string`[]

Defined in: smrt/packages/core/src/system/types.ts:45

Tags for categorization
