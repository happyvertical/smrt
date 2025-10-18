# Function: startRestServer()

> **startRestServer**(`objects`, `context`, `config`): `Promise`\<() => `Promise`\<`void`\>\>

Defined in: [smrt/packages/core/src/generators/rest.ts:602](https://github.com/happyvertical/smrt/blob/71a16025d52b026725fd522a392015e67e1d6489/packages/core/src/generators/rest.ts#L602)

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
