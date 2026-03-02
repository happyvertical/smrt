# @happyvertical/smrt-cli

Developer CLI for the SMRT framework. Provides introspection, code generation, database management, and auto-generated CRUD commands for SMRT objects.

## Installation

```bash
pnpm add -D @happyvertical/smrt-cli
```

## Commands

### Introspection

| Command | Description |
|---------|------------|
| `smrt introspect` | Discover SMRT objects in project and node_modules |
| `smrt introspect --verbose` | Include detailed field information |
| `smrt objects` | List all registered SMRT objects |
| `smrt schema <object>` | Show detailed schema for an object |
| `smrt status` | Show system status (database, AI, registry) |

### Database

| Command | Description |
|---------|------------|
| `smrt db:status` | Show pending schema changes |
| `smrt db:migrate` | Apply pending migrations |
| `smrt db:diff --generate` | Generate migration from schema changes |
| `smrt db:rollback` | Rollback last migration |
| `smrt db:history` | Show migration history |

### Code Generation

| Command | Description |
|---------|------------|
| `smrt generate:mcp` | Generate MCP server from registered objects |
| `smrt generate:types` | Generate TypeScript declarations from manifest |

### Documentation

| Command | Description |
|---------|------------|
| `smrt docs:claude` | Generate `.claude/smrt-framework.md` for consumer projects |

### Configuration

| Command | Description |
|---------|------------|
| `smrt config:export` | Export agent config for SSG |
| `smrt export` | Export data in various formats |
| `smrt init` | Initialize a new SMRT project |

### Dispatch

| Command | Description |
|---------|------------|
| `smrt dispatch:list` | List dispatch messages |
| `smrt dispatch:process` | Process pending dispatches |
| `smrt dispatch:retry` | Retry failed dispatches |
| `smrt dispatch:cleanup` | Clean up old dispatch records |

### Git Integration

| Command | Description |
|---------|------------|
| `smrt git:init` | Configure JSON-aware merge driver for data files |
| `smrt merge-json <base> <ours> <theirs>` | Manual JSON merge (called by git automatically) |

### Scaffolding

| Command | Description |
|---------|------------|
| `smrt gnode create <name>` | Create new gnode from template |
| `smrt gnode list-templates` | Show available templates |

### Auto-Generated Object Commands

For each registered SMRT object, the CLI generates:

| Pattern | Description |
|---------|------------|
| `<object>:list` | List objects with filtering and pagination |
| `<object>:get <id>` | Get object by ID or slug |
| `<object>:create` | Create new object (interactive) |
| `<object>:update <id>` | Update existing object |
| `<object>:delete <id>` | Delete object |
| `<object>:<method> <id>` | Custom methods exposed via `cli: { include: [...] }` |

Custom methods on SMRT objects are auto-discovered from manifests. Method parameters become CLI options (camelCase to kebab-case).

## Usage

```bash
# Discover what SMRT objects are available
smrt introspect

# Generate an MCP server
smrt generate:mcp

# Run a custom method on an object
smrt agent:research abc123 --query "AI safety"

# Generate CLAUDE.md for downstream projects
smrt docs:claude
```

## Configuration

The CLI uses `@happyvertical/smrt-config` (cosmiconfig). Configuration is optional -- sensible defaults apply.

```javascript
// smrt.config.js
export default {
  packages: {
    cli: {
      entryPoint: './dist/index.js',  // default: auto-detect from package.json
      database: {
        type: 'sqlite',               // 'sqlite' | 'postgres'
        url: './data.db'              // default: ':memory:'
      },
      format: 'table',                // 'table' | 'json' | 'yaml' | 'plain'
    }
  }
};
```

### Entry Point Discovery

The CLI loads SMRT objects from your project entry point:
1. Explicit `entryPoint` in config
2. `package.json` exports `['.'].import` or `['.']`
3. `package.json` `main` field
4. Fallback: `./dist/index.js`

### Manifest Discovery

The CLI auto-discovers SMRT manifests from:
- **Project root**: `dist/manifest.json`, `dist/static-manifest.js`, `.smrt/manifest.json`, and other standard locations
- **Installed packages**: scans `node_modules/@happyvertical/smrt-*` for manifest files

If compiled classes cannot be loaded, the CLI falls back to manifest-only mode (introspection and code generation work, but CRUD and custom methods do not).

## Dependencies

- `@happyvertical/smrt-core` -- ORM, manifest, code generation
- `@happyvertical/smrt-config` -- configuration loading
- `@happyvertical/smrt-scanner` -- AST scanning for metadata extraction
