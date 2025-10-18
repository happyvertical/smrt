# Function: executeToolCalls()

> **executeToolCalls**(`instance`, `toolCalls`, `allowedMethods`, `signalBus?`): `Promise`\<[`ToolCallResult`](../interfaces/ToolCallResult.md)[]\>

Defined in: [smrt/packages/core/src/tools/tool-executor.ts:248](https://github.com/happyvertical/smrt/blob/71a16025d52b026725fd522a392015e67e1d6489/packages/core/src/tools/tool-executor.ts#L248)

Executes multiple tool calls in sequence

## Parameters

### instance

`any`

Object instance to call methods on

### toolCalls

[`ToolCall`](../interfaces/ToolCall.md)[]

Array of tool calls from AI

### allowedMethods

`string`[]

List of methods AI is allowed to call

### signalBus?

[`SignalBus`](../classes/SignalBus.md)

Optional signal bus for emitting execution events

## Returns

`Promise`\<[`ToolCallResult`](../interfaces/ToolCallResult.md)[]\>

Array of tool call results
