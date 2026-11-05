# `db:drop-framework-base-tables` details (#2647)

Detail for the one-time remediation described in `AGENTS.md`.

- Execute-or-refuse, like `db:rollback`: it refuses (non-zero exit, nothing
  dropped) if any target table has rows, has anything but that table's own
  expected columns and types, or is referenced by a foreign key anywhere in
  the live database. A consumer's own unrelated table sharing one of these
  five names is exactly what the shape check protects.
- The expected shape is **per table, not one universal baseline**:
  `smrt_objects`/`smrt_classes`/`smrt_collections` are exactly `id`/`slug`/
  `context`/`created_at`/`updated_at`, but `smrt_hierarchicals` also
  requires `parent_id` and `smrt_polymorphic_associations` also requires
  `meta_type`/`meta_id`/`role`/`sort_order` — `SmrtHierarchical`'s and
  `SmrtPolymorphicAssociation`'s own real fields, confirmed against a
  genuine pre-#2644 `db:migrate` run. A table under either of those two
  names with *only* the plain five columns is refused as unexpected shape,
  not treated as safe.
- Companion indexes are enumerated from each table's live schema (never
  guessed). `smrt_hierarchicals`/`smrt_polymorphic_associations` do not
  carry the `created_at` list-ordering index the other three do (also
  empirically confirmed, not assumed).
- Bounded PostgreSQL execution reuses the same `SET LOCAL lock_timeout` /
  `statement_timeout` pattern as every other DDL path (#2362). Every target
  is locked `IN ACCESS EXCLUSIVE MODE` before re-checking it — a plain
  `SELECT COUNT(*)` alone would not block a concurrent writer — and shape,
  type, and emptiness are all re-verified inside that transaction
  immediately before dropping anything, via raw `information_schema.columns`
  / `PRAGMA table_info` (`getTableSchema()` is not available on the
  transaction-scoped connection). Only `DROP TABLE` is ever executed —
  never a `DROP INDEX` by name — so `DROP TABLE`'s own cascade removes the
  table's indexes identity-safely instead of trusting a possibly-stale
  planned index name.
- `--dry-run` prints the exact plan (which tables exist, their companion
  indexes, and the DROP statements) without executing.
- Skipping it is safe: a table left behind is inert and permanently orphaned,
  never written to or read from again. Documented, narrow residual risk, all
  schema-integrity (never data loss — the target is always verified empty
  first): DuckDB's adapter does not report foreign keys through
  `getTableSchema()` at all; this module's reverse-FK scan (like every other
  PostgreSQL schema tool in this package) only looks at the `public` schema;
  and foreign keys are checked at planning time only, not re-scanned inside
  the execution transaction. On PostgreSQL a foreign key that appeared after
  planning is still caught there — `DROP TABLE` refuses when a real
  dependent exists, dependency-based, empty parent or not. **This does not
  hold on SQLite**: its FK enforcement on `DROP TABLE` is row-based, so an
  empty parent (this command's precondition) drops cleanly past a real
  foreign key, verified directly. The plan-time scan is the only gate on
  SQLite/DuckDB, narrower than PostgreSQL's.
