# @happyvertical/smrt-core

ORM, code generation, AI integration, and the DispatchBus. Everything else builds on this.

## Key Classes

| Class | File | Purpose |
|-------|------|---------|
| SmrtObject | `src/object.ts` | Base persistent object — save, delete, is(), do(), loadFromId/Slug |
| SmrtCollection | `src/collection.ts` | CRUD collection — list, get, create, delete, getOrUpsert |
| ObjectRegistry | `src/registry.ts` | Global singleton (globalThis) — class metadata, fields, STI chains, manifests |
| DispatchBus | `src/dispatch/bus.ts` | Inter-agent messaging — emit, subscribe (persistent), process |
| GlobalInterceptors | `src/interceptors.ts` | Plugin system — beforeList/Get/Save/Delete hooks (used by tenancy) |

## SmrtObject Lifecycle

`constructor(options)` → `initialize()` → ready for `save()`/`delete()`/`loadFromId()`

- `initialize()`: loads field initializers, applies option values (options override initializers), loads from DB if id/slug provided
- `save()`: upsert with STI validation, interceptor execution, auto-embeddings. Persisted objects (`isPersisted` — set by DB hydration and successful saves) upsert on `['id']` so natural-key edits (e.g. slug renames) update in place; new objects upsert on the natural-key conflict columns for ingestion-style dedup (#1472)
- `is(criteria)` / `do(instructions)` / `describe()`: AI operations via function calling. They inject the object's own `toPublicJSON()` (sensitive fields stripped) as a "content body" so the model reasons over the instance. Options: `includeData: false` skips injection (for callers that already curate the relevant fields into the instruction); `maxDataLength` overrides the truncation budget. Neither key is forwarded to `ai.message()`. (#1567)
- `getSlug()`: auto-generates from name → title → label → id
- `loadRelated(fieldName)`: lazy-loads relationships (cached in `_loadedRelationships` Map)

## SmrtCollection Query

```typescript
await collection.list({
  where: { status: 'active', price: { op: '>', value: 10 } },
  limit: 50, offset: 0, orderBy: 'created_at DESC'
});
```

**WHERE operators**: `=`, `>`, `<`, `>=`, `<=`, `!=`, `in`, `not in`, `like`, `is null`, `is not null`. Arrays auto-detect `IN`. Dot notation for JSON paths: `metadata.userId`.

STI child collections auto-filter by `_meta_type`.

## @smrt() Decorator Options

Key options: `tableName`, `tableStrategy` ('cti'|'sti'), `conflictColumns`, `api`/`mcp`/`cli` (generation config), `ai` (callable methods), `hooks` (beforeSave/afterSave/beforeDelete/afterDelete), `embeddings` (auto-generate), `tenantScoped`, `agent`.

Registration sets `SMRT_TABLE_NAME` static property (survives minification).

## Domain Knowledge Artifacts

`smrtPlugin()` writes runtime manifests and agent/developer knowledge artifacts:

- local dev/build: `.smrt/manifest.json` and `.smrt/smrt-knowledge.json`
- package build: `dist/manifest.json` and `dist/smrt-knowledge.json`

Keep `manifest.json` runtime-focused. `smrt-knowledge.json` is the deterministic
agent contract for downstream review and architecture tools.

Config precedence for knowledge is defaults → top-level `knowledge` in
`smrt.config.ts` → `packages[packageName].knowledge` → plugin option →
object-level `@smrt({ knowledge })`.

Object-level `knowledge: false` excludes an object from authored context only;
it must not change runtime manifest registration. Use
`knowledge: { tags, summary, risks }` for review-sensitive domain objects.

HTTP knowledge routes are disabled by default. If `knowledge.api.enabled` is
true, generated SvelteKit routes must stay GET-only and guarded by dev mode or
admin auth.

## DispatchBus

- `emit(signalType, payload, metadata)` → creates persistent Dispatch record
- `on(pattern, handler)` → in-memory handler (immediate)
- `subscribe({ signalType, subscriber })` → persistent subscription (survives restarts)
- `process(subscriberName, handler)` → process pending dispatches
- Wildcards: `campaign.*` matches `campaign.completed` (single segment only)
- Tables: `_smrt_dispatch`, `_smrt_dispatch_subscriptions`
- Status: `pending → processing → completed` (or `failed`)

## Change Feed (#1758)

Adapter-agnostic change-observation spine (`src/change-feed.ts`) — the server half of the client/mobile sync contract (PRD #1755):

- `_smrt_changes` system table: one append per framework save/delete via a GlobalInterceptors writer registered at framework init. Deletes are tombstones (`operation: 'delete'`). `_smrt_*` tables are skipped. Feed-append failures log and never fail the user's write. No dirty-check: a field-unchanged `.save()` appends a spurious `update` entry (diff-aware paths like `getOrUpsert`/sync-apply short-circuit before `save()` and append nothing); subscribers must tolerate spurious entries — they are convergent.
- Sequences: allocated as `MAX(seq)+1` inside the INSERT with conflict retry — committed rows stay contiguous, so commit order == seq order on SQLite/Postgres/DuckDB (deliberately NOT identity/serial: those allocate before commit and break the cursor guarantee under concurrent writers).
- `getChangesSince(db, { since, tables?, tenantId?, limit? }) → { changes, cursor, resyncRequired?, resyncCursor? }`: strictly monotonic cursor; polling with returned cursors misses no committed change and never repeats one. A cursor that cannot be served incrementally — pruned below the retained `[floor..horizon]` run, or foreign/ahead of the horizon — gets `resyncRequired: true` with empty `changes`, an unadvanced `cursor`, and `resyncCursor` set to the current horizon so clients can full-refetch then resume incrementally; detection runs on the UNFILTERED log so `tables`/`tenantId` filters never trigger or mask it. `getTenantScopedChangesSince()` resolves tenant via the DispatchBus resolver hook (fail-closed: tenancy on + no context → global rows only; tenant `T` sees `T` + global rows, never another tenant).
- `getTableVersion(db, table) → number`: the per-table change version (`MAX(seq)` for the table, replica-stable — no per-process divergence), the ETag source for zero-query conditional GETs (#1765). Advances on any framework write to the table (CRUD and sync-apply, which all `save()`/`delete()`). A table with no retained entry of its own falls back to the global horizon (never a resettable low value) so an all-pruned table cannot false-304 a stale client; only 0 when the feed is empty.
- Generated `_changes` routes: REST (`GET {basePath}/_changes`, requires `authMiddleware`, otherwise 401 — per-model `api.public` does NOT apply) and SvelteKit (`{routesDir}/_changes/+server.ts`, requires an authenticated principal on `locals`; opt out via `sveltekit.changesRoute.enabled: false`). Query params: `since`, `tables` (comma-separated), `limit`. Responses stay HTTP 200 in the resync state — `resyncRequired` is protocol state, not an error, and `resyncCursor` is the resume cursor after the client completes a full refetch.
- Retention: `pruneChangeFeed(db, { maxAgeMs?, maxRows? })` — schedule it. Pruning deletes oldest-first and always retains the newest entry (a non-empty feed is never emptied), which is what makes pruned-cursor detection provable and keeps caught-up consumers polling normally. Raw-SQL writes are invisible to the feed (same documented gap as the #1499 cache); `bumpChangeFeed(db, { table, rowId? })` is the manual escape hatch.

## Live Events / Change Signals (#1763, server half)

The push companion to the change feed (`src/change-signals.ts` + the generated `_events` SSE route) — the server half of live cache invalidation (PRD #1755). The client subscriber (two-client/reconnect/polling-fallback ACs) is a separate later slice.

- **Change-signal bus** (`src/change-signals.ts`): every framework save/delete that appends a durable feed row also publishes a coarse `ChangeSignal` `{ table, operation, rowId, tenantId, seq }` — **never a row payload** (authorization stays on the read path). Structurally mirrors the collection cache's notify/listen path. `subscribeToChangeSignals(db, listener) → unsubscribe`; `publishChangeSignal`/`broadcastChangeSignal`/the listener loop stay internal. `appendChange` now returns the allocated `seq` (was `void`); the signal carries it as a coarse resume cursor (`bumpChangeFeed` ignores the return). The publish runs only after the append SUCCEEDS (no signal without a durable feed row) and in its own log-and-swallow try/catch, so a signal problem never fails the user's write. `_smrt_*` writes never signal (the writer skips them). Delivery is synchronous per-listener with per-listener try/catch (one throwing SSE controller never blocks others); no per-subscriber queue — backpressure rides the platform `ReadableStream`.
- **In-process + cross-replica**: locally-published and peer-received signals go through the SAME `deliverLocally` path. Cross-replica fan-out rides the db adapter's optional notification capability (`db.notifications`, a NEW `smrt_change_signals` channel distinct from the cache channel) with echo-avoidance by `PROCESS_ID`. No capability → in-process only, warn-once, **never an error, never blocks the write** (subscribers on other replicas fall back to cursor polling).
- **Generated `_events` SSE route**: REST (`GET {basePath}/_events`, requires `authMiddleware`, otherwise 401 — fail-closed, per-model `api.public` does NOT apply; 405 non-GET; 503 no db or subscriber capacity reached) and SvelteKit (`{routesDir}/_events/+server.ts`, requires an authenticated principal on `locals`; opt out via `sveltekit.eventsRoute.enabled: false`; cap via `sveltekit.eventsRoute.maxSubscribers`). Tenant scope is captured ONCE at connection open (`resolveDispatchTenantScope`) and filtered server-side per signal via `signalVisibleToTenant` (same rule as `getChangesSince`'s tenant filter) before any byte hits the wire — delivery runs outside any tenant ALS context, so it must use the captured value. The stream lifecycle lives in `buildChangeEventStream(db, { cursor, tenantScope, heartbeatMs?, manifestHash? })` (exported; the SvelteKit route imports it so it stays thin): subscribe-before-catch-up (closes the gap window; overlap is deduped by the SSE `id:`/seq client-side), `retry: 3000`, optional connection-open `event: manifest` carrying `{ manifestHash }` for live contract detection, cursor catch-up via `getChangesSince` filtered by the CAPTURED scope (not re-resolved from ALS, so it matches the live-signal filter exactly and can't replay another tenant's rows) (`Last-Event-ID` header beats `?since=`; default = live-forward only; `resyncRequired` → `event: resync`), heartbeat (`DEFAULT_EVENTS_HEARTBEAT_MS` = 15s), and `cancel()` teardown (clears heartbeat + unsubscribes). SSE change frame: `id: <seq>\nevent: change\ndata: {table,operation,rowId,tenantId}\n\n` — seq is ONLY in the `id:` line, never the data JSON. Subscriber cap default is `DEFAULT_EVENTS_MAX_SUBSCRIBERS` = 1000; over-cap connections return retryable 503 + `Retry-After`, and existing subscribers are unaffected. **Same-origin only** (not CORS-wrapped): `EventSource` can't set headers and credentialed cross-origin needs Allow-Credentials the CORS helper doesn't emit — cross-origin SSE is a follow-up. Client disconnect through the Node `createServer` bridge now cancels the response reader (was a teardown leak) so `cancel()` fires and the subscription is released.
- **Known gaps** (documented in the module): raw-SQL writes don't signal (same gap as the feed); live signals for caller-managed-transaction writes are best-effort (the append + signal fire pre-commit, so a rolled-back write may emit a signal and its freed seq is later reused) — the autocommit default path is exact, and clients reconcile via full catch-up/resync (inherits the change feed's transaction caveat).

## Single Table Inheritance (STI)

- Base: `@smrt({ tableStrategy: 'sti' })` — children inherit, share one table
- Discriminator: `_meta_type` column with qualified names (`@happyvertical/smrt-content:Article`)
- Child fields: `@meta()` decorator → stored in `_meta_data` JSONB (not as columns)
- Polymorphic queries: collection loads `_meta_type`, creates correct subclass dynamically
- Validation: fail-fast on save if `_meta_type` missing or mismatched

## Code Generators

| Generator | Location | Output |
|-----------|----------|--------|
| REST API | `src/generators/rest.ts` | OpenAPI-compliant CRUD endpoints |
| CLI | `src/generators/cli.ts` | `objectname:action` admin commands — writable allowlist, exhaustive-include, `--from-file`, fail-closed tenant context |
| MCP Server | `src/generators/mcp.ts` | Model Context Protocol tools |
| Web collections | `src/vite-plugin/web-collections.ts` (selectors) + `generateWebModule` | `@happyvertical/smrt-virt-web` — one typed collection definition per API-exposed REST collection (#1761), consumed by `@happyvertical/smrt-web` |

The web module also emits a build-time **`manifestHash`** constant (#1764): `computeWebManifestHash(manifest)` is a deterministic, replica-stable digest of the emitted web-collection SHAPE (name/className/endpoint/idField/actions/fields/relationships), canonicalized (recursive key sort) before `sha256 → base64url`, truncated to 16 chars — so the same schema always hashes the same, and a field add/remove/type-change/edge-change changes it. A change means old persisted client rows may mis-hydrate, so smrt-web keys its durable persistence namespace on it and its `updateAvailable` contract signal compares against it. Three emission sites must not drift: the runtime value (`generateWebModule`), the `@happyvertical/smrt-virt-web` ambient d.ts (`vite-plugin/index.ts`), and the physical `@smrt/web` d.ts (`prebuild/index.ts`).

Generated reads (`list`/`get`) on the REST and SvelteKit generators support conditional GET (helpers in `src/generators/conditional-get.ts`). ETag v2 (#1765): the validator is the table's change-feed version (`getTableVersion`) keyed by the request representation, so a **concrete** `If-None-Match` short-circuits into a 304 with an empty body **before** the collection query runs — an unchanged table revalidates with zero table scan. A wildcard `If-None-Match: *` is deferred until the payload builds (existence confirmed), so a missing item still returns 404, not a false 304. Tenant-scoped reads fold the active tenant into the representation (`resolveTenantEtagDiscriminator`) so one tenant's cached validator never satisfies another's read of the same URL. Routes whose GET renders via a **custom serializer** (which can load related tables the base-table version can't observe) keep the v1 body-hash ETag (`#1757`, query-first but correct); the default `toPublicJSON` path — all REST reads and non-serializer SvelteKit reads — uses v2. v2 is weakly consistent by design (the cost of not reading the data): a revalidation in the sub-statement window between a committed write and its feed append can return a stale 304 that self-heals on the next revalidation. The other v2 window — a deploy that changes the response shape WITHOUT a table write — is closed by the **#1764 ETag salt**: `computeTableVersionEtag(version, representation, manifestHash?)` folds the build's web-collection shape digest into the digest, so a shape-only redeploy busts every read validator (`undefined` reproduces the pre-#1764 unsalted value byte-for-byte for direct helper callers). The generated SvelteKit route bakes the digest in as a `MANIFEST_HASH` constant (via `generateConditionalGetRouteHelper`'s `manifestHash` option, sourced from `computeWebManifestHash(manifest)`) — automatic for the SvelteKit transport. The runtime `APIGenerator` auto-populates the same salt from the runtime registry with `computeRuntimeWebManifestHash()` when `APIConfig.manifestHash` is omitted; explicit `APIConfig.manifestHash` still wins for custom setups. The digest scope is get-OR-list (`selectWebEtagSaltEntries`), so **get-only** routes are salted too. Strong consistency still requires the v1 body-hash path. Cache-Control policy (unchanged from #1757): `private, no-cache` by default; public models may opt into shared caching via `@smrt({ api: { public: true | 'read', cache: { sMaxage } } })` → `public, max-age=0, s-maxage=<n>`; non-public models never emit shared-cache headers. Tenant-scoped models (any mode) never emit them either — bodies vary with session-cookie tenant context that URL-keyed shared caches cannot see; `sMaxage` is neutralized to `private, no-cache` with a one-time warning.

## Child Accessors (R10)

`src/child-accessors.ts` installs a consistent `get<FieldName>()` instance method for every `@oneToMany` field at `@smrt()` registration time (e.g. `@oneToMany('OrderItem') items` → `order.getItems()`), delegating to `loadRelatedMany`. Two invariants:

- **Additive** — never overwrites a hand-rolled method of the same name (checks the whole prototype chain). `Profile.getMetadata()` (key-value) and `ProfileRelationship.getTerms()` are preserved.
- **Runtime-only** — attached to the prototype, invisible to the build-time manifest, so it never leaks into the REST/CLI/MCP surface.

When the target declares multiple FKs back to the parent, annotate `@oneToMany(Target, { foreignKey: '<inverseField>' })`; `loadRelatedMany` and the eager `include:` loader both honor it (else first-match).

## Vite Plugin

```typescript
// vite.config.ts — required for @smrt() decorators (Vite 8+, oxc transform)
export default defineConfig({
  oxc: {
    decorator: {
      legacy: true,
      emitDecoratorMetadata: true,
    },
  },
});
```

Under Vite 8 the oxc transform does not honor the pre-Vite-8 `esbuild.tsconfigRaw`
recipe (or tsconfig `experimentalDecorators` reached through SvelteKit's
`extends "./.svelte-kit/tsconfig.json"` chain), so that recipe throws
`SyntaxError: Invalid or unexpected token` on the first SSR request. Configure
decorators through `oxc.decorator` instead. Consumers still pinned on vite<8 need
the legacy `esbuild.tsconfigRaw` form with `experimentalDecorators: true,
emitDecoratorMetadata: true`.

## Gotchas

- **Never override toJSON()** — handles STI discriminator + meta field extraction. Use `transformJSON()`
- **Property init order**: TypeScript initializers run first, then `initialize()` applies option values (options win)
- **No runtime schema creation**: application tables must be prepared explicitly via migrations/tooling; runtime only verifies and fails clearly
- **Retry logic**: `db.get()` (3 retries, 250ms) and `db.upsert()` (3 retries, 500ms) have built-in retry
- **Field caching**: `_cachedFields` populated during `Collection.create()` — eliminates async `getFields()` per query
- **Smart cloning**: arrays/objects shallow-cloned in property init to prevent aliasing (Issue #22)
- **Table verification cache**: `isTableVerified(dbUrl, tableName)` avoids redundant `tableExists()` calls
- **Manifest required**: build-time AST scanning creates manifest. Without vitest plugin → "No field metadata"
- **Vite plugin loads scanner from `dist/` first**: `src/vite-plugin/import-build-aware.ts` prefers `dist/` when it exists on disk; it only falls back to `src/` on fresh clones. So if you edit `src/scanner/*.ts` or `src/schema/generator.ts` and want those edits reflected in consumer manifest generation, you must rebuild (`pnpm build` or have `pnpm dev` / `pnpm build:watch` running in core). This is intentional — sniffing `.ts` vs `.js` via `import.meta.url` was non-deterministic under tsx and broke 12–13 publishes (#1139).
