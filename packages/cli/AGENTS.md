# @happyvertical/smrt-cli

CLI with lazy-loaded commands, manifest discovery, and class introspection.

## Commands

```
smrt introspect              # Discover SMRT objects in project
smrt doctor                  # Umbrella diagnostics; can verify a generation snapshot
smrt doctor --db             # Add the live-schema parity section (see below)
smrt doctor --ai [--probe]   # Inference tier/alias bindings, offline unless --probe (src/commands/doctor-ai.ts; ../inference/AGENTS.md); unresolvable binding exits 1
smrt db:status               # Pending schema changes + failed migration classification (+ tenant natural-key findings: a missing tenant-led unique exits 1, a surviving legacy global unique warns until `db:migrate --drop-legacy-natural-key`: src/commands/tenant-natural-keys.ts)
smrt db:status --parity      # Same, plus live-schema parity (see below)
smrt db:orphans              # agents/db-orphans.md
smrt users:provision-owner   # Trusted PostgreSQL owner provisioning; password from private file/stdin, never argv/env (users README)
smrt db:migrate              # agents/type-drift.md, agents/db-migrate-concurrency.md
smrt db:migrate --postgres-safe # PostgreSQL concurrent-index mode (see below)
smrt db:migrate --force-migration <exact-id> [--force-migration <exact-id>...] # Force exact generated migrations in one atomic batch
smrt db:migrate --apply-unblocked / --null-orphans # agents/db-migrate-partial-apply.md
smrt db:migrate-uuid         # Convert schema-declared UUID text columns after data remap (incl. PG system tenant ids, #3297)
smrt db:migrate-int8
smrt db:migrate-null-equal-indexes # ../core/agents/null-equal-indexes.md
smrt db:migrate-ledger-accounts [--dry-run] # Move pre-#3098 ledger rows out of `accounts` (smrt-ledgers README)
smrt db:upgrade-commerce-money # agents/commerce-money-upgrade.md
smrt db:migrate-qualified-names [--dry-run] # Opt-in old→current name backfill; doctor --db counts (../core/agents/model-moves.md)
smrt db:materialize-tenant-hierarchy [--dry-run] # smrt-users tenant hierarchy_path backfill (#3036)
smrt db:drop-framework-base-tables # One-time drop of the five #2644-orphaned framework-base tables
smrt db:drop-framework-base-tables --dry-run # Print the drop plan without executing
smrt db:diff                 # Show schema differences without generating migration files
smrt db:rollback             # Roll back migrations by executing their recorded DOWN
smrt db:rollback --mark-only # Record-only flip; schema untouched
smrt db:prune                # Prune framework system tables to their retention windows
smrt db:prune --dry-run      # Same predicates, counted rather than deleted
smrt ai:usage [--by prompt,model,tier,class,tenant,fusion,source] [--since 7d] [--tenant <id>] [--json] # ../core/agents/ai-usage.md
smrt ai:usage --with-transcripts --tenant <id>|--all-tenants [--prompt <key>] [--actor <who>] # Worst-labelled calls with transcripts (#4780; audited read)
smrt ai:transcript <callId> --tenant <id>|--all-tenants [--actor <who>] [--reason] [--json] # One stored transcript (#4780; audited read)
smrt inference:hosted provision|revoke --tenant <id> --user <id> [--budget-usd 20|--budget-micros N] [--window month] [--json] # Hosted gateway keys (#4759, ../inference/AGENTS.md)
smrt inference:hosted disable|enable|status [--tenant <id>] [--json] # Hosted AI kill switch (#4760); one group, shared map: agents/inference-hosted.md
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
smrt cookbook validate|apply # Cookbook check / project create: agents/cookbook-apply.md
smrt kitchen [dir]           # Planner on localhost -> cookbook -> apply: agents/kitchen.md
smrt kitchen apply <url|file> [dir] # cookbook apply, plan URLs too
smrt kitchen mcp             # stdio MCP server for the local Kitchen plugin: agents/kitchen.md
smrt gnode                   # Scaffold gnode site
smrt dispatch:*              # Dispatch management (list/process/retry/cleanup)
smrt app <op>                # App install/setup/start/migrate/worker…: agents/app-commands.md
```

DB target: config `database.url` > `DATABASE_URL` > `:memory:` (README).

File-backed SQL/TypeScript migration generation is not supported. SMRT schema
migrations are manifest-driven through registered objects and project manifests.

`smrt test` is **deprecated** — use vitest plugin directly.

## `db:migrate` on PostgreSQL

