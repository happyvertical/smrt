# Interface: SmrtServerOptions

Defined in: smrt/packages/core/src/runtime/types.ts:5

Runtime type definitions for SMRT services

## Properties

### auth?

> `optional` **auth**: `object`

Defined in: smrt/packages/core/src/runtime/types.ts:16

#### type

> **type**: `"bearer"` \| `"basic"` \| `"custom"`

#### verify()?

> `optional` **verify**: (`token`) => `Promise`\<`any`\>

##### Parameters

###### token

`string`

##### Returns

`Promise`\<`any`\>

***

### basePath?

> `optional` **basePath**: `string`

Defined in: smrt/packages/core/src/runtime/types.ts:8

***

### cors?

> `optional` **cors**: `boolean` \| \{ `headers?`: `string`[]; `methods?`: `string`[]; `origin?`: `string` \| `string`[]; \}

Defined in: smrt/packages/core/src/runtime/types.ts:9

***

### hostname?

> `optional` **hostname**: `string`

Defined in: smrt/packages/core/src/runtime/types.ts:7

***

### port?

> `optional` **port**: `number`

Defined in: smrt/packages/core/src/runtime/types.ts:6
