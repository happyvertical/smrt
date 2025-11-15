# Function: convertTypeToJsonSchema()

> **convertTypeToJsonSchema**(`tsType`): `Record`\<`string`, `any`\>

Defined in: [packages/core/src/tools/tool-generator.ts:40](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/tools/tool-generator.ts#L40)

Converts a TypeScript type string to JSON Schema format

## Parameters

### tsType

`string`

TypeScript type string (e.g., 'string', 'number', '{ foo: string }')

## Returns

`Record`\<`string`, `any`\>

JSON Schema representation
