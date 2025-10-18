# Interface: SmartObjectDefinition

Defined in: [smrt/packages/core/src/scanner/types.ts:40](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/scanner/types.ts#L40)

## Properties

### className

> **className**: `string`

Defined in: [smrt/packages/core/src/scanner/types.ts:42](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/scanner/types.ts#L42)

***

### collection

> **collection**: `string`

Defined in: [smrt/packages/core/src/scanner/types.ts:43](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/scanner/types.ts#L43)

***

### decoratorConfig

> **decoratorConfig**: `object`

Defined in: [smrt/packages/core/src/scanner/types.ts:47](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/scanner/types.ts#L47)

#### ai?

> `optional` **ai**: `object`

##### ai.callable?

> `optional` **callable**: `string`[] \| `"public-async"` \| `"all"`

##### ai.descriptions?

> `optional` **descriptions**: `Record`\<`string`, `string`\>

##### ai.exclude?

> `optional` **exclude**: `string`[]

#### api?

> `optional` **api**: `boolean` \| \{ `exclude?`: `string`[]; `include?`: `string`[]; \}

#### cli?

> `optional` **cli**: `boolean` \| \{ `exclude?`: `string`[]; `include?`: `string`[]; \}

#### mcp?

> `optional` **mcp**: `boolean` \| \{ `exclude?`: `string`[]; `include?`: `string`[]; \}

***

### extends?

> `optional` **extends**: `string`

Defined in: [smrt/packages/core/src/scanner/types.ts:72](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/scanner/types.ts#L72)

***

### fields

> **fields**: `Record`\<`string`, `FieldDefinition`\>

Defined in: [smrt/packages/core/src/scanner/types.ts:45](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/scanner/types.ts#L45)

***

### filePath

> **filePath**: `string`

Defined in: [smrt/packages/core/src/scanner/types.ts:44](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/scanner/types.ts#L44)

***

### methods

> **methods**: `Record`\<`string`, `MethodDefinition`\>

Defined in: [smrt/packages/core/src/scanner/types.ts:46](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/scanner/types.ts#L46)

***

### name

> **name**: `string`

Defined in: [smrt/packages/core/src/scanner/types.ts:41](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/scanner/types.ts#L41)

***

### tools?

> `optional` **tools**: `object`[]

Defined in: [smrt/packages/core/src/scanner/types.ts:73](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/scanner/types.ts#L73)

#### function

> **function**: `object`

##### function.description?

> `optional` **description**: `string`

##### function.name

> **name**: `string`

##### function.parameters?

> `optional` **parameters**: `Record`\<`string`, `any`\>

#### type

> **type**: `"function"`
