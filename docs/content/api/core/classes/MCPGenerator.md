# Class: MCPGenerator

Defined in: smrt/packages/core/src/generators/mcp.ts:67

Generate MCP server from smrt objects

## Constructors

### Constructor

> **new MCPGenerator**(`config`, `context`): `MCPGenerator`

Defined in: smrt/packages/core/src/generators/mcp.ts:72

#### Parameters

##### config

[`MCPConfig`](../interfaces/MCPConfig.md) = `{}`

##### context

[`MCPContext`](../interfaces/MCPContext.md) = `{}`

#### Returns

`MCPGenerator`

## Methods

### generateServer()

> **generateServer**(`options`): `Promise`\<`void`\>

Defined in: smrt/packages/core/src/generators/mcp.ts:687

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
  outputPath: 'dist/mcp-server.js',
  serverName: 'my-app-mcp',
  debug: true
});
```

***

### generateTools()

> **generateTools**(): [`MCPTool`](../interfaces/MCPTool.md)[]

Defined in: smrt/packages/core/src/generators/mcp.ts:89

Generate all available tools from registered objects

#### Returns

[`MCPTool`](../interfaces/MCPTool.md)[]

***

### getServerInfo()

> **getServerInfo**(): `object`

Defined in: smrt/packages/core/src/generators/mcp.ts:652

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

Defined in: smrt/packages/core/src/generators/mcp.ts:396

Handle MCP tool calls

#### Parameters

##### request

[`MCPRequest`](../interfaces/MCPRequest.md)

#### Returns

`Promise`\<[`MCPResponse`](../interfaces/MCPResponse.md)\>
