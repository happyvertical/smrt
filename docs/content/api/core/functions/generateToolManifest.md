# Function: generateToolManifest()

> **generateToolManifest**(`methods`, `config?`): `AITool`[]

Defined in: [smrt/packages/core/src/tools/tool-generator.ts:221](https://github.com/happyvertical/smrt/blob/bfd2feaea84273ee833a92e2d20c959aedfcfbd9/packages/core/src/tools/tool-generator.ts#L221)

Generates tool manifest from method definitions

## Parameters

### methods

`MethodDefinition`[]

Array of method definitions from AST scanner

### config?

[`AiConfig`](../interfaces/AiConfig.md)

AI configuration from

## Returns

`AITool`[]

Array of AITool definitions for LLM function calling

## Smrt

decorator
