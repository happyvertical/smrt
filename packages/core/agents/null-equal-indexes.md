# Nullable framework conflict identities

`SmrtObject.save()` and the SDK upsert already treat NULL conflict values as
identical. On PostgreSQL 15+, a matching full `UNIQUE NULLS NOT DISTINCT` index
allows a warm nullable upsert to execute one native statement. This statement
bound excludes the first server/index capability probes and object lifecycle
work. PostgreSQL version alone does not establish readiness.

SMRT marks only its generated **runtime conflict identity** indexes with
`nullsNotDistinct: true`, and only when a key column is nullable. This includes
CTI/STI defaults and explicitly configured conflict columns. Primary-key targets
need no additional index. Optional business-field and declared composite unique
indexes remain ordinary NULLS DISTINCT; multiple NULL business values continue
to be legal. The marker survives manifest, registry and migration schema paths.

Fresh PostgreSQL DDL uses a version-gated dynamic `DO` block: PostgreSQL 15+
executes NND, while older servers execute ordinary UNIQUE without parsing the
unsupported syntax. SQLite/DuckDB DDL and their existing upsert paths do not
change. The PostgreSQL statement planner preserves the complete block and
**rejects `--postgres-safe`** when such a block is present, before executing the
plan. Schedule an atomic maintenance window and retry ordinary `db:migrate`
without that flag. No conditional blocking index build runs in concurrent mode.

## Existing deployment procedure

1. Generate current manifests and run ordinary schema migration to establish
   the current tables/conflict column shapes. Ordinary parity does not replace
   an existing index merely because its NULL semantics differ.
2. Run `smrt db:migrate-null-equal-indexes --dry-run` against the intended
   database. The command discovers framework schema markers, checks server
   version and exact public-schema index catalogs, and prints readiness and
   replacement SQL. It performs no DDL or data writes in dry-run mode.
3. Resolve blocked findings explicitly. Duplicate NULL-equal groups are counted
   without printing their values; the report supplies a quoted detector SELECT.
   Decide correct identities with the data owner. This command never deletes or
   merges rows. Missing/drifted indexes require ordinary schema repair first.
4. Schedule a maintenance window and run `smrt db:migrate-null-equal-indexes`.
   It acquires ACCESS EXCLUSIVE table locks in deterministic order, repeats
   catalog and duplicate checks under those locks, and replaces pending indexes
   in one transaction. Writers wait while the locks are held. Lock/statement
   timeouts use `migrations.postgres` settings (30s/60s defaults, 0 disables).
5. Refresh database connections in **every application process**, or restart
   them. The SDK caches negative capability probes per adapter. Use the public
   `getDatabase({ ...sameOptions, clearCache: true })` API and replace consumer
   references to the old adapter; merely refreshing the CLI process cannot
   refresh running applications. Until refresh, the existing fallback remains
   correct, but retains its additional statements.
6. Repeat dry-run to verify current indexes. A repeated apply skips current
   indexes. PostgreSQL <15 and other engines report unsupported and change
   nothing; upgrading PostgreSQL does not itself replace an ordinary index.

The migration refuses constraint-owned indexes, reverse dependencies (including
foreign keys), extension/internal ownership, partitioned tables, predicates,
expressions, INCLUDE columns, nondefault ordering/operator classes/collation or
storage, and changed key order. These require a separate dependency-aware
migration. It never uses CASCADE or drops foreign keys. A failed locked recheck,
DDL statement or timeout rolls back every replacement and retains the original
indexes; resolve the reported cause and retry. Catalog state supplies the
idempotency/readiness record, rather than an audit marker that could falsely
claim readiness after later DDL drift. Keep the command output in the operator's
change record. No runtime object operation creates or upgrades application DDL.

Implementation: `schema/conflict-target.ts`, `schema/ddl/null-equal-index.ts`,
`migrations/null-equal-indexes.ts`, and CLI `db-migrate-null-equal-indexes.ts`.
