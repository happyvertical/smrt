# Function: convertTypeToJsonSchema()

> **convertTypeToJsonSchema**(`tsType`): `Record`\<`string`, `any`\>

Defined in: [smrt/packages/core/src/tools/tool-generator.ts:40](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/tools/tool-generator.ts#L40)

Converts a TypeScript type string to JSON Schema format

## Parameters

### tsType

`string`

TypeScript type string (e.g., 'string', 'number', '{ foo: string }')

## Returns

`Record`\<`string`, `any`\>

JSON Schema representation
