# Function: generateToolFromMethod()

> **generateToolFromMethod**(`method`, `config?`): `AITool`

Defined in: smrt/packages/core/src/tools/tool-generator.ts:167

Generates an AITool definition from a method definition

## Parameters

### method

`MethodDefinition`

Method definition from AST scanner

### config?

[`AiConfig`](../interfaces/AiConfig.md)

AI configuration for custom descriptions

## Returns

`AITool`

AITool definition for LLM function calling
