# Interface: SmartObjectConfig

Defined in: [packages/core/src/registry.ts:66](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/registry.ts#L66)

Configuration options for SMRT objects registered in the system

Controls how objects are exposed through generated APIs, CLIs, and MCP servers.
Each section configures a different aspect of code generation and runtime behavior.

 SmartObjectConfig

## Properties

### \_manifest?

> `optional` **\_manifest**: [`SmartObjectManifest`](SmartObjectManifest.md)

Defined in: [packages/core/src/registry.ts:204](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/registry.ts#L204)

**`Internal`**

Synchronous manifest for build-time imports (Issue #270 Phase 1)
Allows passing manifest directly instead of async loading
 Advanced usage - typically set by build tools

***

### ai?

> `optional` **ai**: `object`

Defined in: [packages/core/src/registry.ts:165](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/registry.ts#L165)

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

> `optional` **api**: `boolean` \| \{ `customize?`: `Record`\<`string`, (`req`, `collection`) => `Promise`\<`any`\>\>; `exclude?`: `string`[]; `include?`: `string`[]; `middleware?`: `any`[]; \}

Defined in: [packages/core/src/registry.ts:104](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/registry.ts#L104)

API configuration

#### Type Declaration

`boolean`

\{ `customize?`: `Record`\<`string`, (`req`, `collection`) => `Promise`\<`any`\>\>; `exclude?`: `string`[]; `include?`: `string`[]; `middleware?`: `any`[]; \}

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

Defined in: [packages/core/src/registry.ts:148](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/registry.ts#L148)

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

Defined in: [packages/core/src/registry.ts:188](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/registry.ts#L188)

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

> `optional` **mcp**: `boolean` \| \{ `exclude?`: `string`[]; `include?`: `string`[]; \}

Defined in: [packages/core/src/registry.ts:131](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/registry.ts#L131)

MCP server configuration

#### Type Declaration

`boolean`

\{ `exclude?`: `string`[]; `include?`: `string`[]; \}

#### exclude?

> `optional` **exclude**: `string`[]

Exclude specific tools (supports both standard CRUD actions and custom methods)

#### include?

> `optional` **include**: `string`[]

Include specific tools (supports both standard CRUD actions and custom methods)

***

### name?

> `optional` **name**: `string`

Defined in: [packages/core/src/registry.ts:70](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/registry.ts#L70)

Custom name for the object (defaults to class name)

***

### tableName?

> `optional` **tableName**: `string`

Defined in: [packages/core/src/registry.ts:76](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/registry.ts#L76)

Custom table name for database storage (defaults to pluralized snake_case class name)
Explicitly setting this ensures the table name survives code minification

***

### tableStrategy?

> `optional` **tableStrategy**: `"cti"` \| `"sti"`

Defined in: [packages/core/src/registry.ts:99](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/registry.ts#L99)

Table inheritance strategy (defaults to 'cti')
- 'cti': Class Table Inheritance - one table per class (current default)
- 'sti': Single Table Inheritance - shared table with discriminator column

Set once on base class, children inherit automatically.

#### Example

```typescript
@smrt({ tableStrategy: 'sti' })
class Event extends SmrtObject {
  title: string = '';
}

// Meeting inherits 'sti' strategy
@smrt()
class Meeting extends Event {
  roomId = foreignKey(Room);
}
```
