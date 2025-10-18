# Function: shouldIncludeMethod()

> **shouldIncludeMethod**(`method`, `config?`): `boolean`

Defined in: [smrt/packages/core/src/tools/tool-generator.ts:118](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/tools/tool-generator.ts#L118)

Determines if a method should be included as an AI-callable tool

## Parameters

### method

`MethodDefinition`

Method definition from AST scanner

### config?

[`AiConfig`](../interfaces/AiConfig.md)

AI configuration from

## Returns

`boolean`

True if method should be callable by AI

## Smrt

decorator
