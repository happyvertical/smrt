# Class: APIGenerator

Defined in: [smrt/packages/core/src/generators/rest.ts:37](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/generators/rest.ts#L37)

High-performance API generator using native Bun

## Constructors

### Constructor

> **new APIGenerator**(`config`, `context`): `APIGenerator`

Defined in: [smrt/packages/core/src/generators/rest.ts:42](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/generators/rest.ts#L42)

#### Parameters

##### config

[`APIConfig`](../interfaces/APIConfig.md) = `{}`

##### context

[`APIContext`](../interfaces/APIContext.md) = `{}`

#### Returns

`APIGenerator`

## Methods

### createServer()

> **createServer**(): `object`

Defined in: [smrt/packages/core/src/generators/rest.ts:66](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/generators/rest.ts#L66)

Create Node.js HTTP server with all routes

#### Returns

`object`

##### server

> **server**: `any`

##### url

> **url**: `string`

***

### generateHandler()

> **generateHandler**(): (`req`) => `Promise`\<`Response`\>

Defined in: [smrt/packages/core/src/generators/rest.ts:155](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/generators/rest.ts#L155)

Generate fetch handler function (for serverless environments)

#### Returns

> (`req`): `Promise`\<`Response`\>

##### Parameters

###### req

`Request`

##### Returns

`Promise`\<`Response`\>

***

### registerCollection()

> **registerCollection**(`name`, `collection`): `void`

Defined in: [smrt/packages/core/src/generators/rest.ts:59](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/generators/rest.ts#L59)

Register a pre-configured collection instance for API exposure

#### Parameters

##### name

`string`

URL path segment for the collection (e.g., 'products' for /api/products)

##### collection

[`SmrtCollection`](SmrtCollection.md)\<`any`\>

Pre-initialized SmrtCollection instance

#### Returns

`void`
