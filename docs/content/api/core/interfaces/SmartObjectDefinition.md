# Interface: SmartObjectDefinition

Defined in: [packages/core/src/scanner/types.ts:46](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/scanner/types.ts#L46)

## Properties

### className

> **className**: `string`

Defined in: [packages/core/src/scanner/types.ts:48](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/scanner/types.ts#L48)

***

### collection

> **collection**: `string`

Defined in: [packages/core/src/scanner/types.ts:49](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/scanner/types.ts#L49)

***

### collectionExportName?

> `optional` **collectionExportName**: `string`

Defined in: [packages/core/src/scanner/types.ts:56](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/scanner/types.ts#L56)

***

### decoratorConfig

> **decoratorConfig**: [`SmartObjectConfig`](SmartObjectConfig.md)

Defined in: [packages/core/src/scanner/types.ts:59](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/scanner/types.ts#L59)

***

### exportName?

> `optional` **exportName**: `string`

Defined in: [packages/core/src/scanner/types.ts:55](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/scanner/types.ts#L55)

***

### extends?

> `optional` **extends**: `string`

Defined in: [packages/core/src/scanner/types.ts:60](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/scanner/types.ts#L60)

***

### fields

> **fields**: `Record`\<`string`, `FieldDefinition`\>

Defined in: [packages/core/src/scanner/types.ts:57](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/scanner/types.ts#L57)

***

### filePath

> **filePath**: `string`

Defined in: [packages/core/src/scanner/types.ts:50](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/scanner/types.ts#L50)

***

### importPath?

> `optional` **importPath**: `string`

Defined in: [packages/core/src/scanner/types.ts:53](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/scanner/types.ts#L53)

***

### methods

> **methods**: `Record`\<`string`, `MethodDefinition`\>

Defined in: [packages/core/src/scanner/types.ts:58](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/scanner/types.ts#L58)

***

### modulePath?

> `optional` **modulePath**: `string`

Defined in: [packages/core/src/scanner/types.ts:54](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/scanner/types.ts#L54)

***

### name

> **name**: `string`

Defined in: [packages/core/src/scanner/types.ts:47](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/scanner/types.ts#L47)

***

### packageName?

> `optional` **packageName**: `string`

Defined in: [packages/core/src/scanner/types.ts:51](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/scanner/types.ts#L51)

***

### packageVersion?

> `optional` **packageVersion**: `string`

Defined in: [packages/core/src/scanner/types.ts:52](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/scanner/types.ts#L52)

***

### tools?

> `optional` **tools**: `object`[]

Defined in: [packages/core/src/scanner/types.ts:61](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/scanner/types.ts#L61)

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
