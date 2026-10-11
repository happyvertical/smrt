# Nullable SQLite reference column migration (#3795)

Risk: high, schema mutation and referential integrity. Trusted manifest input;
untrusted persisted rows and quoted identifiers remain subject to database
constraints. No application-runtime DDL or foreign-key disabling.

| Behavior / invariant | Trigger | Positive | Negative / failure | Actor / context | Executor / transaction | Runtime / dialect | Contract edge | Level | Command |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| New nullable reference migrates atomically | Existing populated table gains FK column | NULL existing values, enforced RESTRICT/CASCADE, self and inbound references survive; rerun no drift | Orphan writes rejected; transaction rollback restores prior schema | Authorized migration runner | Real SQLite transaction and public comparer | Node / SQLite | Manifest to SQL and introspection | Regression/integration | `pnpm --filter @happyvertical/smrt-core exec vitest run src/schema/issue-3795-sqlite-reference-column.test.ts` |
| Unsupported shapes remain visible | FK on existing column or non-NULL default / required / backfill | Ordinary nullable no-default addition only | Existing FK drift stays manual, engine allowlist respected | Authorized runner | Compare only for unsupported shapes | SQLite; existing PostgreSQL/DuckDB behavior unchanged | Planner classification | Regression and full dialect suites | `pnpm --filter @happyvertical/smrt-core test`; `pnpm --filter @happyvertical/smrt-core test:postgres` |

The expenses legacy-schema migration is the consuming-package regression. Capture
base failure before implementation and head passes before combined release review.
