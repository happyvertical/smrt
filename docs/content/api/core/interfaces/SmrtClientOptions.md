# Interface: SmrtClientOptions

Defined in: smrt/packages/core/src/runtime/types.ts:22

## Properties

### auth?

> `optional` **auth**: `object`

Defined in: smrt/packages/core/src/runtime/types.ts:25

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

Defined in: smrt/packages/core/src/runtime/types.ts:24

***

### baseUrl?

> `optional` **baseUrl**: `string`

Defined in: smrt/packages/core/src/runtime/types.ts:23

***

### fetch()?

> `optional` **fetch**: (`input`, `init?`) => `Promise`\<`Response`\>

Defined in: smrt/packages/core/src/runtime/types.ts:31

#### Parameters

##### input

`string` | `Request` | `URL`

##### init?

`RequestInit`

#### Returns

`Promise`\<`Response`\>
