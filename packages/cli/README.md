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

## Configuration

The CLI uses [@happyvertical/smrt-config](../config) for configuration management. Configuration is optional - the CLI works with sensible defaults.

### Entry Point Discovery

The CLI automatically discovers your SMRT objects by loading your project's entry point:

1. **Explicit configuration** in `smrt.config.js`:
   ```javascript
   export default {
     packages: {
       cli: {
         entryPoint: './dist/index.js'
       }
     }
   };
   ```

2. **Auto-detection from package.json** (if not configured):
   - Checks `exports['.'].import` or `exports['.']`
   - Falls back to `main` field
   - Final fallback: `./dist/index.js`

### Database Configuration

Configure database connection for CLI operations (list, get, create, update, delete, db:setup):

```javascript
// smrt.config.js
export default {
  packages: {
    cli: {
      database: {
        type: 'sqlite',           // or 'postgres'
        url: './my-project.db'    // default: ':memory:'
      }
    }
  }
};
```

**Default behavior:**
- Uses in-memory SQLite (`:memory:`) if no database is configured
- Data is not persisted between CLI invocations with default settings
- **Note**: `smrt db:setup` requires an explicit file-based database URL (cannot use `:memory:`)

### All Configuration Options

```javascript
// smrt.config.js
export default {
  packages: {
    cli: {
      // Entry point to load SMRT classes from
      // Default: auto-detect from package.json
      entryPoint: './dist/index.js',

      // Database configuration
      database: {
        type: 'sqlite',          // 'sqlite' | 'postgres'
        url: './data.db'         // default: ':memory:'
      },

      // Enable verbose output for debugging
      // Default: false
      verbose: true,

      // Default output format
      // Default: 'table'
      format: 'table',            // 'table' | 'json' | 'yaml' | 'plain'

      // Command timeout in milliseconds
      // Default: 30000 (30 seconds)
      timeout: 60000,

      // Enable colored output
      // Default: true (auto-detected from TTY)
      colors: true,

      // Enable interactive prompts
      // Default: true (false in CI environments)
      interactive: true
    }
  }
};
```

### Manifest-Only Mode

If the CLI cannot load your compiled classes (e.g., due to bundling issues), it falls back to **manifest-only mode**:

- ✅ Object discovery and introspection work
- ✅ Schema inspection works
- ✅ Code generation works (MCP, types)
- ❌ CRUD operations (list, get, create, update, delete) don't work
- ❌ Custom method invocation doesn't work

To resolve, ensure:
1. Your project has a valid `dist/index.js` (or configured entry point)
2. The entry point imports all SMRT objects (triggers `@smrt()` decorators)
3. Your build doesn't mangle required dependencies (check vite externals)

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
- `smrt db:setup` - Initialize database schema for all registered SMRT objects
  - Reads database configuration from `smrt.config.js`
  - Auto-discovers SMRT objects and generates schema
  - Respects initialization order (foreign key dependencies)
  - Handles STI (Single Table Inheritance) hierarchies
  - Use `--dry-run` to preview SQL without executing
  - Use `--drop` to drop existing tables before creating (⚠️ destructive, prompts for confirmation)
  - Use `--verbose` for detailed output
  - **Note**: Requires explicit database configuration (cannot use `:memory:` for db:setup)

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

### Git Integration

The CLI includes a JSON-aware git merge driver to prevent conflicts when multiple workflows modify the same JSON data files (e.g., `events.json`, `places.json`).

**Setup:**
```bash
# Configure the merge driver for your repository
smrt git:init

# Or with custom patterns
smrt git:init --patterns "data/*.json,*.data.json"

# Configure globally (for all repositories)
smrt git:init --global
```

**What it does:**
1. Configures a git merge driver named `smrt-json`
2. Updates `.gitattributes` to use this driver for JSON data files
3. When git encounters a merge conflict in matching files, it:
   - Parses all versions as JSON
   - Merges arrays by `id` field (union, deduplicated)
   - Resolves conflicts using `updated_at` timestamp (newer wins)
   - Preserves `_meta_type` for STI support
   - Maintains consistent ordering by `created_at`

**Commands:**
- `smrt git:init` - Configure the merge driver
  - `--patterns <patterns>` - Comma-separated file patterns (default: `data/*.json`)
  - `--global` - Configure globally instead of per-repository
  - `--force` - Overwrite existing configuration
- `smrt merge-json <base> <ours> <theirs>` - Manual merge (called by git automatically)
  - `--dry-run` - Preview merge result without modifying files
  - `--verbose` - Show detailed merge information

**Example scenario:**
```
# Two concurrent workflows modify events.json:

# Weather workflow adds:
{ id: "weather-1", name: "Forecast", ... }

# Meeting workflow adds:
{ id: "meeting-1", name: "Council Meeting", ... }

# After merge, events.json contains both:
[
  { id: "weather-1", name: "Forecast" },
  { id: "meeting-1", name: "Council Meeting" }
]
```

**Team setup:**
1. One developer runs `smrt git:init` and commits `.gitattributes`
2. Other team members run `smrt git:init` once to configure their local git

### Project Scaffolding

- `smrt gnode create <name>` - Create new gnode from template
- `smrt gnode list-templates` - Show available templates

## Features

- **Automatic Discovery**: Scans project and node_modules for SMRT manifests
  - Finds static-manifest.js and manifest.json files
  - Discovers manifests from installed SMRT packages
  - No manual configuration needed
- **Custom Method Discovery**: Auto-generates CLI commands from custom methods
  - Discovers all public methods from SMRT objects
  - Maps method parameters to CLI options (kebab-case)
  - Respects include/exclude configuration
  - Works for CLI, API, and MCP generators
- **Git Merge Driver** ⭐ NEW: JSON-aware merge driver for data files
  - Prevents conflicts when multiple workflows modify JSON files
  - Merges arrays by ID with automatic deduplication
  - Resolves conflicts using timestamps (newer wins)
  - Preserves STI `_meta_type` fields
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
