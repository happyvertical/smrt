# @happyvertical/smrt-dev-mcp

Development MCP server for the SMRT framework providing code generation and project introspection tools.

## Overview

The SMRT Development MCP Server provides tools for:
1. **Code Generation**: Generate SMRT classes, fields, collections, and validators
2. **Project Introspection**: Scan and analyze SMRT objects in the current project
3. **Structure Analysis**: Understand relationships and patterns in your codebase
4. **AI-Powered Suggestions**: Get improvement recommendations for your SMRT objects

## Installation

```bash
pnpm install @happyvertical/smrt-dev-mcp
```

## Usage

### As an MCP Server

Add to your `.mcp.json`:

```json
{
  "mcpServers": {
    "smrt-dev-mcp": {
      "type": "stdio",
      "command": "pnpm",
      "args": [
        "exec",
        "tsx",
        "/path/to/smrt/packages/smrt-dev-mcp/src/index.ts"
      ],
      "env": {
        "DEBUG": "false"
      },
      "cwd": "/path/to/your/project"
    }
  }
}
```

### Environment Variables

- `DEBUG` - Enable debug logging (default: false)
- AI provider configuration (for suggestions):
  - `HAVE_AI_API_KEY` - Fallback API key
  - `ANTHROPIC_API_KEY` - Anthropic API key
  - `OPENAI_API_KEY` - OpenAI API key

## Available Tools

### Code Generation Tools

1. **`generate-smrt-class`** - Generate a complete SMRT class with `@smrt()` decorator
2. **`generate-field-definitions`** - Generate field definitions with proper imports
3. **`generate-collection`** - Generate a SmrtCollection subclass
4. **`configure-decorators`** - Configure `@smrt()` decorator options
5. **`add-ai-methods`** - Add AI-powered methods (is, do, tool) to a class
6. **`validate-smrt-object`** - Validate class structure and configuration

### Project Introspection Tools

7. **`introspect-project`** - Scan current directory for SMRT objects
8. **`list-project-objects`** - Show SMRT objects with metadata
9. **`get-project-manifest`** - Return full manifest of current project
10. **`analyze-project-structure`** - Understand relationships and patterns
11. **`suggest-improvements`** - AI-powered code quality suggestions

### API Preview Tools

12. **`preview-api-endpoints`** - Preview auto-generated REST API endpoints
13. **`preview-mcp-tools`** - Preview auto-generated MCP tools
14. **`get-object-schema`** - Get schema (fields, types, constraints)
15. **`get-object-config`** - Get `@smrt()` decorator configuration

## Example Usage

### Generate a New SMRT Class

```typescript
// Ask AI: "Generate a SMRT class for Product with name, price, and description"
// The smrt-dev-mcp tool will be called:
{
  "className": "Product",
  "properties": [
    { "name": "name", "type": "text", "required": true },
    { "name": "price", "type": "decimal", "required": true },
    { "name": "description", "type": "text" }
  ],
  "includeApiConfig": true,
  "includeMcpConfig": true,
  "includeCliConfig": true
}
```

### Introspect Current Project

```typescript
// Ask AI: "What SMRT objects exist in this project?"
// The introspect-project tool scans your codebase and returns:
{
  "projectPath": "/path/to/project",
  "objectCount": 5,
  "objects": {
    "Product": { fields: {...}, config: {...} },
    "Customer": { fields: {...}, config: {...} },
    ...
  },
  "relationships": [...],
  "suggestions": [...]
}
```

## License

MIT
