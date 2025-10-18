# Interface: ToolCall

Defined in: smrt/packages/core/src/tools/tool-executor.ts:14

Tool call structure from AI response

## Properties

### function

> **function**: `object`

Defined in: smrt/packages/core/src/tools/tool-executor.ts:28

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

Defined in: smrt/packages/core/src/tools/tool-executor.ts:18

Unique identifier for this tool call

***

### type

> **type**: `"function"`

Defined in: smrt/packages/core/src/tools/tool-executor.ts:23

Type of tool (always 'function' for now)
