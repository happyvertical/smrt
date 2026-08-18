# @happyvertical/smrt-cli

Developer CLI with lazy-loaded commands, manifest discovery, and class introspection.

## Commands

```
smrt introspect              # Discover SMRT objects in project
smrt doctor                  # Umbrella diagnostics; can verify a generation snapshot
smrt doctor --db             # Add the live-schema parity section (see below)
smrt db:status               # Pending schema changes + failed migration classification
smrt db:status --parity      # Same, plus live-schema parity (see below)
smrt db:migrate              # Apply migrations
smrt db:migrate --postgres-safe # PostgreSQL concurrent-index mode (see below)
smrt db:migrate --force-migration <exact-id> [--force-migration <exact-id>...] # Force exact generated migrations in one atomic batch
smrt db:migrate-uuid         # Convert schema-declared UUID text columns after data remap
smrt db:diff                 # Show schema differences without generating migration files
smrt db:rollback             # Roll back migrations by executing their recorded DOWN
smrt db:rollback --mark-only # Record-only flip; schema deliberately untouched
smrt docs:agents             # Generate .agents/smrt-framework.md
smrt docs:claude             # Deprecated alias writing .claude/smrt-framework.md
smrt dev:knowledge-*         # Deterministic agent knowledge index/check/diff
smrt dev:knowledge-index --scope installed # Installed @happyvertical/* deps, versions, AGENTS.md hashes
smrt knowledge:review-context --scope package --package <name>
smrt knowledge:architecture-context --scope project|local|package|sdk|installed
smrt dev:knowledge-check --format markdown|json
smrt generate-mcp            # Generate MCP server (aliases: generate-mcp-server, mcp)
smrt generate-types          # Generate TypeScript declarations (alias: generate-declarations)
smrt generate-routes         # Generate SvelteKit API routes (aliases: routes, generate:routes)
smrt config:export           # Export agent config for SSG
smrt init                    # Init new project
smrt gnode                   # Scaffold gnode site
smrt dispatch:*              # Dispatch management (list/process/retry/cleanup)
```

File-backed SQL/TypeScript migration generation is not supported. SMRT schema
migrations are manifest-driven through registered objects and project manifests.

`smrt test` is **deprecated** — use vitest plugin directly.

## `db:migrate` on PostgreSQL

`db:migrate` always bounds a PostgreSQL batch with `SET LOCAL lock_timeout` and
`SET LOCAL statement_timeout` inside its transaction, from
`migrations.postgres.lockTimeout` / `.statementTimeout` (defaults `30s` / `60s`;
accepts `ms`/`s`/`min`/`h` suffixes, and `0` disables as PostgreSQL defines it).
A migration queued behind a long-running writer therefore fails fast and rolls
back instead of holding the locks it already took against every writer.

`--postgres-safe` selects **concurrent-index mode**: non-index DDL still commits
in one transaction, then each index statement runs
`CREATE INDEX CONCURRENTLY` / `DROP INDEX CONCURRENTLY` on one pinned session
after that commit. This is the mode for large index rollouts.

- **Concurrent mode is not atomic.** Committed column/table changes survive a
  later index failure; unfinished index migrations are recorded `failed`, and
  `db:migrate` (which reconciles) retries them on the next run. The retry
  resumes at the index build — their `error_message` carries a
  `[smrt: concurrent-index phase 1 committed]` marker, so the non-index
  statements that already committed are not re-run.
- INVALID indexes — the stump a cancelled or timed-out
  `CREATE INDEX CONCURRENTLY` leaves, which `pg_indexes` still reports as
  present — are detected via `pg_index.indisvalid` and dropped before the
  rebuild.
- `migrations.postgres.useConcurrently: false` vetoes the flag; index DDL then
  runs inside the atomic transaction (still bounded by the timeouts).
- Without the flag, a batch containing explicit `CONCURRENTLY` DDL is rejected
  before the transaction opens — PostgreSQL cannot run it there.

## Live-schema parity (#2368)

