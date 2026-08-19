/**
 * Subscriptions money columns: floating-point major units → integer minor units.
 *
 * Ships as an explicit, opt-in migration rather than a schema-differ upgrade
 * because REAL→INTEGER is not information-preserving: an automatic
 * `ALTER … TYPE integer` would truncate `19.99` to `19`. The values have to be
 * rescaled by the currency's minor-unit factor during the type change (#2401).
 *
 * ```ts
 * console.log((await preflightSubscriptionsMoneyMinorUnits(db)).summary);
 * await migrateSubscriptionsMoneyToMinorUnits(db);
 * ```
 *
 * On SQLite the values are rescaled but the declared type cannot change in
 * place; those columns come back in `declaredTypeChangePending` and need the
 * table-rebuild path (#2370).
 *
 * **Pricing rules are not migrated.** `PricingRule.terms` is a JSON blob whose
 * `unitPrice` / `overageUnitPrice` / `amount` / tier prices are now read as
 * *minor units per unit of usage*. They are deliberately left fractional (a
 * per-token rate is routinely a fraction of a cent), so there is no type to
 * change — but every existing rule's terms are in major units and must be
 * rescaled by the operator, who alone knows which keys in a given rule are
 * prices and which are quantities or ratios.
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
export const SUBSCRIPTIONS_MONEY_MINOR_UNITS_BACKFILL =
  '@happyvertical/smrt-subscriptions:money-minor-units:v1';

/**
 * Every subscriptions money column that held major units before #2401.
 *
 * `quantity` columns are absent on purpose: metered quantities are genuinely
 * fractional and stay DECIMAL.
 */
export const SUBSCRIPTIONS_MONEY_COLUMNS: MoneyColumnTarget[] = [
  { table: '_smrt_subscription_plans', columns: ['price_amount'] },
  { table: '_smrt_client_charges', columns: ['amount'] },
  { table: '_smrt_billing_adjustments', columns: ['amount'] },
  { table: '_smrt_spending_policies', columns: ['limit_amount'] },
];

/**
 * Report what {@link migrateSubscriptionsMoneyToMinorUnits} would do, without
 * writing anything.
 */
export function preflightSubscriptionsMoneyMinorUnits(
  db: DatabaseInterface,
  options: { scale?: number; engineHint?: string } = {},
): Promise<MinorUnitsPreflightResult> {
  return preflightMinorUnitsRescale(db, SUBSCRIPTIONS_MONEY_COLUMNS, options);
}

/**
 * Convert every subscriptions money column from floating-point major units to
 * integer minor units. Idempotent via a `_smrt_backfills` marker.
 *
 * @throws `MinorUnitsPreflightError` when a row would be rounded or would
 *   overflow `int4` and `force` was not set.
 */
export function migrateSubscriptionsMoneyToMinorUnits(
  db: DatabaseInterface,
  options: { scale?: number; engineHint?: string; force?: boolean } = {},
): Promise<MinorUnitsRescaleResult> {
  return rescaleMoneyColumnsToMinorUnits(db, SUBSCRIPTIONS_MONEY_COLUMNS, {
    ...options,
    backfillName: SUBSCRIPTIONS_MONEY_MINOR_UNITS_BACKFILL,
    packageName: '@happyvertical/smrt-subscriptions',
  });
}
