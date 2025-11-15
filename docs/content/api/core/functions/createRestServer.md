# Function: createRestServer()

> **createRestServer**(`objects`, `context`, `config`): `object`

Defined in: [packages/core/src/generators/rest.ts:582](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/generators/rest.ts#L582)

Create REST server with health checks using Bun

## Parameters

### objects

*typeof* [`SmrtObject`](../classes/SmrtObject.md)[]

### context

[`APIContext`](../interfaces/APIContext.md) = `{}`

### config

[`RestServerConfig`](../interfaces/RestServerConfig.md) = `{}`

## Returns

`object`

### server

> **server**: `any`

### url

> **url**: `string`
