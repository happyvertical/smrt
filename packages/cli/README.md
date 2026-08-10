# @happyvertical/smrt-cli

Developer CLI for the s-m-r-t framework. Provides introspection, code generation, database management, and auto-generated CRUD commands for s-m-r-t objects.

## Installation

```bash
pnpm add -D @happyvertical/smrt-cli
```

## Commands

### Introspection

| Command | Description |
|---------|------------|
| `smrt introspect` | Discover s-m-r-t objects in project and node_modules |
| `smrt introspect --verbose` | Include detailed field information |
| `smrt objects` | List all registered s-m-r-t objects |
| `smrt schema <object>` | Show detailed schema for an object |
| `smrt status` | Show system status (database, AI, registry) |

### Database

| Command | Description |
|---------|------------|
| `smrt db:status` | Show pending schema changes and classify failed migration history |
| `smrt db:migrate` | Apply pending migrations |
| `smrt db:migrate --force-migration <exact-id> [--force-migration <exact-id>...]` | Force one or more exact generated migrations in one atomic batch while preserving every other guard |
| `smrt db:migrate-uuid` | Convert schema-declared UUID text columns to native PostgreSQL uuid after data has been remapped |
| `smrt db:diff` | Show schema differences without generating migration files |
| `smrt db:rollback` | Rollback last migration |
| `smrt db:history` | Show migration history with active-vs-superseded failure classification |

File-backed SQL/TypeScript migration generation is not supported. s-m-r-t schema
migrations are manifest-driven; model schema with s-m-r-t objects and apply changes
with `smrt db:migrate`.

Use `--force-migration <exact-id>` for a known checksum, failed, or interrupted
migration that is safe to retry. Repeat the flag to recover multiple verified
IDs in the same atomic invocation:

```bash
smrt db:migrate \
  --force-migration create_table_commissions \
  --force-migration create_table_referral_links
```

Each selector must be one exact generated migration ID. Comma-separated lists,
wildcards, empty values, and combining exact selectors with global `--force`
are rejected, as are IDs absent from the current generated migration batch.
Duplicate exact IDs are normalized to one selection. Unrelated checksum,
failed, and running records remain fail-closed even when the atomic batch
reconciles live schema drift. Global `--force` remains available by itself for
backward compatibility but intentionally overrides guards for the whole pending
batch.

### Audited PostgreSQL timestamp conversion

`timestamp without time zone` values do not carry enough information for s-m-r-t
to infer their original instant. After auditing every historical writer,
database default, trigger, and raw SQL path, an operator may confirm that the
legacy values are UTC wall times and include the exact opt-in:

```bash
smrt db:migrate --postgres-timestamp-legacy-timezone UTC
```

The option has no default and rejects every value other than `UTC`. On
PostgreSQL, `db:migrate` first converts framework-owned `_smrt_*` timestamp
columns before migration-tracker bootstrap, then converts manifest-owned
columns to `timestamptz` with `USING column AT TIME ZONE 'UTC'`. This preserves
the proven UTC instants. It is not safe for a database with any local-time
writer; use an application-owned, provenance-aware migration in that case.
Rehearse against a restored clone and keep a verified backup because type
upgrades have no automatic down migration. `smrt db:diff
--postgres-timestamp-legacy-timezone UTC` previews manifest-owned changes;
`smrt db:migrate --dry-run --postgres-timestamp-legacy-timezone UTC` also
queries and prints the read-only `_smrt_*` conversion plan without initializing
the tracker or writing to the database.

### Code Generation

| Command | Description |
|---------|------------|
| `smrt generate-mcp` | Generate MCP server from registered objects (aliases: `generate-mcp-server`, `mcp`) |
| `smrt generate-types` | Generate TypeScript declarations from manifest (alias: `generate-declarations`) |
| `smrt generate-routes` | Generate SvelteKit API routes (aliases: `routes`, `generate:routes`) |
| `smrt generate-register` | Generate `.smrt/register.js` from discovered packages (aliases: `register`, `generate:register`) |

