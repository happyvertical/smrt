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

Strictly read-only and diagnostic: it never repairs anything, and always
exits 0 regardless of what it finds — the existing "no foreign-key orphan
repair, by design" boundary stays exactly where it is. `--json` emits the full
report for scripting; `--verbose` also lists foreign keys with zero orphans.

`db:status` runs the same probe unconditionally (not gated behind `--parity`)
and, when any manifest foreign key has live orphans, prints one compact line
per affected foreign key plus a pointer to `smrt db:orphans` for the full
report — never a new `SchemaDiff` finding kind, and never touching
`db:status`'s exit code. A probe failure is reported as
"Foreign-key orphan check unavailable" rather than failing `db:status`.
