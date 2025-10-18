# Interface: SmrtServerOptions

Defined in: [smrt/packages/core/src/runtime/types.ts:5](https://github.com/happyvertical/smrt/blob/71a16025d52b026725fd522a392015e67e1d6489/packages/core/src/runtime/types.ts#L5)

Runtime type definitions for SMRT services

## Properties

### auth?

> `optional` **auth**: `object`

Defined in: [smrt/packages/core/src/runtime/types.ts:16](https://github.com/happyvertical/smrt/blob/71a16025d52b026725fd522a392015e67e1d6489/packages/core/src/runtime/types.ts#L16)

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

Defined in: [smrt/packages/core/src/runtime/types.ts:8](https://github.com/happyvertical/smrt/blob/71a16025d52b026725fd522a392015e67e1d6489/packages/core/src/runtime/types.ts#L8)

***

### cors?

> `optional` **cors**: `boolean` \| \{ `headers?`: `string`[]; `methods?`: `string`[]; `origin?`: `string` \| `string`[]; \}

Defined in: [smrt/packages/core/src/runtime/types.ts:9](https://github.com/happyvertical/smrt/blob/71a16025d52b026725fd522a392015e67e1d6489/packages/core/src/runtime/types.ts#L9)

***

### hostname?

> `optional` **hostname**: `string`

Defined in: [smrt/packages/core/src/runtime/types.ts:7](https://github.com/happyvertical/smrt/blob/71a16025d52b026725fd522a392015e67e1d6489/packages/core/src/runtime/types.ts#L7)

***

### port?

> `optional` **port**: `number`

Defined in: [smrt/packages/core/src/runtime/types.ts:6](https://github.com/happyvertical/smrt/blob/71a16025d52b026725fd522a392015e67e1d6489/packages/core/src/runtime/types.ts#L6)
