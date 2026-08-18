/**
 * Projects money columns: floating-point major units → integer minor units.
 *
 * Ships as an explicit, opt-in migration rather than a schema-differ upgrade
 * because REAL→INTEGER is not information-preserving: an automatic
 * `ALTER … TYPE integer` would truncate `19.99` to `19`. The values have to be
 * rescaled by the currency's minor-unit factor during the type change (#2401).
 *
 * ```ts
 * console.log((await preflightProjectsMoneyMinorUnits(db)).summary);
 * await migrateProjectsMoneyToMinorUnits(db);
 * ```
 *
 * The two snapshot tables convert together: the delivery margin is
 * `charge - compensation`, so a half-converted pair produces a nonsense number
 * rather than an error.
 *
 * Both tables are immutable-on-save, and the immutability check compares a
 * stringified field snapshot. Rescaling changes those strings, which is
 * harmless — the snapshot is recomputed from the row on load — but it does mean
 * a row must not be mid-flight while the migration runs.
 *
 * On SQLite the values are rescaled but the declared type cannot change in
 * place; those columns come back in `declaredTypeChangePending` and need the
 * table-rebuild path (#2370).
 */

import {
  type DatabaseInterface,
  type MinorUnitsPreflightResult,
  type MinorUnitsRescaleResult,
  type MoneyColumnTarget,
  preflightMinorUnitsRescale,
  rescaleMoneyColumnsToMinorUnits,
} from '@happyvertical/smrt-core/migrations';

/** Marker recorded in `_smrt_backfills` once the rescale has run. */
export const PROJECTS_MONEY_MINOR_UNITS_BACKFILL =
  '@happyvertical/smrt-projects:money-minor-units:v1';

/** Every projects money column that held major units before #2401. */
export const PROJECTS_MONEY_COLUMNS: MoneyColumnTarget[] = [
  { table: 'service_charge_snapshots', columns: ['amount'] },
  { table: 'service_compensation_snapshots', columns: ['amount'] },
];

/**
 * Report what {@link migrateProjectsMoneyToMinorUnits} would do, without
 * writing anything.
 */
export function preflightProjectsMoneyMinorUnits(
  db: DatabaseInterface,
  options: { scale?: number; engineHint?: string } = {},
): Promise<MinorUnitsPreflightResult> {
  return preflightMinorUnitsRescale(db, PROJECTS_MONEY_COLUMNS, options);
}

/**
 * Convert every projects money column from floating-point major units to
 * integer minor units. Idempotent via a `_smrt_backfills` marker.
 *
 * @throws `MinorUnitsPreflightError` when a row would be rounded or would
 *   overflow `int4` and `force` was not set.
 */
export function migrateProjectsMoneyToMinorUnits(
  db: DatabaseInterface,
  options: { scale?: number; engineHint?: string; force?: boolean } = {},
): Promise<MinorUnitsRescaleResult> {
  return rescaleMoneyColumnsToMinorUnits(db, PROJECTS_MONEY_COLUMNS, {
    ...options,
    backfillName: PROJECTS_MONEY_MINOR_UNITS_BACKFILL,
    packageName: '@happyvertical/smrt-projects',
  });
}
