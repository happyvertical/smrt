# @happyvertical/smrt-cli

Developer CLI for the SMRT framework. Provides introspection, testing, and project management tools for SMRT-based applications.

## Installation

```bash
npm install -D @happyvertical/smrt-cli
```

## Usage

```bash
# Show all available commands
smrt help

# Introspect your SMRT project (auto-discovers manifests)
smrt introspect
smrt introspect --verbose  # Show detailed object information

# Test command (guides you to set up test manifest generation)
smrt test

# List registered SMRT objects
smrt objects

# Show schema for a specific object
smrt schema Product

# Generate MCP server
smrt generate-mcp

# Create a new gnode
smrt gnode create my-town --template=sveltekit
```

## Commands

### Utility Commands

- `smrt introspect` - Auto-discover and analyze SMRT manifests in project and node_modules
  - Scans for: static-manifest.js, manifest.json in project root and packages
  - Shows discovered objects and their sources
  - Use `--verbose` for detailed field information
- `smrt test` - Generate test manifest and run tests
  - Scans src/**/*.test.ts and src/**/*.spec.ts files
  - Generates manifest using ASTScanner and ManifestGenerator
  - Creates JSON and TypeScript stub files
  - Optionally runs vitest after generation
  - Use `--manifest-only` to skip test execution
  - Use `--output <dir>` to customize output location

### Object Management

- `smrt objects` - List all registered SMRT objects
- `smrt schema <object>` - Show detailed schema for an object
- `smrt status` - Show system status (database, AI, registry)

### Code Generation

- `smrt generate-mcp` - Generate MCP server from registered objects
- `smrt generate-types` - Generate TypeScript declarations from manifest

### Object Management (CRUD + Custom Methods)

Auto-generated commands for each registered SMRT object:

**Standard CRUD:**
- `<object>:list` - List objects with filtering and pagination
- `<object>:get <id>` - Get object by ID or slug
- `<object>:create` - Create new object
- `<object>:update <id>` - Update existing object
- `<object>:delete <id>` - Delete object

**Custom Methods (New in v0.6+):**

Custom methods defined on SMRT objects are automatically discovered and exposed as CLI commands!

```typescript
@smrt({
  cli: { include: ['list', 'get', 'research', 'report'] }
})
class Agent extends SmrtObject {
  async research(options: { query: string }) {
    return { results: await this.do(`Research: ${options.query}`) };
  }
}
```

**Auto-generated commands:**
```bash
smrt agent:list
smrt agent:get <id>
smrt agent:research <id> --query "AI safety"  # Custom method!
```

**How it works:**
- All public methods are auto-discovered from manifests
- Method parameters become CLI options (camelCase → kebab-case)
- Include/exclude lists control which methods are exposed
- Results output in JSON format

### Project Scaffolding

- `smrt gnode create <name>` - Create new gnode from template
- `smrt gnode list-templates` - Show available templates

## Features

- **Automatic Discovery**: Scans project and node_modules for SMRT manifests
  - Finds static-manifest.js and manifest.json files
  - Discovers manifests from installed SMRT packages
  - No manual configuration needed
- **Custom Method Discovery** ⭐ NEW: Auto-generates CLI commands from custom methods
  - Discovers all public methods from SMRT objects
  - Maps method parameters to CLI options (kebab-case)
  - Respects include/exclude configuration
  - Works for CLI, API, and MCP generators
- **Introspection**: View discovered objects, their fields, and sources
- **Gnode Scaffolding**: Create new federated knowledge base projects
- **Code Generation**: Generate MCP servers from registered objects
- **Interactive Mode**: Prompts for field values when creating/updating
- **Multiple Formats**: JSON, YAML, and table output formats
- **Safety Features**: Confirmation prompts for destructive operations

## Manifest Discovery

The CLI automatically discovers SMRT objects from manifests in:

1. **Project Root** (checked in this order):
   - `dist/manifest.json` (build artifacts - most common)
   - `dist/static-manifest.js`
   - `static-manifest.js`
   - `manifest.json`
   - `src/manifest/static-manifest.js`
   - `src/manifest/manifest.json`
   - `.smrt/manifest.json`

2. **Installed Packages** (node_modules):
   - Scans packages that depend on @happyvertical/smrt
   - Looks for: dist/manifest.json, dist/static-manifest.js, static-manifest.js, manifest.json

Use `smrt introspect` to see what was discovered.

## Development

```bash
# Build the CLI
npm run build

# Watch mode
npm run dev

# Run locally
npm run cli -- <command>
```

## License

MIT
