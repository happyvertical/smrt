# Function: executeToolCall()

> **executeToolCall**(`instance`, `toolCall`, `allowedMethods`, `signalBus?`): `Promise`\<[`ToolCallResult`](../interfaces/ToolCallResult.md)\>

Defined in: [smrt/packages/core/src/tools/tool-executor.ts:122](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/tools/tool-executor.ts#L122)

Executes a tool call on an object instance

## Parameters

### instance

`any`

Object instance to call method on

### toolCall

[`ToolCall`](../interfaces/ToolCall.md)

Tool call from AI

### allowedMethods

`string`[]

List of methods AI is allowed to call

### signalBus?

[`SignalBus`](../classes/SignalBus.md)

Optional signal bus for emitting execution events

## Returns

`Promise`\<[`ToolCallResult`](../interfaces/ToolCallResult.md)\>

Result of the tool call execution
