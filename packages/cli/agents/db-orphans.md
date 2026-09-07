# `db:orphans` — per-foreign-key orphan count report (#2753)

`db:migrate`'s orphan probe already gates `ADD CONSTRAINT` with a `LIMIT 1`
existence check and prints a suggested repair (see the PostgreSQL section of
`packages/cli/AGENTS.md`); it cannot say *how many* orphans exist or across
which relationships. `db:orphans` runs core's `collectForeignKeyOrphanCounts()`,
which probes every manifest-declared foreign key from
`ObjectRegistry.getAllSchemasAsDefinitions()` as a `COUNT(*)` aggregate —
reusing `renderForeignKeyOrphanDetector()`'s exact FROM/JOIN/WHERE predicate
via its `countOnly` option, never a second hand-written copy — and reports
child/parent table and column, the live orphan count, and whether the child
column is `NOT NULL` (so the two dispositions the repair-SQL builder already
distinguishes — manual repair vs. an executable null-out — are visible up
front, without hand-writing the same SQL against the database). Results print
sorted by count descending. A relationship whose child or parent table does
not exist live is skipped and listed separately rather than failing the whole
report.

Strictly read-only and diagnostic: it never repairs anything, and the orphan
counts themselves never affect the exit code — a database full of orphans
still exits 0, matching the existing "no foreign-key orphan repair, by
design" boundary. It exits non-zero only on a configuration or runtime error
(no database configured, or the report itself could not run). `--json` emits
the full report for scripting; `--verbose` also lists foreign keys with zero
orphans.

`ForeignKeyOrphanSkipped.kind` distinguishes a benign `missing_table` skip
(a manifest table not yet migrated) from `probe_failed` (the `COUNT(*)`
query itself errored — permissions, a malformed live column, a genuine SQL
failure). `smrt db:orphans` marks a `probe_failed` skip `[PROBE FAILED]` in
its Skipped section and never reports the "No orphan rows found" clean
summary while any probe has failed, since an incomplete scan is not the same
claim as a clean one.

`db:status` runs the same probe unconditionally (not gated behind `--parity`,
and independent of whether the configured adapter supports
`getTableSchema` — the probe only needs `db.query()`) and, when any manifest
foreign key has live orphans, prints one compact line per affected foreign
key plus a pointer to `smrt db:orphans` for the full report. A `probe_failed`
skip surfaces as its own distinct warning (`status.orphanProbeFailures`)
rather than being read as "no orphans found"; `missing_table` skips stay
silent in `db:status` (benign, and already visible in full via
`smrt db:orphans`). Never a new `SchemaDiff` finding kind, and never
touching `db:status`'s exit code. A total probe failure (the collector call
itself throws, e.g. it cannot list live tables at all) is reported as
"Foreign-key orphan check unavailable" rather than failing `db:status`.
