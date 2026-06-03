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
| `smrt db:status` | Show pending schema changes and classify failed migration history |
| `smrt db:migrate` | Apply pending migrations |
| `smrt db:diff` | Show schema differences without generating migration files |
| `smrt db:rollback` | Rollback last migration |
| `smrt db:history` | Show migration history with active-vs-superseded failure classification |

File-backed SQL/TypeScript migration generation is not supported. SMRT schema
migrations are manifest-driven; model schema with SMRT objects and apply changes
with `smrt db:migrate`.

### Code Generation

| Command | Description |
|---------|------------|
| `smrt generate:mcp` | Generate MCP server from registered objects |
| `smrt generate:types` | Generate TypeScript declarations from manifest |

### Documentation

| Command | Description |
|---------|------------|
| `smrt docs:agents` | Generate `.agents/smrt-framework.md` for consumer projects |
| `smrt docs:claude` | Deprecated compatibility alias for `.claude/smrt-framework.md` |
| `smrt dev:knowledge-index --format markdown\|json` | Print the deterministic SMRT + SDK knowledge index |
| `smrt dev:knowledge-check --format markdown\|json` | Check agent knowledge freshness |
| `smrt dev:knowledge-diff --format markdown\|json` | Show changed files and affected package experts |
| `smrt knowledge:review-context --scope project\|local\|package\|sdk --package <name> --format markdown\|json` | Build a model-ready domain review prompt bundle |
| `smrt knowledge:architecture-context --scope project\|local\|package\|sdk --package <name> --format markdown\|json` | Build a model-ready domain architecture prompt bundle |

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
| `smrt playground init` | Scaffold package or app playground modules |
| `smrt playground dev` | Run the shared or local playground host |
| `smrt playground list` | List discovered playground entries and modes |

### Playground

| Command | Description |
|---------|------------|
| `smrt playground init` | Scaffold package or app playground files |
| `smrt playground dev` | Run the shared workspace host or local app playground |
| `smrt playground list` | Show discovered playground modules and preview entries |

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

# Scaffold a package playground definition
smrt playground init

# Inspect discovered playground entries
smrt playground list

# Run a custom method on an object
smrt agent:research abc123 --query "AI safety"

# Generate agent context for downstream projects
smrt docs:agents

# Deprecated compatibility alias for Claude Code output
smrt docs:claude

# Check deterministic agent knowledge freshness
smrt dev:knowledge-check --changed --strict --format markdown
smrt dev:knowledge-check --strict --format json

# Build downstream domain context for local/manual model review
smrt knowledge:review-context --scope package --package content --format markdown
smrt knowledge:architecture-context "tenant-aware publishing workflow" --format json

# Inspect discovered package playground modules
smrt playground list
```

## UI Surfaces

The CLI treats UI surfaces as three separate contracts:

- `./svelte` for reusable components
- `./playground` for preview metadata consumed by `smrt playground`
- package-local page shells when a package needs its own dev pages

For this release, packages only need `./svelte` and `./playground` as public UI contracts. Package-local page shells can exist for dev workflows without becoming a published package standard.

See [docs/ui-surfaces.md](../../docs/ui-surfaces.md) for the full convention.

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
