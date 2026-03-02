# @happyvertical/smrt-dev-mcp

Tier 2 MCP server for development — code generation and project introspection.

## Tools

| Tool | Purpose |
|------|---------|
| `generate-smrt-class` | Generates `@smrt()` class with fields, decorator config, imports |
| `introspect-project` | Scans project directory for SMRT objects, returns class/field/relationship report |

## Usage

```json
// .mcp.json or Claude Desktop config
{ "mcpServers": { "smrt-dev-mcp": { "command": "npx", "args": ["-y", "@happyvertical/smrt-dev-mcp"] } } }
```

## MCP Tier Context

- **Tier 1** (Runtime): auto-generated from `@smrt()` objects — live data operations
- **Tier 2** (Development): this package — code generation and project analysis
- **Tier 3** (Docs): `smrt-docs-mcp` — framework documentation access

## Key Files

- `src/index.ts` — MCP server setup, tool registration
- `src/tools/generate.ts` — class generation logic
- `src/tools/introspect.ts` — project scanning (uses scanner package)

## Gotchas

- **Read-only**: never writes files or executes generated code
- **Field type mapping**: `text`, `integer`, `decimal`, `boolean`, `datetime`, `json` — maps to SMRT field helpers (but prefer TypeScript defaults per framework convention)
