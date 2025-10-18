# Interface: AiConfig

Defined in: smrt/packages/core/src/tools/tool-generator.ts:14

Configuration for AI-callable methods

## Properties

### callable?

> `optional` **callable**: `string`[] \| `"public-async"` \| `"all"`

Defined in: smrt/packages/core/src/tools/tool-generator.ts:21

Methods that AI can call
- Array of method names, e.g., ['analyze', 'validate']
- 'public-async' to auto-include all public async methods
- 'all' to include all methods (not recommended)

***

### descriptions?

> `optional` **descriptions**: `Record`\<`string`, `string`\>

Defined in: smrt/packages/core/src/tools/tool-generator.ts:31

Additional tool descriptions to override method JSDoc

***

### exclude?

> `optional` **exclude**: `string`[]

Defined in: smrt/packages/core/src/tools/tool-generator.ts:26

Methods to exclude from AI calling (higher priority than callable)
