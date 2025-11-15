# Function: shouldIncludeMethod()

> **shouldIncludeMethod**(`method`, `config?`): `boolean`

Defined in: [packages/core/src/tools/tool-generator.ts:118](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/tools/tool-generator.ts#L118)

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