New tables are created in deterministic foreign-key dependency order. Mutual
cycles are created without the cyclic clauses first, then receive named
constraints after both tables exist. When a same-package constraint is missing
on an existing table, `db:migrate` probes the exact child/parent columns for
orphans before `ADD ... NOT VALID` and `VALIDATE CONSTRAINT`; orphaned data or a
failed probe stays manual with detector/repair SQL by default
(agents/db-migrate-partial-apply.md).

`db:migrate --dry-run` and deprecated `db:setup --dry-run` print the same
engine-specific dependency plan used for execution, including exact table DDL
and deferred PostgreSQL cycle constraints; cached per-class DDL is not a valid
preview.

`db:migrate` always bounds a PostgreSQL batch with `SET LOCAL lock_timeout` and
`SET LOCAL statement_timeout` inside its transaction, from
`migrations.postgres.lockTimeout` / `.statementTimeout` (defaults `30s` / `60s`;
accepts `ms`/`s`/`min`/`h` suffixes, and `0` disables as PostgreSQL defines it).
A migration queued behind a long-running writer therefore fails fast and rolls
back instead of holding the locks it already took against every writer.

`--postgres-safe` selects **concurrent-index mode**: non-index DDL still commits
in one transaction, then each index statement runs
`CREATE INDEX CONCURRENTLY` / `DROP INDEX CONCURRENTLY` on one pinned session
after that commit. This is the mode for large index rollouts. A same-name
UNIQUE recreate runs build-then-swap (temporary name, drop, `ALTER INDEX …
RENAME`; `swapUniqueIndexRecreates()`), so the table never lacks a unique index.
A `VALIDATE CONSTRAINT` (new or replaced foreign key) and the statements after
it in the same migration also run outside the transaction, in order.

- **Concurrent mode is not atomic.** Committed column/table changes survive a
  later index failure; unfinished index migrations are recorded `failed`, and
  `db:migrate` (which reconciles) retries them on the next run. The retry
  resumes at the index build — their `error_message` carries a
  `[smrt: concurrent-index phase 1 committed]` marker, so the non-index
  statements that already committed are not re-run.
- INVALID-index cleanup, the `useConcurrently: false` veto, and the explicit-`CONCURRENTLY` rejection:
  agents/db-migrate-concurrency.md.

## `doctor`'s agent-surface section (#2591)

`smrt doctor` reports the application's complete agent-addressable surface —
generated model tools, declared view intents, registered playbooks — **from
build artifacts alone**. No route is mounted, no server starts, and no
application module is imported.

`readAgentSurfaceReport(cwd)` reads the first of `.smrt/smrt-knowledge.json`
then `dist/smrt-knowledge.json`. Model tools come from the artifact's `mcp`
surfaces (REST/CLI entries are not agent-addressable tools and are excluded);
intents and playbooks come from its `agentSurface`.

