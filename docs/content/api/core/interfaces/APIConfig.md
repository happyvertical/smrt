# Interface: APIConfig

Defined in: smrt/packages/core/src/generators/rest.ts:12

## Extended by

- [`RestServerConfig`](RestServerConfig.md)

## Properties

### authMiddleware()?

> `optional` **authMiddleware**: (`objectName`, `action`) => (`req`) => `Promise`\<`Request` \| `Response`\>

Defined in: smrt/packages/core/src/generators/rest.ts:16

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

Defined in: smrt/packages/core/src/generators/rest.ts:13

***

### customRoutes?

> `optional` **customRoutes**: `Record`\<`string`, (`req`) => `Promise`\<`Response`\>\>

Defined in: smrt/packages/core/src/generators/rest.ts:15

***

### enableCors?

> `optional` **enableCors**: `boolean`

Defined in: smrt/packages/core/src/generators/rest.ts:14

***

### hostname?

> `optional` **hostname**: `string`

Defined in: smrt/packages/core/src/generators/rest.ts:21

***

### port?

> `optional` **port**: `number`

Defined in: smrt/packages/core/src/generators/rest.ts:20
