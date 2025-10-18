# Function: startRestServer()

> **startRestServer**(`objects`, `context`, `config`): `Promise`\<() => `Promise`\<`void`\>\>

Defined in: [smrt/packages/core/src/generators/rest.ts:605](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/generators/rest.ts#L605)

Start server with graceful shutdown

## Parameters

### objects

*typeof* [`SmrtObject`](../classes/SmrtObject.md)[]

### context

[`APIContext`](../interfaces/APIContext.md) = `{}`

### config

[`RestServerConfig`](../interfaces/RestServerConfig.md) = `{}`

## Returns

`Promise`\<() => `Promise`\<`void`\>\>
