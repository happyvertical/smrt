<!-- Module doc for packages/core/AGENTS.md. Linked from the Modules table there. -->

# Query bounds (#2367)

`src/query-bounds.ts` is the single parser every generated read surface uses for
`limit`/`offset`. A bound is a non-negative integer or it is a client error:
malformed input raises a 400-typed `QueryBoundsError` (a `ValidationError`, so
`withRetry` never retries it and `normalizeTypedHttpError` renders it as a
structured 400) instead of reaching the driver as `LIMIT NaN`. Oversized pages
are **clamped** to `MAX_LIST_LIMIT` (1000) rather than rejected, and an explicit
`0` means zero rows — it is not folded into `DEFAULT_LIST_LIMIT` (50).

- `collection.get()` / `findOne()` / `findById()` emit `LIMIT 1`.
- `collection.list()` validates `limit`/`offset` but applies **no implicit
  default**: it is the framework's bulk-read primitive and relationship,
  junction, hierarchy and `listByIds()` callers all expect every matching row, so
  a framework-wide default would truncate correct queries. Applications opt in
  per collection with `defaultListLimit` / `maxListLimit` (validated at
  construction). The generated surfaces enforce the ceiling on their own
  untrusted input regardless.
- `orderBy` runs the same rail as `where` (#1540) and `select` (#1902): terms are
  checked against the field whitelist and refused for `@field({ sensitive: true })`
  and `@field({ readPermission })` columns — ordering is a comparison, and
  `?orderBy=api_secret&limit=1` is an oracle over a column the request may neither
  filter on nor project — and for fields that are registered but **not
  column-backed** — `oneToMany`/`manyToMany`/`meta`/`transient`, plus the
  `id`/`slug`/`context` system columns on a custom-primary-key class, which the
  schema generator omits — all of which otherwise reach the driver as
  `no such column` and surface as a 500. The whitelist is skipped only for
  manifest-less inline test classes (#869), exactly as `where` skips it. `where`
  still whitelists those omitted system columns; that is a pre-existing gap of
  the same family, not closed here because `where: { id }` is on internal
  hydration paths.
- Every generated list surface (REST, SvelteKit, MCP, and the emitted stdio MCP
  runtime) pages with `ORDER BY created_at DESC, <pk> ASC` unless the caller
  supplies `orderBy` — `LIMIT`/`OFFSET` with no ordering is not pagination, and
  `created_at` alone still ties. `<pk>` follows a declared
  `@field({ primaryKey: true })` (read from `_meta.primaryKey` in manifests)
  because custom-primary-key classes have no synthetic `id` column. The stdio
  runtime gets the per-object ordering baked in via `RuntimeOptions.listOrderBy`;
  it cannot resolve a primary key on its own. Index: #2363.
- `listByIds()` chunks its `IN` list at `IN_LIST_CHUNK_SIZE` (900), like the
  relationship/junction/hierarchy loaders.

Keyset pagination is deliberately out of scope.
