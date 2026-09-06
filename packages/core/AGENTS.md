# @happyvertical/smrt-core

Foundation ORM, registry, schema/code generation, AI integration, and DispatchBus.
Read the module for the subsystem being edited; root AGENTS covers shared model
and repository rules.

## Modules

| Source | Scope | Module doc |
|---|---|---|
| `src/object.ts`, `src/collection.ts`, `src/child-accessors.ts` | Lifecycle, hydration, operators, STI, child accessors, dispatch | [agents/object-runtime.md](agents/object-runtime.md) |
| `src/revision-guard.ts` | Guarded writes and PostgreSQL revision precision | [agents/revision-guard.md](agents/revision-guard.md) |
| `src/collection.ts` | Projections, latest-related, facets, counts, read plans | [agents/collection-reads.md](agents/collection-reads.md) |
| `src/collection.ts` | Limits, sort whitelist, generated list order | [agents/query-bounds.md](agents/query-bounds.md) |
| `src/data-query.ts` | Transport-neutral bounded query normalization | [agents/data-query.md](agents/data-query.md) |
| `src/schema/`, `src/migrations/`, `src/cascade.ts`, `src/system/` | DDL parity, indexes, migrations, delete integrity, retention | [agents/schema-paths.md](agents/schema-paths.md) |
| `src/postgres-permissions.ts` | Explicit PostgreSQL ACL plans and atomic reconciliation | [deployment permission contract](../../docs/content/postgres-permissions.md) |
| `src/change-feed.ts` | Durable changes, cursors, table versions, retention | [agents/change-feed.md](agents/change-feed.md) |
| `src/change-signals.ts` | Signal bus, replica fan-out, SSE | [agents/change-signals.md](agents/change-signals.md) |
| `src/generators/`, `src/vite-plugin/web-collections.ts` | REST/CLI/MCP generation, manifest hashes, ETags | [agents/generators.md](agents/generators.md) |
| `src/vite-plugin/`, `src/consumer-plugin/`, `src/knowledge.ts` | Decorator UI hints, knowledge projection, generation snapshots | [agents/build-knowledge.md](agents/build-knowledge.md) |
| `src/object.ts`, `src/collection.ts`, `src/learning/memory.ts` | Context memory and semantic search | [agents/memory.md](agents/memory.md) |

## Cross-module invariants

- `ObjectRegistry` is a `globalThis` singleton so registration survives HMR.

- Production DDL uses manifest generators; `getTestDatabase()` uses registry
  generators. Keep columns, indexes, FK actions, and runtime conflict targets in
  parity (`src/schema/schema-path-parity.test.ts`). Every new query predicate
  needs its index or an explicit reason none is needed.
- Tenant scoping covers every read and every unique/conflict key. Explicit
  conflict columns are not rewritten; their author must include tenant scope.
- Persisted saves use `id` and loaded `updated_at`; new saves use natural keys.
  Preserve revision compare-and-swap ordering through public `save()`,
  `claimRevision()`, and transaction APIs. Embedded saves, deletes, and complete
  `withTransaction()` callbacks share a process-local write queue.
- Collection model hydration is serial in result order: initialization may query
  the same transaction-bound PostgreSQL client. Use projections for plain rows.
- Native DuckDB UUIDs must be cast coherently on read before identity reuse;
  custom embedded revision paths use `getCanonicalPersistedRow()`. Never replay
  a mutation to discover result types.
- `withDatabase(db, callback)` restores only database bindings (including public
  `options.db`); `withTransaction(callback)` also restores identity/revision
  metadata after rollback. Do not use a bound instance concurrently.
- `ensureSystemTables(db, typeHint?)` provisions framework tables idempotently;
  call it on a base PostgreSQL connection before caller-owned transactions.
  Bootstrap uses an advisory lock. Application tables still require migrations;
  runtime table verification checks existence only.
- Manifest generation fails closed on scanner errors, including unresolved
  decorator spreads. Never emit partial, default-open registration.
- Generated registration repairs bundled class identity using the exact imported
  constructor, explicit package, and isolated one-object manifest. Never infer
  ownership from paths, simple names, or table names; packages can share names.
  Consumer regression gate: `packages/bundle-gate/src/__tests__/registry-identity.spec.ts`.

## Gotchas

- Optional filesystem support stays lazy: use `createFilesystemAdapter()` in
  `src/filesystem-loader.ts`, not a static files-SDK import. Fully bundled apps
  import `@happyvertical/smrt-core/filesystem` at startup. Use
  `importOptionalDependency()` for similarly heavy optional dependencies.
- Database retries are transient-only, four attempts total for `get`/`upsert`.
  Use `src/db-errors.ts` classifiers through the cause chain, never message
  matching (SDK driver text can live in `context.originalError`). Constraints,
  bad input, missing tables, and aborted PostgreSQL transactions fail immediately.
  Unique/PK violations become `VALIDATION_UNIQUE_CONSTRAINT`, NOT NULL becomes
  `VALIDATION_REQUIRED_FIELD`; other failures keep the driver error as `cause`.
- Property initializers precede option values; options win. Arrays/objects are
  shallow-cloned. Collection creation caches fields; table verification caches
  by DB URL and table. Preserve these scopes when changing initialization.
- The Vite plugin loads scanner/schema code from `dist/` when present. Rebuild
  core after editing those sources before testing consumer manifest generation.
  Vite 8 requires `oxc.decorator: { legacy: true, emitDecoratorMetadata: true }`.

## Validation

Run focused tests first, then applicable package checks:

```bash
pnpm --filter @happyvertical/smrt-core test
pnpm --filter @happyvertical/smrt-core typecheck
pnpm --filter @happyvertical/smrt-core build
pnpm --filter @happyvertical/smrt-core test:postgres
pnpm check:agents-chain
pnpm smrt dev:knowledge-check
```

The PostgreSQL lane is required for numeric types, UUID casts, conflict targets,
timestamps, and migrations. Tests generate their manifest before Vitest; restart
watch mode after adding decorated classes. Documentation-only changes need
instruction-chain and knowledge freshness checks, not the runtime test suite.
