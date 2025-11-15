# Interface: ToolCall

Defined in: [packages/core/src/tools/tool-executor.ts:14](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/tools/tool-executor.ts#L14)

Tool call structure from AI response

## Properties

### function

> **function**: `object`

Defined in: [packages/core/src/tools/tool-executor.ts:28](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/tools/tool-executor.ts#L28)

Function details

#### arguments

> **arguments**: `string`

JSON string of arguments to pass to the method

#### name

> **name**: `string`

Name of the method to call

***

### id

> **id**: `string`

Defined in: [packages/core/src/tools/tool-executor.ts:18](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/tools/tool-executor.ts#L18)

Unique identifier for this tool call

***

### type

> **type**: `"function"`

Defined in: [packages/core/src/tools/tool-executor.ts:23](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/tools/tool-executor.ts#L23)

Type of tool (always 'function' for now)
