# @happyvertical/smrt-cli

Developer CLI for the s-m-r-t framework. Provides introspection, code generation, database management, and auto-generated CRUD commands for s-m-r-t objects.

## Installation

```bash
pnpm add -D @happyvertical/smrt-cli
```

For package validation, `pnpm --filter @happyvertical/smrt-cli typecheck`
checks both CLI source and all `src/**/*.test.ts` / `src/**/*.spec.ts` fixtures.
The test project uses the repository's test-only TypeScript settings in
`tsconfig.test.json`; production declarations remain under
`tsconfig.typecheck.json`.

## Commands

### Introspection

| Command | Description |
|---------|------------|
| `smrt introspect` | Discover s-m-r-t objects in project and node_modules |
| `smrt introspect --verbose` | Include detailed field information |
| `smrt objects` | List all registered s-m-r-t objects |
| `smrt schema <object>` | Show detailed schema for an object |
| `smrt status` | Show system status (database, AI, registry) |
| `smrt doctor` | Run the umbrella project-health diagnostics (aliases: `check`, `diagnose`) |

`smrt doctor` reports project-health and integration problems. Noun-scoped
validators such as `smrt db:validate` retain their narrower contracts; do not
use a generic `smrt validate` command as a second project-health entry point.
Artifact consumers must still verify their own inputs and fail closed—running
`doctor` is an observability aid, not a prerequisite for safe loading.

To inspect the same generation-snapshot contract used by the Vite plugins:

```bash
smrt doctor \
  --generation-snapshot .ci/smrt-generation-snapshot.json \
  --generation-snapshot-sha256 "$SMRT_GENERATION_SNAPSHOT_SHA256" \
  --generation-snapshot-provenance "$GITHUB_SHA" \
  --generation-snapshot-source-root "$GITHUB_WORKSPACE"
```

The four snapshot options are atomic: supplying any one requires all four.

### Database

