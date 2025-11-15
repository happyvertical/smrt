# Interface: ToolCallResult

Defined in: [packages/core/src/tools/tool-executor.ts:44](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/tools/tool-executor.ts#L44)

Result of executing a tool call

## Properties

### arguments

> **arguments**: `Record`\<`string`, `any`\>

Defined in: [packages/core/src/tools/tool-executor.ts:58](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/tools/tool-executor.ts#L58)

Parsed arguments that were used

***

### duration?

> `optional` **duration**: `number`

Defined in: [packages/core/src/tools/tool-executor.ts:78](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/tools/tool-executor.ts#L78)

Execution time in milliseconds

***

### error?

> `optional` **error**: `string`

Defined in: [packages/core/src/tools/tool-executor.ts:73](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/tools/tool-executor.ts#L73)

Error message if call failed

***

### id

> **id**: `string`

Defined in: [packages/core/src/tools/tool-executor.ts:48](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/tools/tool-executor.ts#L48)

Tool call ID for correlation

***

### methodName

> **methodName**: `string`

Defined in: [packages/core/src/tools/tool-executor.ts:53](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/tools/tool-executor.ts#L53)

Method name that was called

***

### result

> **result**: `any`

Defined in: [packages/core/src/tools/tool-executor.ts:63](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/tools/tool-executor.ts#L63)

Result returned from the method

***

### success

> **success**: `boolean`

Defined in: [packages/core/src/tools/tool-executor.ts:68](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/tools/tool-executor.ts#L68)

Whether the call succeeded
