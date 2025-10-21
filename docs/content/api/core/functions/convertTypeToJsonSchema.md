# Function: convertTypeToJsonSchema()

> **convertTypeToJsonSchema**(`tsType`): `Record`\<`string`, `any`\>

Defined in: [smrt/packages/core/src/tools/tool-generator.ts:40](https://github.com/happyvertical/smrt/blob/bfd2feaea84273ee833a92e2d20c959aedfcfbd9/packages/core/src/tools/tool-generator.ts#L40)

Converts a TypeScript type string to JSON Schema format

## Parameters

### tsType

`string`

TypeScript type string (e.g., 'string', 'number', '{ foo: string }')

## Returns

`Record`\<`string`, `any`\>

JSON Schema representation
