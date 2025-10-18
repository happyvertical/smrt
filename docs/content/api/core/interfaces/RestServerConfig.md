# Interface: RestServerConfig

Defined in: smrt/packages/core/src/generators/rest.ts:571

## Extends

- [`APIConfig`](APIConfig.md)

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

#### Inherited from

[`APIConfig`](APIConfig.md).[`authMiddleware`](APIConfig.md#authmiddleware)

***

### basePath?

> `optional` **basePath**: `string`

Defined in: smrt/packages/core/src/generators/rest.ts:13

#### Inherited from

[`APIConfig`](APIConfig.md).[`basePath`](APIConfig.md#basepath)

***

### customRoutes?

> `optional` **customRoutes**: `Record`\<`string`, (`req`) => `Promise`\<`Response`\>\>

Defined in: smrt/packages/core/src/generators/rest.ts:15

#### Inherited from

[`APIConfig`](APIConfig.md).[`customRoutes`](APIConfig.md#customroutes)

***

### enableCors?

> `optional` **enableCors**: `boolean`

Defined in: smrt/packages/core/src/generators/rest.ts:14

#### Inherited from

[`APIConfig`](APIConfig.md).[`enableCors`](APIConfig.md#enablecors)

***

### healthCheck?

> `optional` **healthCheck**: `object`

Defined in: smrt/packages/core/src/generators/rest.ts:572

#### customChecks?

> `optional` **customChecks**: () => `Promise`\<`boolean`\>[]

##### Returns

`Promise`\<`boolean`\>

#### enabled?

> `optional` **enabled**: `boolean`

#### path?

> `optional` **path**: `string`

***

### hostname?

> `optional` **hostname**: `string`

Defined in: smrt/packages/core/src/generators/rest.ts:21

#### Inherited from

[`APIConfig`](APIConfig.md).[`hostname`](APIConfig.md#hostname)

***

### port?

> `optional` **port**: `number`

Defined in: smrt/packages/core/src/generators/rest.ts:20

#### Inherited from

[`APIConfig`](APIConfig.md).[`port`](APIConfig.md#port)
