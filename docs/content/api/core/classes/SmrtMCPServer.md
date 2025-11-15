# Class: SmrtMCPServer

Defined in: [packages/core/src/runtime/mcp.ts:18](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/runtime/mcp.ts#L18)

## Constructors

### Constructor

> **new SmrtMCPServer**(`options`): `SmrtMCPServer`

Defined in: [packages/core/src/runtime/mcp.ts:21](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/runtime/mcp.ts#L21)

#### Parameters

##### options

[`MCPServerOptions`](../interfaces/MCPServerOptions.md) = `{}`

#### Returns

`SmrtMCPServer`

## Methods

### addTool()

> **addTool**(`tool`, `handler`): `void`

Defined in: [packages/core/src/runtime/mcp.ts:34](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/runtime/mcp.ts#L34)

Add a tool to the server

#### Parameters

##### tool

`MCPTool`

##### handler

(`params`) => `Promise`\<`any`\>

#### Returns

`void`

***

### executeTool()

> **executeTool**(`name`, `params`): `Promise`\<`any`\>

Defined in: [packages/core/src/runtime/mcp.ts:49](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/runtime/mcp.ts#L49)

Execute a tool

#### Parameters

##### name

`string`

##### params

`any`

#### Returns

`Promise`\<`any`\>

***

### getServerInfo()

> **getServerInfo**(): `object`

Defined in: [packages/core/src/runtime/mcp.ts:67](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/runtime/mcp.ts#L67)

Get server info

#### Returns

`object`

##### name

> **name**: `string`

##### toolCount

> **toolCount**: `number`

##### version

> **version**: `string`

***

### getTools()

> **getTools**(): `MCPTool`[]

Defined in: [packages/core/src/runtime/mcp.ts:42](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/runtime/mcp.ts#L42)

Get all available tools

#### Returns

`MCPTool`[]

***

### start()

> **start**(): `Promise`\<`void`\>

Defined in: [packages/core/src/runtime/mcp.ts:78](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/runtime/mcp.ts#L78)

Start the MCP server (basic implementation)

#### Returns

`Promise`\<`void`\>
