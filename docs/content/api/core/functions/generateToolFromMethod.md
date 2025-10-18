# Function: generateToolFromMethod()

> **generateToolFromMethod**(`method`, `config?`): `AITool`

Defined in: [smrt/packages/core/src/tools/tool-generator.ts:167](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/tools/tool-generator.ts#L167)

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
