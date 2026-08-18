# @happyvertical/smrt-cli

Developer CLI with lazy-loaded commands, manifest discovery, and class introspection.

## Commands

```
smrt introspect              # Discover SMRT objects in project
smrt doctor                  # Umbrella diagnostics; can verify a generation snapshot
smrt db:status               # Pending schema changes + failed migration classification
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

## `db:migrate` on SQLite: type changes rebuild the table

SQLite has no `ALTER COLUMN ... TYPE`, so a type-bucket change (the common one
being a numeric default edited `0` → `0.0`) is applied as the documented table
rebuild — stage, copy, drop, rename, replay indexes and triggers — planned by
`smrt-core`'s `migrations/sqlite-rebuild.ts` and executed inside the same
atomic batch as everything else. It is no longer a "manual intervention" that
makes `db:migrate` exit 1 on every run (#2370). All drifted columns of one
table are fixed by one rebuild; `--dry-run` prints the whole statement list.

The rebuild refuses — and the column stays manual drift — when another table
declares a foreign key onto the target while `PRAGMA foreign_keys` is ON,
because `DROP TABLE` would fire those children's `ON DELETE` actions. Fix that
one by hand (or against a connection with enforcement disabled).

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
