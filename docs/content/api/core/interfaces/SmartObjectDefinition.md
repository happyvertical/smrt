# Interface: SmartObjectDefinition

Defined in: smrt/packages/core/src/scanner/types.ts:40

## Properties

### className

> **className**: `string`

Defined in: smrt/packages/core/src/scanner/types.ts:42

***

### collection

> **collection**: `string`

Defined in: smrt/packages/core/src/scanner/types.ts:43

***

### decoratorConfig

> **decoratorConfig**: `object`

Defined in: smrt/packages/core/src/scanner/types.ts:47

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

Defined in: smrt/packages/core/src/scanner/types.ts:72

***

### fields

> **fields**: `Record`\<`string`, `FieldDefinition`\>

Defined in: smrt/packages/core/src/scanner/types.ts:45

***

### filePath

> **filePath**: `string`

Defined in: smrt/packages/core/src/scanner/types.ts:44

***

### methods

> **methods**: `Record`\<`string`, `MethodDefinition`\>

Defined in: smrt/packages/core/src/scanner/types.ts:46

***

### name

> **name**: `string`

Defined in: smrt/packages/core/src/scanner/types.ts:41

***

### tools?

> `optional` **tools**: `object`[]

Defined in: smrt/packages/core/src/scanner/types.ts:73

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