`doctor --db` and `db:status --parity` share `src/commands/db-parity.ts`, which
runs core's `checkLiveSchemaParity()`. This answers a different question than
`db:status`/`db:diff`: those compare the live database to the **manifest**, i.e.
to the artifact that dropped the index in the first place, which is why a
database missing 164 tenant-column indexes reported "in sync" (#2356).

Expected shape comes from the manifest schemas, the hand-DDL `_smrt_*` system
tables (parsed by core's `system-table-shapes.ts` — they are in no manifest and
enter no diff), and an index policy that consults no manifest at all: every
foreign-key/cross-package-ref/tenant column leads an index, every registry
conflict target has a matching UNIQUE index, every `unique: true` column is
unique live. Conflict targets come from `ObjectRegistry.getConflictColumns()`,
not from the schema definition.

- Severity is the contract: `error` fails the command (missing table/column,
  type drift, orphan NOT NULL, conflict target unindexed or non-unique,
  PostgreSQL INVALID index), `warning` does not (index coverage), `info` is
  hidden without `--verbose` (undeclared tables/columns/indexes).
- Both surfaces **fail closed**: an unreachable database, or an adapter with no
  `getTableSchema`, is an error, never a silent pass. Where index metadata
  cannot be read at all, index checks are skipped and the report says so
  (`indexIntrospection: 'unavailable'`) rather than inventing missing indexes.
- The check is read-only and lives in a new core module; it does not share code
  with `migrations/differ.ts`.

## `db:rollback` is execute-or-refuse

Schema state is diff-driven: `db:migrate` derives every migration from the
manifest at run time and stores **no SQL** in `_smrt_schema_migrations`. So
`db:rollback` can only honour the one DOWN script that is reconstructible from
a tracking row — `create_table_<table>` → `DROP TABLE IF EXISTS "<table>"`,
the exact statement `db:migrate` records for `diff.added_tables`.

- Rows with a reconstructible DOWN are **executed** through
  `MigrationTracker.rollback` (transactional), then marked `rolled_back`.
- Anything else is **refused**: non-zero exit, an error naming each migration
  and why, and no row touched. Refusal is all-or-nothing across the selected
  set — a partial revert would leave the chain in a state the remaining DOWN
  scripts were not written against. This includes rows recorded
  `is_reversible` under a caller-chosen name: reversible at apply time, but the
  SQL was never persisted, so it cannot be replayed (#2378).
- `--mark-only` is the explicit opt-in for the record-only flip (for an
  operator who already reverted the schema by hand). It says in its own output
  that the schema was not changed, and it is the only path that moves a row
  without running DDL.
- A failed DOWN stops the batch; the migrations behind it are reported
  `Not attempted` and left `completed`.
- `--dry-run` previews the DOWN statements and still exits non-zero when the
  real run would refuse. Both `--dry-run` and `--mark-only` are declared
  kebab-cased, so handlers must read `options['dry-run']` / `options['mark-only']`
  (`parseCliArgs` returns keys verbatim — the #1385 data-loss class).

Reverting a non-`create_table` change is a forward operation: update the
`@smrt` object definitions and run `db:migrate` again.

## Architecture

- **Lazy command loading**: commands loaded on-demand via dynamic import (~100ms overhead on first use)
- **Manifest discovery**: auto-finds `.smrt/manifest.json` + scans `node_modules/@happyvertical/smrt-*`
- **Aggregate manifest identity**: preload and schema discovery resolve package ownership per entry (`definition.packageName` before the container), so dependency objects retain their qualified registrations
- **Class loading order**: config.entryPoint → package.json exports['.'] → package.json main → `./dist/index.js`
- **Object method exposure**: custom methods on SMRT objects auto-become CLI commands

## Key Files

- `src/cli-generator.ts` — core dispatcher, lazy command loading, class loading
- `src/commands/` — individual command implementations
- `src/loaders/` — class-loader, local-loader, npm-loader, git-loader, template-loader
- `src/discovery/manifest-discovery.ts` — manifest auto-discovery
- `src/commands/docs-claude.ts` — downstream AGENTS.md generation plus Claude compatibility alias

## Gotchas

- **Test mode detection**: checks `NODE_ENV=test`, `VITEST=true`, `global.it`/`describe` — could conflict with other test runners
- **External package load failures silenced**: one package failing doesn't prevent others from loading
- **Generation command names are hyphenated**: `generate-mcp` and `generate-types` have
  no colon alias. Only `generate-routes` and `generate-register` declare one, so
  `smrt generate:mcp` is an unknown command (#2279).
- **Subcommand `--version` beats the global flag**: `parseCliArgs` in
  `@happyvertical/utils` dispatches to the built-in `version` command for a
  `--version` token anywhere in argv. `parseCliCommandArgs` rescopes that token to
  the named subcommand (`smrt generate-mcp --version 0.1.0`) and only leaves it
  global when it appears before or without a subcommand (#2279). `--help` is
  deliberately untouched.
- **Schema history nuance**: `db:status` / `db:history` should distinguish active live drift from superseded failed generated schema repairs instead of treating all failed rows as current blockers
- **Decorator check follows the Vite major**: doctor requires `oxc.decorator` in
  vite.config on Vite 8+ and accepts tsconfig `experimentalDecorators` only
  below it. The old unconditional tsconfig check flagged correct Vite 8 projects
  and passed broken ones (#2368)
