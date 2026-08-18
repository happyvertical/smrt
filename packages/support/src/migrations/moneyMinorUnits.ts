/**
 * Support money columns: floating-point major units → integer minor units.
 *
 * Ships as an explicit, opt-in migration rather than a schema-differ upgrade
 * because REAL→INTEGER is not information-preserving: an automatic
 * `ALTER … TYPE integer` would truncate `19.99` to `19`. The values have to be
 * rescaled by the currency's minor-unit factor during the type change (#2401).
 *
 * ```ts
 * console.log((await preflightSupportMoneyMinorUnits(db)).summary);
 * await migrateSupportMoneyToMinorUnits(db);
 * ```
 *
 * **Rate columns are deliberately absent.** `SupportPlan.overageHourlyRate`,
 * `SupportPlan.onCallHourlyRate` and `SupportCompensationPlan.hourlyRate` stay
 * DECIMAL — a rate is inherently fractional — but their *unit* changes from
 * major units per hour to **minor units per hour**, so existing rows must be
 * multiplied by the same scale. That is a value change with no type change, and
 * the column list below cannot express it; rescale them in the same deploy
 * step, e.g. `UPDATE support_plans SET overage_hourly_rate = overage_hourly_rate * 100`.
 *
 * Frozen `rateSnapshot` JSON on already-settled charges is history and is left
 * alone: it records what the rate was when the charge was priced, and the
 * amount beside it is rescaled by this migration.
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
export const SUPPORT_MONEY_MINOR_UNITS_BACKFILL =
  '@happyvertical/smrt-support:money-minor-units:v1';

/** Every support money column that held major units before #2401. */
export const SUPPORT_MONEY_COLUMNS: MoneyColumnTarget[] = [
  { table: 'support_plans', columns: ['availability_fee_amount'] },
  { table: 'support_charges', columns: ['amount'] },
  { table: 'support_compensations', columns: ['amount'] },
];

/**
 * Report what {@link migrateSupportMoneyToMinorUnits} would do, without writing
 * anything.
 */
export function preflightSupportMoneyMinorUnits(
  db: DatabaseInterface,
  options: { scale?: number; engineHint?: string } = {},
): Promise<MinorUnitsPreflightResult> {
  return preflightMinorUnitsRescale(db, SUPPORT_MONEY_COLUMNS, options);
}

/**
 * Convert every support money column from floating-point major units to integer
 * minor units. Idempotent via a `_smrt_backfills` marker.
 *
 * @throws `MinorUnitsPreflightError` when a row would be rounded or would
 *   overflow `int4` and `force` was not set.
 */
export function migrateSupportMoneyToMinorUnits(
  db: DatabaseInterface,
  options: { scale?: number; engineHint?: string; force?: boolean } = {},
): Promise<MinorUnitsRescaleResult> {
  return rescaleMoneyColumnsToMinorUnits(db, SUPPORT_MONEY_COLUMNS, {
    ...options,
    backfillName: SUPPORT_MONEY_MINOR_UNITS_BACKFILL,
    packageName: '@happyvertical/smrt-support',
  });
}
