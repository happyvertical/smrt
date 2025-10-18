# Interface: APIConfig

Defined in: [smrt/packages/core/src/generators/rest.ts:12](https://github.com/happyvertical/smrt/blob/71a16025d52b026725fd522a392015e67e1d6489/packages/core/src/generators/rest.ts#L12)

## Extended by

- [`RestServerConfig`](RestServerConfig.md)

## Properties

### authMiddleware()?

> `optional` **authMiddleware**: (`objectName`, `action`) => (`req`) => `Promise`\<`Request` \| `Response`\>

Defined in: [smrt/packages/core/src/generators/rest.ts:16](https://github.com/happyvertical/smrt/blob/71a16025d52b026725fd522a392015e67e1d6489/packages/core/src/generators/rest.ts#L16)

#### Parameters

##### objectName

`string`

##### action

`string`

#### Returns

> (`req`): `Promise`\<`Request` \| `Response`\>

##### Parameters

###### req

`Request`

##### Returns

`Promise`\<`Request` \| `Response`\>

***

### basePath?

> `optional` **basePath**: `string`

Defined in: [smrt/packages/core/src/generators/rest.ts:13](https://github.com/happyvertical/smrt/blob/71a16025d52b026725fd522a392015e67e1d6489/packages/core/src/generators/rest.ts#L13)

***

### customRoutes?

> `optional` **customRoutes**: `Record`\<`string`, (`req`) => `Promise`\<`Response`\>\>

Defined in: [smrt/packages/core/src/generators/rest.ts:15](https://github.com/happyvertical/smrt/blob/71a16025d52b026725fd522a392015e67e1d6489/packages/core/src/generators/rest.ts#L15)

***

### enableCors?

> `optional` **enableCors**: `boolean`

Defined in: [smrt/packages/core/src/generators/rest.ts:14](https://github.com/happyvertical/smrt/blob/71a16025d52b026725fd522a392015e67e1d6489/packages/core/src/generators/rest.ts#L14)

***

### hostname?

> `optional` **hostname**: `string`

Defined in: [smrt/packages/core/src/generators/rest.ts:21](https://github.com/happyvertical/smrt/blob/71a16025d52b026725fd522a392015e67e1d6489/packages/core/src/generators/rest.ts#L21)

***

### port?

> `optional` **port**: `number`

Defined in: [smrt/packages/core/src/generators/rest.ts:20](https://github.com/happyvertical/smrt/blob/71a16025d52b026725fd522a392015e67e1d6489/packages/core/src/generators/rest.ts#L20)
