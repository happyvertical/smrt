# Function: startRestServer()

> **startRestServer**(`objects`, `context`, `config`): `Promise`\<() => `Promise`\<`void`\>\>

Defined in: smrt/packages/core/src/generators/rest.ts:605

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
