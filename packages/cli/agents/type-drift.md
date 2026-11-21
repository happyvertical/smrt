# Float-width, timestamptz, and jsonb convergence (#2770, #2771, #2772)

## Float-width drift (#2770)

`db:status`/`db:diff` report float-width drift (`real` vs `double precision`)
as `column_type_drift`, the same severity class as `legacy_integer_width`; a
live single-precision column backed by a double-precision declaration widens
automatically (lossless), but a double-precision live column backed by a
single-precision declaration stays advisory-only (narrowing loses precision).

## text -> timestamptz convergence (#2771)

A `text` column on a table smrt itself creates, backed by a manifest
`TIMESTAMP` (-> `TIMESTAMPTZ` on PostgreSQL) declaration, converges instead of
staying blocked forever: `db:migrate` runs a server-side shape probe over
every non-null value first (`packages/core/src/schema/text-cast-probe.ts`)
and only plans the executable `ALTER COLUMN … TYPE timestamptz USING
col::timestamptz` when every value is confirmed to parse unambiguously. A
probe that finds an unparsable value fails closed with a masked sample
instead of running the cast — repair the value, then rerun; the migration is
a no-op once converged. This is independent of
`postgresTimestampMigration.legacyTimezone`
(`--postgres-timestamp-legacy-timezone=UTC`), which
stays reserved for ambiguous naive wall-clock strings the probe does not
accept; it does not imply `--empty-text-as-null` (empty text, and literal
`null` text, still stop the run without that opt-in; a JSON `null` in a
legacy json column is NULL). Every PostgreSQL `timestamptz` conversion runs a
recheck first, in its own transaction under the table's ACCESS EXCLUSIVE
lock, and stops (`P0001`, "Cannot convert …") when a value written after
planning would not convert faithfully; rerun `db:migrate` to re-plan (#5505).

On SQLite a manifest `TIMESTAMP` over a live `TEXT` column is a
`type_upgrade` that rebuilds the table (`DATETIME`) and keeps every value as
stored, including empty text. The `DATETIME` column has NUMERIC affinity, so
the rebuild checks after its copy that every value keeps its value and
storage class and refuses otherwise (numeric-looking text such as `0001`
would become the integer `1`): repair those values, then rerun (#5505).

On DuckDB the change is `ALTER COLUMN TYPE`, which fails on unparseable
values. When the column is indexed and the table references itself, the
change needs a table rebuild that DuckDB cannot copy into, so it is reported
as `type.rebuild-unavailable` and nothing runs. Convert it by hand in one
transaction: create the new table with the TIMESTAMP column and the same
keys (self-reference included), insert the rows parents-first so every
reference resolves, drop the old table (tables that reference it need the
same treatment), rename the new one, recreate its indexes, then confirm with
`smrt db:status --parity`.

### Empty text (#3226)

The probe counts empty or whitespace-only text separately. When it is the
only obstacle and the manifest and live columns are both nullable,
`DiffOptions.emptyTextAsNull` (`--empty-text-as-null`) converts with
`USING (CASE WHEN btrim(col) = '' THEN NULL ELSE col END)::<type>` and the
change carries a `note`. The same opt-in applies to `jsonb` (after the
duplicate-key walk over the remaining values) and to `text` -> integer.
Without it, the timestamptz/jsonb advisory names the empty-text count and
prints the sample as `(empty)`. `text` -> integer has no diff-time probe: its
note says "if any", and a non-integer value fails only at apply time (the
preflight `RAISE`). The `--postgres-timestamp-legacy-timezone=UTC` path still
maps `''` and `'null'` to NULL without the opt-in (`differ.ts`
`generateTypeUpgradeSQL`). `db:status` / `db:history` accept
`--empty-text-as-null` too.

## text -> jsonb convergence and uuid visibility (#2772)

A `text` column on a table smrt itself creates, backed by a manifest `JSON`
(-> `jsonb` on PostgreSQL) declaration, was previously invisible to
`db:status`/`db:diff` and had no `db:migrate` repair path (the #1335
text/json tolerance is directional: it stays silent for the reverse pairing —
a native `json`/`jsonb` live column backed by a text-convention manifest
field — but this direction now runs the same shared shape probe as #2771's
timestamptz path and converges the same way: a clean probe plans `ALTER
COLUMN … TYPE jsonb USING col::jsonb`; a dirty probe fails closed with a
masked sample. `db:status` also now reports an `info`-level finding for a
declared-`uuid` structural column still backed by live `text` (previously
silent by design), pointing at `db:migrate-uuid` — the tolerance itself is
unchanged, only its visibility. SQLite stays advisory-only for both.

## Live-only column defaults on either conversion

PostgreSQL rejects `ALTER COLUMN … TYPE` outright whenever the column has
any existing default that can't auto-cast to the target type, so both
conversions above always `DROP DEFAULT` first when the *live* column has
one — restoring it afterward (`SET DEFAULT`) only when the *manifest* also
declares one. A live-only default (the manifest declares none) is the same
"relaxation" `db:status --parity`'s default-drift finding already gates
behind `relaxColumns`/`--relax-columns` elsewhere: without that opt-in, the
conversion stays a fail-closed advisory naming the blocking default instead
of executing.