Generation commands are hyphenated. `generate-routes` and `generate-register`
also answer to a colon alias for backward compatibility; `generate-mcp` and
`generate-types` do not.

`smrt generate-mcp` writes `.smrt/mcp-server/index.js` by default and emits
JavaScript for a `.js` target, so `node .smrt/mcp-server/index.js` runs it
directly. Ask for a `.ts` target to keep the annotated TypeScript for `tsx` or
Node's type stripping:

```bash
smrt generate-mcp --output-path .smrt/mcp-server/index.ts
```

The generated server is always an ES module, so a `.cjs`/`.cts` output path is
rejected. It imports `@modelcontextprotocol/server`, `@happyvertical/smrt-core`,
and `@happyvertical/smrt-config` at runtime (plus `@happyvertical/smrt-jobs` for
task actions and `@happyvertical/smrt-tenancy` for tenant-scoped objects), so
those have to be resolvable from the project you run it in — under pnpm's strict
layout that means declaring them, not relying on the CLI's own dependencies.

### Documentation

| Command | Description |
|---------|------------|
| `smrt docs:agents` | Generate `.agents/smrt-framework.md` for consumer projects |
| `smrt docs:claude` | Deprecated compatibility alias for `.claude/smrt-framework.md` |
| `smrt dev:knowledge-index --format markdown\|json` | Print the deterministic s-m-r-t + SDK knowledge index |
| `smrt dev:knowledge-check --format markdown\|json` | Check agent knowledge freshness |
| `smrt dev:knowledge-diff --format markdown\|json` | Show changed files and affected package experts |
| `smrt knowledge:review-context --scope project\|local\|package\|sdk\|installed --package <name> --format markdown\|json` | Build a model-ready domain review prompt bundle |
| `smrt knowledge:architecture-context --scope project\|local\|package\|sdk\|installed --package <name> --format markdown\|json` | Build a model-ready domain architecture prompt bundle |

### Configuration

| Command | Description |
|---------|------------|
| `smrt config:export` | Export agent config for SSG |
| `smrt export` | Export data in various formats |
| `smrt init` | Initialize a new s-m-r-t project |

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

For each registered s-m-r-t object, the CLI generates:

| Pattern | Description |
|---------|------------|
| `<object>:list` | List objects with filtering and pagination |
| `<object>:get <id>` | Get object by ID or slug |
| `<object>:create` | Create new object (interactive) |
| `<object>:update <id>` | Update existing object |
| `<object>:delete <id>` | Delete object |
| `<object>:<method> <id>` | Custom methods exposed via `cli: { include: [...] }` |

Custom methods on s-m-r-t objects are auto-discovered from manifests. Method parameters become CLI options (camelCase to kebab-case).

## Usage

```bash
# Discover what s-m-r-t objects are available
smrt introspect

# Generate an MCP server
smrt generate-mcp

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

The CLI loads s-m-r-t objects from your project entry point:
1. Explicit `entryPoint` in config
2. `package.json` exports `['.'].import` or `['.']`
3. `package.json` `main` field
4. Fallback: `./dist/index.js`

### Manifest Discovery

The CLI auto-discovers s-m-r-t manifests from:
- **Project root**: `dist/manifest.json`, `dist/static-manifest.js`, `.smrt/manifest.json`, and other standard locations
- **Installed packages**: scans `node_modules/@happyvertical/smrt-*` for manifest files

If compiled classes cannot be loaded, the CLI falls back to manifest-only mode (introspection and code generation work, but CRUD and custom methods do not).

## Dependencies

- `@happyvertical/smrt-core` -- ORM, manifest, code generation
- `@happyvertical/smrt-config` -- configuration loading
- `@happyvertical/smrt-scanner` -- AST scanning for metadata extraction
