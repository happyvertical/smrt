# Function: validateToolCall()

> **validateToolCall**(`methodName`, `args`, `allowedMethods`): `void`

Defined in: [smrt/packages/core/src/tools/tool-executor.ts:89](https://github.com/happyvertical/smrt/blob/71a16025d52b026725fd522a392015e67e1d6489/packages/core/src/tools/tool-executor.ts#L89)

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
