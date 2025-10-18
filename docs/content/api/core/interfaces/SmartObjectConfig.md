# Interface: SmartObjectConfig

Defined in: smrt/packages/core/src/registry.ts:47

Configuration options for SMRT objects registered in the system

Controls how objects are exposed through generated APIs, CLIs, and MCP servers.
Each section configures a different aspect of code generation and runtime behavior.

 SmartObjectConfig

## Properties

### ai?

> `optional` **ai**: `object`

Defined in: smrt/packages/core/src/registry.ts:119

AI callable configuration

#### callable?

> `optional` **callable**: `string`[] \| `"public-async"` \| `"all"`

Methods that AI can call
- Array of method names, e.g., ['analyze', 'validate']
- 'public-async' to auto-include all public async methods
- 'all' to include all methods (not recommended)

#### descriptions?

> `optional` **descriptions**: `Record`\<`string`, `string`\>

Additional tool descriptions to override method JSDoc

#### exclude?

> `optional` **exclude**: `string`[]

Methods to exclude from AI calling (higher priority than callable)

***

### api?

> `optional` **api**: `object`

Defined in: smrt/packages/core/src/registry.ts:62

API configuration

#### customize?

> `optional` **customize**: `Record`\<`string`, (`req`, `collection`) => `Promise`\<`any`\>\>

Custom endpoint handlers (supports both standard CRUD actions and custom methods)

#### exclude?

> `optional` **exclude**: `string`[]

Exclude specific endpoints (supports both standard CRUD actions and custom methods)

#### include?

> `optional` **include**: `string`[]

Include only specific endpoints (supports both standard CRUD actions and custom methods)

#### middleware?

> `optional` **middleware**: `any`[]

Custom middleware for this object's endpoints

***

### cli?

> `optional` **cli**: `boolean` \| \{ `exclude?`: `string`[]; `include?`: `string`[]; \}

Defined in: smrt/packages/core/src/registry.ts:102

CLI configuration

#### Type Declaration

`boolean`

\{ `exclude?`: `string`[]; `include?`: `string`[]; \}

#### exclude?

> `optional` **exclude**: `string`[]

Exclude specific commands (supports both standard CRUD actions and custom methods)

#### include?

> `optional` **include**: `string`[]

Include specific commands (supports both standard CRUD actions and custom methods)

***

### hooks?

> `optional` **hooks**: `object`

Defined in: smrt/packages/core/src/registry.ts:142

Lifecycle hooks

#### afterCreate?

> `optional` **afterCreate**: `string` \| (`instance`) => `Promise`\<`void`\>

#### afterDelete?

> `optional` **afterDelete**: `string` \| (`instance`) => `Promise`\<`void`\>

#### afterSave?

> `optional` **afterSave**: `string` \| (`instance`) => `Promise`\<`void`\>

#### afterUpdate?

> `optional` **afterUpdate**: `string` \| (`instance`) => `Promise`\<`void`\>

#### beforeCreate?

> `optional` **beforeCreate**: `string` \| (`instance`) => `Promise`\<`void`\>

#### beforeDelete?

> `optional` **beforeDelete**: `string` \| (`instance`) => `Promise`\<`void`\>

#### beforeSave?

> `optional` **beforeSave**: `string` \| (`instance`) => `Promise`\<`void`\>

#### beforeUpdate?

> `optional` **beforeUpdate**: `string` \| (`instance`) => `Promise`\<`void`\>

***

### mcp?

> `optional` **mcp**: `object`

Defined in: smrt/packages/core/src/registry.ts:87

MCP server configuration

#### exclude?

> `optional` **exclude**: `string`[]

Exclude specific tools (supports both standard CRUD actions and custom methods)

#### include?

> `optional` **include**: `string`[]

Include specific tools (supports both standard CRUD actions and custom methods)

***

### name?

> `optional` **name**: `string`

Defined in: smrt/packages/core/src/registry.ts:51

Custom name for the object (defaults to class name)

***

### tableName?

> `optional` **tableName**: `string`

Defined in: smrt/packages/core/src/registry.ts:57

Custom table name for database storage (defaults to pluralized snake_case class name)
Explicitly setting this ensures the table name survives code minification
