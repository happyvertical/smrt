# Interface: AiConfig

Defined in: [smrt/packages/core/src/tools/tool-generator.ts:14](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/tools/tool-generator.ts#L14)

Configuration for AI-callable methods

## Properties

### callable?

> `optional` **callable**: `string`[] \| `"public-async"` \| `"all"`

Defined in: [smrt/packages/core/src/tools/tool-generator.ts:21](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/tools/tool-generator.ts#L21)

Methods that AI can call
- Array of method names, e.g., ['analyze', 'validate']
- 'public-async' to auto-include all public async methods
- 'all' to include all methods (not recommended)

***

### descriptions?

> `optional` **descriptions**: `Record`\<`string`, `string`\>

Defined in: [smrt/packages/core/src/tools/tool-generator.ts:31](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/tools/tool-generator.ts#L31)

Additional tool descriptions to override method JSDoc

***

### exclude?

> `optional` **exclude**: `string`[]

Defined in: [smrt/packages/core/src/tools/tool-generator.ts:26](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/tools/tool-generator.ts#L26)

Methods to exclude from AI calling (higher priority than callable)
