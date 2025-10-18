# Interface: SmrtClientOptions

Defined in: [smrt/packages/core/src/runtime/types.ts:22](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/runtime/types.ts#L22)

## Properties

### auth?

> `optional` **auth**: `object`

Defined in: [smrt/packages/core/src/runtime/types.ts:25](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/runtime/types.ts#L25)

#### password?

> `optional` **password**: `string`

#### token?

> `optional` **token**: `string`

#### type

> **type**: `"bearer"` \| `"basic"`

#### username?

> `optional` **username**: `string`

***

### basePath?

> `optional` **basePath**: `string`

Defined in: [smrt/packages/core/src/runtime/types.ts:24](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/runtime/types.ts#L24)

***

### baseUrl?

> `optional` **baseUrl**: `string`

Defined in: [smrt/packages/core/src/runtime/types.ts:23](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/runtime/types.ts#L23)

***

### fetch()?

> `optional` **fetch**: (`input`, `init?`) => `Promise`\<`Response`\>

Defined in: [smrt/packages/core/src/runtime/types.ts:31](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/runtime/types.ts#L31)

#### Parameters

##### input

`string` | `Request` | `URL`

##### init?

`RequestInit`

#### Returns

`Promise`\<`Response`\>
