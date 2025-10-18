# Interface: ToolCallResult

Defined in: smrt/packages/core/src/tools/tool-executor.ts:44

Result of executing a tool call

## Properties

### arguments

> **arguments**: `Record`\<`string`, `any`\>

Defined in: smrt/packages/core/src/tools/tool-executor.ts:58

Parsed arguments that were used

***

### duration?

> `optional` **duration**: `number`

Defined in: smrt/packages/core/src/tools/tool-executor.ts:78

Execution time in milliseconds

***

### error?

> `optional` **error**: `string`

Defined in: smrt/packages/core/src/tools/tool-executor.ts:73

Error message if call failed

***

### id

> **id**: `string`

Defined in: smrt/packages/core/src/tools/tool-executor.ts:48

Tool call ID for correlation

***

### methodName

> **methodName**: `string`

Defined in: smrt/packages/core/src/tools/tool-executor.ts:53

Method name that was called

***

### result

> **result**: `any`

Defined in: smrt/packages/core/src/tools/tool-executor.ts:63

Result returned from the method

***

### success

> **success**: `boolean`

Defined in: smrt/packages/core/src/tools/tool-executor.ts:68

Whether the call succeeded
