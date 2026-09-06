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
- API custom-action eligibility has ONE resolver, `resolveApiMethodExposure()`
  in `generators/custom-action.ts`: both SvelteKit route emitters,
  `resolveApiActionSet`, and `knowledge.ts` read it, and a new consumer must too
  — a local mirror is how a method gets reported unavailable while its route
  file is still written. A public method routes by default only when every
  parameter is JSON-shaped; `@method({ expose })` overrides in both directions,
  `expose: true` bypasses the heuristic ALONE, and an explicit `api.include` or
  `api.routes` entry keeps its pre-#2686 route. Fail closed on scanner
  uncertainty: read `parameters[].typeUnresolved`, never the `'any'` it
  substitutes. Accepting `Date` as wire-able and hydrating it
  (`toCustomActionDate`) are one decision — changing either breaks the other.
  The runtime `APIGenerator` transport stays declaration-gated: `rest.ts`
  dispatch and `preflight-route.ts` prediction both read
  `declaresRuntimeRestRoute()`, which must accept every `ApiCustomRouteConfig`
  option so a sweep moving one onto its method cannot delete the endpoint. Its
  twin `declaresRuntimeRestRouteShape()` deliberately ignores `expose: false`:
  the dispatcher must still SEE a withheld declaration to answer 404, because
  `POST /<collection>/<segment>` resolves to `create` when nothing claims the
  segment. Split unions and type arguments with `splitTopLevel()` — a naive
  `split('|')` truncates `Record<string, Asset | null>` into fragments that
  match no rule and are then accepted, widening the gate. `extractTypeName`
  returns `null` for a generic with an unresolvable ARGUMENT or a union with an
  unresolvable BRANCH so those reach that fail-closed path instead of arriving
  as a bare `'Array'`. Runtime transports read
  `ObjectRegistry.resolveRuntimeMethod()`, which tries the item class's manifest
  entry, then the COLLECTION class's (where a collection-hosted action's
  parameters live), then the live `@method()` store — keyed by CONSTRUCTOR,
  never by simple name (`Account` exists in two packages), and recording
  `isStatic` because an unscanned runtime has no manifest to recover the
  receiver from. `isRestActionRoutable` ANDs "declared" with that receiver, so
  it never predicts `allow` for an action dispatch refuses. A declared action
  with no receiver is refused (501 collection-scoped, 404 item-scoped), never
  allowed to fall through into `create`. All eight consumers read the resolver,
  including `packages/smrt-workbench/src/discovery.ts`; it imports the
  `./generators/custom-action` LEAF subpath, not `./generators`, because that
  barrel value-re-exports `MCPGenerator` and so drags `@happyvertical/ai` and
  `@happyvertical/sql` into a build-time helper (2 modules vs 109). Keep
  `custom-action.ts` free of value imports outside `tools/tool-generator`.

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
