# Function: generateToolManifest()

> **generateToolManifest**(`methods`, `config?`): `AITool`[]

Defined in: smrt/packages/core/src/tools/tool-generator.ts:221

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