| Command | Description |
|---------|------------|
| `smrt db:status` | Show pending schema changes and classify failed migration history |
| `smrt db:migrate` | Apply pending migrations |
| `smrt db:migrate --force-migration <exact-id> [--force-migration <exact-id>...]` | Force one or more exact generated migrations in one atomic batch while preserving every other guard |
| `smrt db:migrate-uuid` | Convert schema-declared UUID text columns to native PostgreSQL uuid after data has been remapped |
| `smrt db:migrate-int8` | Widen legacy pre-#2373 int4 columns to BIGINT after reviewing the maintenance-window preflight |
| `smrt db:migrate-ledger-accounts [--dry-run]` | Move smrt-ledgers accounts out of the pre-#3098 shared `accounts` table into `ledger_accounts` (PostgreSQL; run between two `db:migrate` passes — see the smrt-ledgers README) |
| `smrt db:migrate-qualified-names [--dry-run] [--tenant <id>] [--force]` | Rewrite stored deprecated qualified names (`@smrt({ previousQualifiedNames })`) to current names. Opt-in, idempotent, tracked in `_smrt_backfills`; `smrt doctor --db` counts what remains (#3338) |
| `smrt db:drop-framework-base-tables` | One-time removal of the five framework-base tables (`smrt_objects`, `smrt_classes`, `smrt_collections`, `smrt_hierarchicals`, `smrt_polymorphic_associations`) orphaned by #2644; refuses if any target table has rows, an unexpected shape, or an inbound foreign key |
| `smrt db:drop-framework-base-tables --dry-run` | Print the drop plan (tables and companion indexes) without executing |
| `smrt db:diff` | Show schema differences without generating migration files |
| `smrt db:rollback` | Roll back the last migration by executing its recorded DOWN script; refuses when no DOWN script exists |
| `smrt db:rollback --mark-only` | Record-only: mark migrations rolled back without running any DOWN script (schema untouched) |
| `smrt db:history` | Show migration history with active-vs-superseded failure classification |
| `smrt db:permissions --dry-run` | Plan the declared PostgreSQL role permission contract |
| `smrt db:permissions --apply --expected-fingerprint <hash>` | Explicitly apply a reviewed permission plan |
| `smrt db:validate` | Validate configured PostgreSQL permissions or JSON database integrity |

For separate migration-owner, runtime, and monitoring roles, see the
[PostgreSQL permissions guide](../../docs/content/postgres-permissions.md).
`doctor --db` includes read-only permission diagnostics when configured.

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

Empty text blocks those conversions too: `''` (or whitespace) is not a
timestamp, JSON document, or integer. When the manifest and live columns are
both nullable, opt in to storing it as NULL:

```bash
smrt db:diff --empty-text-as-null      # preview; notes how many values become NULL
smrt db:migrate --empty-text-as-null
```

It covers `text` -> `timestamptz`, `jsonb` and integer conversions. Any other
value that does not convert still blocks, and NOT NULL columns are never
changed. For `timestamptz` and `jsonb` the diff probes the column first: without
the flag the blocking advisory names the empty-text count. `text` -> integer is
not probed at diff time: the conversion is listed as executable (with the note
"empty-text value(s), if any, become NULL" under the flag), and a value that is
not an integer only fails when `db:migrate` applies it, rolling the batch back.
`db:status` and `db:history` take the same flag, so they assess the same
convergence. Separately, `--postgres-timestamp-legacy-timezone=UTC` converts a
legacy `text` timestamp with `NULLIF(…, '')` / `'null'` → NULL even without
`--empty-text-as-null` (a NOT NULL column still fails at ALTER time).

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

`docs:agents` includes package AGENTS guidance and lists linked module files by
source path; it does not read or embed their bodies. Use
`smrt docs:agents --complete` for a complete authored reference. The deprecated `docs:claude`
alias supports the same flag and retains its historical output path.
Regenerate snapshots after moving the project or updating dependencies so the
local source paths remain current.

Review and architecture prompt bundles include package guidance and modules
matched by file or focus hints. Add `--complete` to either context command to
include every module for the selected packages. These commands still build the
knowledge index; documentation snapshots use lightweight package discovery.

### Configuration

| Command | Description |
|---------|------------|
| `smrt config:export` | Export agent config for SSG |
| `smrt export` | Export data in various formats |
| `smrt init` | Initialize s-m-r-t in an existing SvelteKit project |
| `smrt cookbook validate <file\|url>` | Check a cookbook against cookbook/v1 and the recipe manifests |
| `smrt cookbook apply <file\|url> [dir]` | Create a project from a cookbook and the smrt-start template (`--into`, `--template`, `--dry-run`, `--no-install`) |

`smrt export` reads the `export` section of `smrt.config.js`. A listed type that
is not registered fails the command (non-zero exit, naming the type) instead of
skipping the file. A file listing several types that share one table (STI)
exports the union of their columns (absent columns are NULL; `_meta_type`
distinguishes rows); set `fields: 'common'` on the file to keep only the
columns every type has. A column marked `exported: false` for any listed type is
never emitted for that type's rows, even when another listed type exports it:
the value is NULLed per row from the `_meta_type` discriminator (the export
selects it even when `_meta_type` is not an output column). If a row's type
cannot be matched to a listed type, or an excluding type has no discriminator,
the export fails naming the field and types rather than publishing the column.
`include` whitelists cannot re-enable an `exported: false` field.

`smrt init` updates an existing SvelteKit application's `package.json` with the
direct dependencies its generated source and default MCP server require:
`@happyvertical/smrt-core`, `@happyvertical/smrt-config`, and
`@modelcontextprotocol/server`. It also adds `@happyvertical/smrt-cli` as a
development dependency so the generated project can run `smrt generate-mcp`.
Run the project's package-manager install command after initialization. Existing
versions are preserved; s-m-r-t workspace projects receive `workspace:*` ranges and
consumer projects receive the CLI's published release line.

The generated `src/lib/server/smrt.ts` exports only `runtime` (`classOptions()`
and `getCollection()` over `DATABASE_URL`/`DATABASE_TYPE`), which generated API
routes call per request; it no longer exports the deprecated
`getCollection`/`getSmrtConfig` accessors. To adopt the full application
runtime, replace that object with `createSmrtSvelteKitRuntime()` from
`@happyvertical/smrt-app-runtime/sveltekit` and mount its `handle`/`init`.

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

### Application operations (`smrt app`)

Operational commands for a generated s-m-r-t application, run from the
application root. They replace the template's copied `scripts/*.mjs`, so an
app's `package.json` scripts are one-liners:

```json
{
  "dev": "smrt app dev",
  "build": "smrt app build",
  "preview": "smrt app start",
  "db:migrate": "vite build && smrt app migrate",
  "app:setup": "smrt app setup",
  "app:doctor": "smrt app doctor",
  "worker": "smrt app worker task",
  "worker:schedule": "smrt app worker schedule"
}
```

| Command | Description |
|---------|------------|
| `smrt app install` | Local: setup, start, and open owner onboarding under one operation lock |
| `smrt app setup` | Build, run `smrt db:migrate` explicitly, and prepare the private owner-onboarding handoff |
| `smrt app recover` | Local: rotate the single-use owner onboarding invitation |
| `smrt app start` / `stop` | Local: run the production build on loopback; readiness is proven by app id, process instance, and configuration fingerprint |
| `smrt app doctor` | Secret-free findings (`invalid-runtime-profile`, `unsafe-local-bind`, `runtime-path-unavailable`, `migration-required`, …); exits 1 on any error (default operation) |
| `smrt app open` | Open the app, or the pending onboarding launch file |
| `smrt app backup [destination]` | Local: copy the validated data root to a new private directory outside the checkout |
| `smrt app export [path]` / `import <path>` | Logical, asset-aware bundle; import requires an empty target (deployed: `SMRT_MAINTENANCE_MODE=true`) |
| `smrt app migrate` | Establish local storage custody, then `smrt db:migrate`, under the operation lock |
| `smrt app worker [task\|schedule]` | Deployed: imports `.smrt/runtime/register.js`, then runs the jobs runner until SIGTERM. The kind defaults to `task`; any other value is a usage error before anything starts |
| `smrt app dev\|build\|vite [args]` | Run the app's installed Vite with `.env` loaded (shell wins); `build` validates `./mcp-apps` first |

Success output is JSON on stdout; a failure is one JSON envelope on stderr with
exit code 1 and never contains secret values. The same primitives (operation
lock, writer lease, state root, artifact-path custody, portability) are
importable without side effects from `@happyvertical/smrt-cli/app`. Contract
details: [agents/app-commands.md](agents/app-commands.md).

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

### Database precedence

Every `db:*` command resolves its database once, at startup:

1. `packages.cli.database.url` from any config layer — an explicit project
   setting always wins, so a stray shell `DATABASE_URL` never retargets it.
2. `DATABASE_URL`, with the engine from the config's `database.type`, else
   `DATABASE_TYPE` (`sqlite` | `postgres`), else the URL scheme
   (`postgres://` / `postgresql://` → postgres, anything else sqlite). An
   unsupported `DATABASE_TYPE` disables this step with a warning.
3. The `:memory:` default, which schema commands refuse.

`smrt app setup` and `smrt app migrate` hand `smrt db:migrate` the profile's
database through step 2, so an application does not forward
`DATABASE_URL` in its own config. The rule is smrt-config's
`resolveCliDatabaseConfig()`, which `smrt-dev-mcp` uses too.

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
- `@happyvertical/smrt-app-runtime` -- local storage custody and runtime composition for `smrt app`
- `@happyvertical/smrt-scanner` -- AST scanning for metadata extraction
