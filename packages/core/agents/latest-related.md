<!-- Module doc for packages/core/AGENTS.md. Linked from the Modules table there. -->

# Latest-related reads (#1903)

Use `SmrtCollection.listWithLatestRelated()` when a page needs one row from a
declared `@oneToMany` relationship without N+1 queries or hydrating unrelated
children. `latestRelated.orderBy` ranks rows within each parent, `select`
chooses the returned child fields (defaulting to the related model's declared
primary key), and an optional `sortBy` orders parents by the winning child
before the parent `limit`/`offset` are applied. The result is
`{ parent, latestRelated }`: `parent` is hydrated and `latestRelated` is a
plain projection or `null` when the parent has no child.

The read plan uses a portable `ROW_NUMBER()` CTE with explicit null-last
ordering and the declared primary keys for every tie-break, join, and result
map. The parent primary key is never assumed to be `id`; the related primary
key is the default projection when `select` is omitted. Only the visible
parent page is hydrated.

Pagination is adapter-aware: SQLite uses `LIMIT -1` for offset-only reads,
while DuckDB and PostgreSQL use `LIMIT ALL`. In-memory DuckDB and JSON adapters
retain their engine hint even when no URL or database type is present, so the
generated syntax remains legal for the actual driver.

Internal result aliases are bounded `__smrt_lr_N` identifiers. The allocator
reserves declared and live parent table columns, and parent columns are
projected explicitly (using the public table-schema API where available) rather
than `parent.*`, so externally added columns cannot collide or corrupt the
latest-related projection. JSON adapters without live schema introspection use
the declared schema as their fallback.

The primitive preserves normal read interceptors, tenant and STI scope, and
does not expose a cache option until cache invalidation is implemented. Tests
cover custom primary keys, SQLite/DuckDB offset-only pagination, long field
names, external alias collisions, and cleanup of temporary database files.