The artifact's `mcp` surfaces come from `configuredSurfaces()` in core, which
derives the projection from the same defaults `MCPGenerator` applies rather
than from the presence of an `mcp` config key (#2619): an omitted config is
full CRUD, not a closed surface, and eligible public custom-method tools are
included using the generator's own exhaustive-include rule.
`renderAgentSurfaceReport(report)` returns the printed lines; both are exported
so the shape is testable without running the command.

**Known live over-exposure (#2624):** the scanner's STI method merge walks the full
inheritance chain, so an STI class's `object.methods` contains its framework base
classes' internal methods (`save`, `toJSON`, `withTransaction`, `destroy`, ...), and
`ObjectRegistry.getAllMethods()` never filters them back out (its ancestor skip
cannot fire: `getInheritanceChain()` stops before adding those ancestors). So
`CLIGenerator`/`MCPGenerator` really register `<object>:save` etc. in a running
app; `configuredSurfaces()` reports a real surface. #2624 tracks the fix.

Sample output:

```text
🤖 Agent Surface

  Source: .smrt/smrt-knowledge.json
  Generated model tools: 2
    - orders_create (Order.create)
    - orders_list (Order.list)
  Declared view intents: 1
    - orders.next_page (read · browser · src/lib/orders.intents.ts)
  Registered playbooks: 1
    - commerce.checkout (2 step(s) · browser · src/lib/checkout.playbooks.ts)
  ✅ 4 agent-addressable operation(s) reported
```

A declaration the scanner recognized but could not read is listed under
`⚠️  Not statically emittable` with the message naming `useWebMcpTool`, and
raises a doctor **warning**, not an issue — a computed tool set is a legitimate
choice, but it must never vanish unremarked.

Reading an artifact validates its shape, not just its JSON: `{}` parses cleanly
and would otherwise render as a healthy zero-operation surface while suppressing
the fallback to a good `dist/` artifact, and `{ "surfaces": {} }` would throw
mid-report and abort the whole doctor run. A malformed candidate is stepped over
so the next one is still tried; with no readable artifact at all the section says
to run a build.

## Live-schema parity (#2368)

PostgreSQL role contracts also surface through read-only `doctor --db` and
`db:validate`. Explicit repair uses `db:permissions` with a reviewed fingerprint;
ordinary migrations never change ACLs. See the
[permission guide](../../docs/content/postgres-permissions.md) for configuration,
authority boundaries, and recovery.

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
- PostgreSQL/DuckDB `int4` columns created before #2373 are advisory warnings,
  not type drift: the differ intentionally treats int4/int8 as equivalent.
  Run `smrt db:migrate-int8 --dry-run`, schedule the reported table rewrites,
  then run `smrt db:migrate-int8`; SQLite is already 64-bit and is a no-op.
  PostgreSQL uses the same bounded `migrations.postgres.lockTimeout` and
  `statementTimeout` settings as ordinary schema migration.

## `db:migrate` on SQLite: type changes rebuild the table

SQLite can enforce generated same-package constraints on new tables, including
cycles, but adding one to an existing table requires an explicit rebuild.
DuckDB reports unsupported constraint shapes or `ALTER ADD CONSTRAINT` as
manual/refused work, never as a successful no-op. Generated same-package
constraints default to `ON UPDATE CASCADE` and retain declared actions.
DuckDB/JSON cannot enforce them, so they report an actionable refusal.

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

## `db:prune` is the retention cron entry point (#2375)

Runs `runRetentionSweep()` from `@happyvertical/smrt-core` over every
framework-owned system table plus every task other installed packages
registered (`_smrt_jobs`/`_smrt_job_events` from `smrt-jobs`, expired
sessions/magic-link tokens/CLI-auth requests from `smrt-users`).

- Defaults are the framework's documented retention windows; `retention` in
  `smrt.config` overrides them persistently, and `--changes-days`,
  `--usage-days`, `--dispatch-days` override them for one run.
- `--skip` takes **task** names, not table names — the same names the report
  and `--json` print, so a package-contributed task is skipped the same way a
  built-in one is.
- `--dry-run` counts with the identical predicates instead of deleting; the
  report says `would prune`.
- The exit code is non-zero when **any** task failed, so a partial sweep never
  looks clean to cron. Individual task failures never abort the others.
- Deployments running a jobs `TaskRunner` already get the same sweep every six
  hours; this command is for those that do not, and for one-off operator runs.

## `ai:usage` reports, it never filters accounting away (#4751)

A thin wrapper over core `reportAiUsage()`; read-only, it never bootstraps
system tables (a pre-1.13.0 database fails with a hint to start the app or run
`db:migrate`). Calls without a prompt key print as `(unattributed)`, uncosted
calls are counted beside the cost total with the cost basis printed, and rows
outside `--tenant` or from external agents are listed as excluded. `--by fusion`
also totals `_smrt_ai_runs` per fusion via `reportAiRuns()` (#4753).

Hosted-gate blocks (`operation: 'blocked'`, #4760) print in a `blocked`
column beside `calls`.

`--with-transcripts` and `ai:transcript` (#4780, `src/commands/ai-transcript.ts`)
read tenant content: they refuse to run without `--tenant` (`global` for
tenant-less rows) or the explicit `--all-tenants`, and every read writes an
audit event naming `--actor` (default `cli:<os user>`) through core's
`listAiTranscripts()`. `db:prune --skip ai-transcripts` skips the 30-day
transcript task.

## `db:drop-framework-base-tables` is a one-time remediation (#2647)

`db:migrate` no longer plans `smrt_objects`/`smrt_classes`/`smrt_collections`/
`smrt_hierarchicals`/`smrt_polymorphic_associations` (#2644), but any
deployment that ran `db:migrate` before that fix still has all five. This
command, backed by `planFrameworkBaseTableDrop()` /
`dropFrameworkBaseTables()` in `@happyvertical/smrt-core/migrations`, drops
exactly those five hardcoded names and nothing else — **never** derived from
`SchemaDiff.orphan_tables`, which would recreate the dangerous global orphan
drop `includeDroppedTables` (default `false`, both call sites explicit —
`differ.ts:450`, `db-diff.ts:210`) deliberately refuses to be.

Execute-or-refuse, per-table shape checks, lock/timeout behavior, `--dry-run`, and the residual risks of
skipping it: agents/db-drop-framework-base-tables.md.

## Architecture

- **Lazy command loading**: commands loaded on-demand via dynamic import (~100ms overhead on first use)
- **Manifest discovery**: finds `.smrt/manifest.json` + scans `node_modules/@happyvertical/smrt-*`
- **Aggregate manifest identity**: preload/schema discovery resolve package ownership per entry (`definition.packageName` before the container), keeping dependency objects' qualified registrations
- **Class loading order**: config.entryPoint → package.json exports['.'] → package.json main → `./dist/index.js`
- **Object method exposure**: custom SMRT object methods auto-become CLI commands

## Key Files

- `src/cli-generator.ts` — core dispatcher, lazy command/class loading
- `src/commands/` — individual command implementations
- `src/loaders/` — class-loader, local-loader, npm-loader, git-loader, template-loader
- `src/discovery/manifest-discovery.ts` — manifest auto-discovery
- `src/commands/docs-claude.ts` — downstream AGENTS.md generation + Claude alias; no object scanning
- `src/commands/docs-knowledge-bundle.ts` — knowledge-bundle half of `docs:agents`
- `src/commands/docs-skills-install.ts` — skill-installation half of `docs:agents` (#4708)

## docs:agents knowledge bundle (consumer contract)

Beside the output file, `docs:agents` writes `smrt-knowledge/` (`.agents/smrt-knowledge/`; `docs:claude` → `.claude/`):
`bundle.json` (`smrt-okf-bundle/1`: `exportedAt` kept while content is unchanged, `packages[{name,version,concept}]`,
`intents`), `components/<unscoped>.md` per installed package shipping `dist/smrt-knowledge.okf.md` with
`package_version` re-stamped from the installed `package.json`, and `intents/*` limited to intents with ≥1 installed
home. `smrt-framework.md` leads with `## Find it by intent` over those same intents. Pages come from the published
artifacts — `scripts/ship-knowledge-pages.mjs` (root `pnpm build`, `prepack-package.js`) copies the committed
`docs/knowledge` pages into `dist/`; intents ship in smrt-cli `dist/knowledge/intents/` — never from a checkout (monorepo
runs fall back to `docs/knowledge`). Links to uninstalled packages' pages dangle by design. The shape lives in
`@happyvertical/smrt-dev-mcp/knowledge` (`okf-bundle.ts`); `dev:knowledge-check` reads it (`stale-okf-bundle`).

Skill install (#4708): unless `--no-install-skills`, `docs:agents` also writes the `smrt-catalog` skill from
`@happyvertical/smrt-dev-mcp` to `.claude/skills/smrt-catalog/SKILL.md` and `.agents/skills/smrt-catalog/SKILL.md`
under the working directory (skipped on `--dry-run`). The copy carries a `<!-- smrt-generated: … smrt-dev-mcp@<version> … -->`
marker after the frontmatter: a rerun replaces a marked copy, a copy without the marker is left alone with a warning.
The shipped text names `.agents/smrt-knowledge/`; the installer substitutes the real bundle dir (`docs:claude`, custom `--output`). Only the smrt repository itself (root `package.json` name `@happyvertical/smrt`, not any pnpm monorepo) also gets `smrt-contribute`; an unmarked copy byte-identical to the shipped skill (the repo's own `.agents/skills/smrt-contribute`) counts as current. Destinations go through `containedPath` and are refused when any path segment is a symlink, before any write.

## Gotchas

- **Test mode detection**: checks `NODE_ENV=test`, `VITEST=true`, `global.it`/`describe` — may conflict with other test runners
- **External package load failures silenced**: one package failing doesn't block others
- **Generation command names are hyphenated**: `generate-mcp` and `generate-types` have
  no colon alias. Only `generate-routes`/`generate-register` declare one, so
  `smrt generate:mcp` is unknown (#2279).
- **Subcommand `--version` beats the global flag**: `parseCliArgs` in
  `@happyvertical/utils` dispatches to the built-in `version` command for a
  `--version` token anywhere in argv. `parseCliCommandArgs` rescopes that token to
  the named subcommand (`smrt generate-mcp --version 0.1.0`) and only leaves it
  global when it appears before or without a subcommand (#2279). `--help` is
  deliberately untouched.
- **Schema history nuance**: `db:status`/`db:history` should distinguish active live drift from superseded failed repairs, not treat every failed row as a current blocker
- **Decorator check follows the Vite major**: doctor requires `oxc.decorator` in
  vite.config on Vite 8+ and accepts tsconfig `experimentalDecorators` only
  below it. The old unconditional tsconfig check flagged correct Vite 8 projects
  and passed broken ones (#2368)
- **Cascade-layer section (#3862)**: `doctor` warns on unlayered universal resets
  (`*`, `html`/`body` margin/padding 0, unlayered reset imports) in `src/**` CSS,
  `.svelte` styles, and root `app.css` when the project depends on smrt-ui or
  smrt-svelte. Scanner: `src/commands/cascade-layers-reset-scan.mjs`
