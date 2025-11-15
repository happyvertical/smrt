# Function: generateToolManifest()

> **generateToolManifest**(`methods`, `config?`): `AITool`[]

Defined in: [packages/core/src/tools/tool-generator.ts:221](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/tools/tool-generator.ts#L221)

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
