# Major-unit to minor-unit migration

This guide covers the numeric-column rescale only. It is not the
[money data upgrade](money-upgrade.md): it does not change `TaxSettings`,
calculate tax, or create snapshots.

`preflightCommerceMoneyMinorUnits(db)` reports whether known commerce columns
still contain major units, rows that would round, and values outside JavaScript
safe-integer range. After reviewing its report, run
`migrateCommerceMoneyToMinorUnits(db)`. The migration is idempotent through its
`_smrt_backfills` marker. PostgreSQL and DuckDB change columns to `BIGINT` and
rescale values; SQLite rescales values but reports its required declared-type
table rebuild as `declaredTypeChangePending`.

`Payment.nativeAmount` and `PaymentIntent.paymentOptions[].nativeAmount` are
excluded. Their units depend on the row currency or asset (for example BTC
satoshis), so a blanket ×100 is wrong. First normalize each value to its own
asset's minor unit, then use `rescaleMoneyColumnsToMinorUnits()` with scale 1
for `Payment.nativeAmount`. Let open payment intents expire and be re-quoted;
their JSON options have no safe blanket conversion.
