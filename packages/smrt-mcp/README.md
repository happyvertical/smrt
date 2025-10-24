# @happyvertical/smrt-mcp

MCP server for the SMRT framework that acts as an orchestrator, routing developer queries to appropriate package experts using CLAUDE.md files.

## Overview

The SMRT MCP Server implements a RAG (Retrieval-Augmented Generation) pattern where each SMRT package's CLAUDE.md file serves as domain expertise. When you ask a question, the server:

1. Routes your query to relevant packages based on keyword matching
2. Loads the CLAUDE.md documentation for those packages
3. Uses AI to synthesize a response based on the expert documentation
4. Returns an answer with package references

## Installation

```bash
pnpm install @happyvertical/smrt-mcp
```

## Usage

### As an MCP Server

Add to your `.mcp.json` (see Configuration section below):

```json
{
  "mcpServers": {
    "smrt-advisor": {
      "type": "stdio",
      "command": "pnpm",
      "args": [
        "exec",
        "tsx",
        "/path/to/smrt/packages/smrt-mcp/src/index.ts"
      ],
      "env": {
        "DEBUG": "false"
      },
      "cwd": "/path/to/smrt"
    }
  }
}
```

### Environment Variables

The `ask` tool requires an AI provider to be configured. Set one of:

- `HAVE_AI_API_KEY` - Fallback API key for any provider
- `HAVE_AI_TYPE` - Provider type ('openai', 'anthropic', 'gemini')
- `OPENAI_API_KEY` - OpenAI API key
- `ANTHROPIC_API_KEY` - Anthropic API key
- `GEMINI_API_KEY` - Google Gemini API key

Other tools (`list-packages`, `get-docs`) work without AI configuration.

## Available Tools

### ask

Ask a question about the SMRT framework. Automatically routes to relevant packages and synthesizes a response.

**Input:**
```typescript
{
  "query": "How do I create a collection with custom actions?",
  "packages": ["core", "products"]  // Optional: specify packages explicitly
}
```

**Example:**
```
Query: "How do I create a collection with custom actions?"

Response:
To create a collection with custom actions in the SMRT framework, you extend SmrtCollection and use the @smrt() decorator to configure which actions are exposed...

---
*Consulted packages: @happyvertical/smrt-core, @happyvertical/smrt-products*
```

### list-packages

List all available SMRT framework packages with descriptions and keywords.

**Input:**
```typescript
{
  // No parameters required
}
```

**Example Output:**
```
# SMRT Framework Packages (13 total)

### @happyvertical/smrt-core
Core framework with ORM, code generation, and AI integration

**Keywords**: smrt, framework, orm, database, collection, object...

---

### @happyvertical/smrt-agents
Agent framework for autonomous actors

**Keywords**: agent, autonomous, actor, workflow...
```

### get-docs

Get the full CLAUDE.md documentation for a specific package.

**Input:**
```typescript
{
  "packageName": "core"
}
```

**Example:**
```
# @happyvertical/smrt-core

## Purpose and Responsibilities

The `@happyvertical/smrt-core` package is the core framework...
```

## How It Works

### Package Registry

The registry scans `packages/*/CLAUDE.md` files at startup and builds a catalog of available packages with:
- Package name
- Description (extracted from CLAUDE.md)
- Keywords for routing
- Full documentation content

### Query Routing

When you ask a question, the router:
1. Extracts keywords from your query
2. Matches against package keyword lists
3. Scores packages by relevance
4. Returns top matches

### AI Synthesis

The `ask` tool:
1. Loads CLAUDE.md for relevant packages (top 3 matches)
2. Builds context from documentation
3. Uses AI (via `@happyvertical/ai`) to generate response
4. Includes package references in response

## Package Keywords

Each package has associated keywords for routing. Examples:

- **core**: smrt, framework, orm, database, collection, object, decorator, schema, api, rest, cli, mcp
- **agents**: agent, autonomous, actor, workflow, orchestration, task
- **content**: content, article, markdown, cms, document, blog, publishing
- **events**: event, calendar, meeting, schedule, attendance, rsvp
- **gnode**: federation, network, knowledge base, distributed, peer

See `src/registry.ts` for the complete mapping.

## Development

```bash
# Build the package
pnpm run build

# Run tests
pnpm test

# Watch mode
pnpm run dev
```

## Configuration

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "smrt-advisor": {
      "command": "pnpm",
      "args": [
        "exec",
        "tsx",
        "/Users/you/path/to/smrt/packages/smrt-mcp/src/index.ts"
      ],
      "env": {
        "ANTHROPIC_API_KEY": "your-key-here"
      }
    }
  }
}
```

### Claude Code

Add to project root `.mcp.json`:

```json
{
  "mcpServers": {
    "smrt-advisor": {
      "type": "stdio",
      "command": "pnpm",
      "args": [
        "exec",
        "tsx",
        "/Users/you/path/to/smrt/packages/smrt-mcp/src/index.ts"
      ],
      "env": {
        "DEBUG": "false",
        "ANTHROPIC_API_KEY": "your-key-here"
      },
      "cwd": "/Users/you/path/to/smrt"
    }
  }
}
```

## Adding New Packages

When you add a new package to the SMRT framework:

1. Create a `CLAUDE.md` file documenting the package
2. Update `src/registry.ts` to add keywords for the new package
3. Rebuild: `pnpm run build`

The package will be automatically discovered and included in the registry.

## Architecture

```
Developer Query → MCP Server (Orchestrator)
                      ↓
    ┌─────────────────┼─────────────────┐
    ↓                 ↓                 ↓
Package Expert    Package Expert    Package Expert
(@happyvertical/smrt-core)  (@happyvertical/smrt-agents)  (@happyvertical/smrt-content)
CLAUDE.md         CLAUDE.md         CLAUDE.md
    ↓                 ↓                 ↓
    └─────────────────┴─────────────────┘
                      ↓
            Synthesized Response
```

## Troubleshooting

### "AI client initialization failed"

The `ask` tool requires an AI provider. Set one of the environment variables listed above.

### "No relevant packages found"

Try using `list-packages` to see available packages, or specify packages explicitly with the `packages` parameter.

### "Package not found"

Use `list-packages` to see the exact package names. Package names should not include the `@happyvertical/smrt-` prefix (use "core" not "smrt-core").

## License

MIT

## Related

- [SMRT Framework](https://github.com/happyvertical/smrt)
- [Model Context Protocol](https://modelcontextprotocol.io/)
- [SDK MCP Server](https://github.com/happyvertical/sdk/tree/main/packages/sdk-mcp) - Similar implementation for the SDK
