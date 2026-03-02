# @happyvertical/smrt-dev-mcp

Development MCP server for the SMRT framework providing code generation and project introspection tools.

## Installation

```bash
pnpm install @happyvertical/smrt-dev-mcp
```

## Usage

Add to your `.mcp.json` or Claude Desktop config:

```json
{
  "mcpServers": {
    "smrt-dev-mcp": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@happyvertical/smrt-dev-mcp"]
    }
  }
}
```

Set `DEBUG=true` in the environment to enable diagnostic logging.

## Available Tools

The server exposes two MCP tools:

### `generate-smrt-class`

Generate a complete SMRT class with `@smrt()` decorator, fields, and imports.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `className` | `string` | Yes | Class name (PascalCase) |
| `properties` | `array` | Yes | Property definitions (`name`, `type`, `required?`, `description?`) |
| `baseClass` | `string` | No | `'SmrtObject'` (default) or `'SmrtCollection'` |
| `includeApiConfig` | `boolean` | No | Include REST API config (default: true) |
| `includeMcpConfig` | `boolean` | No | Include MCP config (default: true) |
| `includeCliConfig` | `boolean` | No | Include CLI config (default: true) |

Supported property types: `text`, `integer`, `decimal`, `boolean`, `datetime`, `json`.

### `introspect-project`

Scan a project directory for SMRT objects and return a class/field/relationship report.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `directory` | `string` | No | Project directory (default: cwd) |
| `includeFields` | `boolean` | No | Include field details |
| `includeRelationships` | `boolean` | No | Analyze relationships |

## MCP Tier Context

- **Tier 1** (Runtime): auto-generated from `@smrt()` objects -- live data operations
- **Tier 2** (Development): this package -- code generation and project analysis
- **Tier 3** (Docs): `smrt-docs-mcp` -- framework documentation access

## Dependencies

- `@modelcontextprotocol/sdk` -- MCP server protocol
- `@happyvertical/smrt-core` -- manifest and object registry

## License

MIT
