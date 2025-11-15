# Class: MCPGenerator

Defined in: [packages/core/src/generators/mcp.ts:67](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/generators/mcp.ts#L67)

Generate MCP server from smrt objects

## Constructors

### Constructor

> **new MCPGenerator**(`config`, `context`): `MCPGenerator`

Defined in: [packages/core/src/generators/mcp.ts:72](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/generators/mcp.ts#L72)

#### Parameters

##### config

[`MCPConfig`](../interfaces/MCPConfig.md) = `{}`

##### context

[`MCPContext`](../interfaces/MCPContext.md) = `{}`

#### Returns

`MCPGenerator`

## Accessors

### name

#### Get Signature

> **get** **name**(): `string` \| `undefined`

Defined in: [packages/core/src/generators/mcp.ts:89](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/generators/mcp.ts#L89)

Get server name

##### Returns

`string` \| `undefined`

***

### version

#### Get Signature

> **get** **version**(): `string` \| `undefined`

Defined in: [packages/core/src/generators/mcp.ts:96](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/generators/mcp.ts#L96)

Get server version

##### Returns

`string` \| `undefined`

## Methods

### generateServer()

> **generateServer**(`options`): `Promise`\<`void`\>

Defined in: [packages/core/src/generators/mcp.ts:760](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/generators/mcp.ts#L760)

Generate complete MCP server with stdio transport

Creates a runnable Node.js script that exposes SMRT objects as MCP tools.
The generated server includes:
- Stdio transport integration
- Tool registration from ObjectRegistry
- Error handling and logging
- Graceful shutdown

#### Parameters

##### options

Server generation options

###### debug?

`boolean`

Enable debug logging

###### generateClaudeConfigFile?

`boolean`

Generate Claude Desktop configuration example

###### generateReadme?

`boolean`

Generate README documentation

###### modular?

`boolean`

Generate modular directory structure (tools/, handlers/, config.ts)

###### outputPath?

`string`

Path to output server file (relative or absolute)

###### serverName?

`string`

Server name for configuration

###### serverVersion?

`string`

Server version

#### Returns

`Promise`\<`void`\>

Promise that resolves when all files are written

#### Example

```typescript
const generator = new MCPGenerator({
  name: 'my-app',
  version: '1.0.0'
});

await generator.generateServer({
  outputPath: '.smrt/mcp-server/index.js',
  serverName: 'my-app-mcp',
  debug: true
});
```

***

### generateTools()

> **generateTools**(): `Promise`\<[`MCPTool`](../interfaces/MCPTool.md)[]\>

Defined in: [packages/core/src/generators/mcp.ts:103](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/generators/mcp.ts#L103)

Generate all available tools from registered objects

#### Returns

`Promise`\<[`MCPTool`](../interfaces/MCPTool.md)[]\>

***

### getServerInfo()

> **getServerInfo**(): `object`

Defined in: [packages/core/src/generators/mcp.ts:725](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/generators/mcp.ts#L725)

Generate MCP server info

#### Returns

`object`

##### description

> **description**: `string` \| `undefined`

##### name

> **name**: `string` \| `undefined`

##### version

> **version**: `string` \| `undefined`

***

### handleToolCall()

> **handleToolCall**(`request`): `Promise`\<[`MCPResponse`](../interfaces/MCPResponse.md)\>

Defined in: [packages/core/src/generators/mcp.ts:456](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/generators/mcp.ts#L456)

Handle MCP tool calls

#### Parameters

##### request

[`MCPRequest`](../interfaces/MCPRequest.md)

#### Returns

`Promise`\<[`MCPResponse`](../interfaces/MCPResponse.md)\>
