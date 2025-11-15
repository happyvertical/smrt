# Function: startRestServer()

> **startRestServer**(`objects`, `context`, `config`): `Promise`\<() => `Promise`\<`void`\>\>

Defined in: [packages/core/src/generators/rest.ts:605](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/generators/rest.ts#L605)

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
