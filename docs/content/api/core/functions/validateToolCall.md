# Function: validateToolCall()

> **validateToolCall**(`methodName`, `args`, `allowedMethods`): `void`

Defined in: smrt/packages/core/src/tools/tool-executor.ts:89

Validates tool call arguments against method parameters

## Parameters

### methodName

`string`

Name of the method being called

### args

`Record`\<`string`, `any`\>

Parsed arguments from tool call

### allowedMethods

`string`[]

List of methods AI is allowed to call

## Returns

`void`

## Throws

ValidationError if method not allowed or arguments invalid
