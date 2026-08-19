/**
 * Commerce money columns: floating-point major units → integer minor units.
 *
 * Ships as an explicit, opt-in migration rather than a schema-differ upgrade
 * because REAL→INTEGER is not information-preserving: an automatic
 * `ALTER … TYPE integer` would truncate a stored `19.99` to `19` and destroy 99
 * cents on every row. The values have to be rescaled by the currency's
 * minor-unit factor *during* the type change (#2401).
 *
 * Run it from one deploy process, after the writers are upgraded:
 *
 * ```ts
 * import { getDatabase } from '@happyvertical/sql';
 * import {
 *   preflightCommerceMoneyMinorUnits,
 *   migrateCommerceMoneyToMinorUnits,
 * } from '@happyvertical/smrt-commerce';
 *
 * const db = await getDatabase({ type: 'postgres', url: process.env.DATABASE_URL! });
 *
 * // 1. Read-only. Prints the rows that would be rounded or overflow int4.
 * console.log((await preflightCommerceMoneyMinorUnits(db)).summary);
 *
 * // 2. Convert. Idempotent — a second run is a no-op.
 * await migrateCommerceMoneyToMinorUnits(db);
 * ```
 *
 * Engine notes:
 *
 * - **PostgreSQL / DuckDB** — the column type changes in place with
 *   `USING round(col * 100)`.
 * - **SQLite** — values are rescaled, but the *declared* type cannot be altered
 *   in place. SQLite's declared type is only an affinity, so the column already
 *   behaves as integer minor units; bringing the declaration into line needs
 *   the table-rebuild path (#2370). The result reports those columns in
 *   `declaredTypeChangePending`.
 *
 * Range note: INTEGER is `int4` on PostgreSQL, so each column tops out near
 * 2.1e9 minor units — about $21.4M. The preflight lists any row that would
 * overflow. Widening to BIGINT is the decision parked in #2373 and is a plain
 * widening whenever it lands.
 *
 * ## Two things this migration deliberately does NOT convert
 *
 * Both hold amounts in a **native asset's** minor unit rather than the
 * deployment's currency, so there is no single scale that is correct for every
 * row and a blanket ×100 would silently destroy data:
 *
 * - **`payments.native_amount`** — satoshis on a BTC rail (×1e8), cents on a
 *   fiat or stablecoin rail (×1e2), in the same column, discriminated only by
 *   `native_currency`. See {@link COMMERCE_NATIVE_UNIT_COLUMNS} for the
 *   two-step conversion.
 * - **`payment_intents.payment_options[].nativeAmount`** — the same problem
 *   inside a JSON column, per option. Because an intent's price lock defaults
 *   to 15 minutes, the supported answer is to **let open intents expire and be
 *   re-quoted**: an unconverted option simply fails to reconcile against the
 *   payment that arrives (the check is an exact `!==`), which is a safe, loud
 *   failure rather than a silently mis-scaled quote.
 */

import {
  type DatabaseInterface,
  type MinorUnitsPreflightResult,
  type MinorUnitsRescaleResult,
  type MoneyColumnTarget,
  preflightMinorUnitsRescale,
  rescaleMoneyColumnsToMinorUnits,
} from '@happyvertical/smrt-core/migrations';

/** Marker recorded in `_smrt_backfills` once the column rescale has run. */
export const COMMERCE_MONEY_MINOR_UNITS_BACKFILL =
  '@happyvertical/smrt-commerce:money-minor-units:v1';

/**
 * Every commerce money column denominated in the deployment's own currency,
 * i.e. everything a single scale converts correctly.
 *
 * `invoices`, `invoice_line_items` and `payment_allocations` are absent on
 * purpose: those were already INTEGER (#2361), so the preflight reports them as
 * converted and there is nothing to rescale. Rate columns (`tax_rate`) are
 * absent for the opposite reason — they are genuinely fractional and must stay
 * DECIMAL. `payments.native_amount` is absent because its scale is per-asset;
 * see {@link COMMERCE_NATIVE_UNIT_COLUMNS}.
 */
export const COMMERCE_MONEY_COLUMNS: MoneyColumnTarget[] = [
  { table: 'contracts', columns: ['subtotal', 'tax_amount', 'total_amount'] },
  {
    table: 'contract_line_items',
    columns: ['unit_price', 'discount', 'amount'],
  },
  {
    table: 'payments',
    columns: ['amount', 'usd_at_quote', 'usd_at_confirmation'],
  },
  {
    table: 'payouts',
    columns: ['gross_amount', 'operator_fee', 'supplier_net'],
  },
  { table: 'vendors', columns: ['minimum_order_amount'] },
  { table: 'customers', columns: ['credit_limit'] },
  { table: 'payment_intents', columns: ['usd_price_locked'] },
];

/**
 * Columns whose minor-unit scale is a property of the **row's** asset, not of
 * the deployment — so no single `scale` converts them and they are excluded
 * from {@link migrateCommerceMoneyToMinorUnits}.
 *
 * `payments.native_amount` holds "the amount the backend actually moved, in the
 * native currency's own minor units": satoshis for `BTC` (×1e8), cents for
 * `USDC-base` or `USD-stripe` (×1e2). A blanket ×100 would store 1 satoshi-ish
 * nonsense for a 0.00713 BTC payment whose correct value is 713 000 sats, and
 * a round amount like 0.01 BTC would even pass the preflight's integrality
 * check while being wrong by six orders of magnitude.
 *
 * Convert it in two deliberate steps, from one deploy process, while the column
 * is still floating-point:
 *
 * ```ts
 * // 1. Normalise each row to its own asset's minor units, in the REAL column.
 * for (const [currency, scale] of Object.entries({ BTC: 1e8, 'USDC-base': 100 })) {
 *   await db.query(
 *     'UPDATE payments SET native_amount = round(native_amount * ?) WHERE native_currency = ?',
 *     scale,
 *     currency,
 *   );
 * }
 *
 * // 2. Change the column type with no further scaling.
 * await rescaleMoneyColumnsToMinorUnits(db, COMMERCE_NATIVE_UNIT_COLUMNS, {
 *   scale: 1,
 *   backfillName: '<your-app>:payments-native-amount-minor-units:v1',
 * });
 * ```
 *
 * Step 1 is deliberately yours to write: only the deployment knows which
 * `native_currency` values it has used and what each one's exponent is.
 */
export const COMMERCE_NATIVE_UNIT_COLUMNS: MoneyColumnTarget[] = [
  { table: 'payments', columns: ['native_amount'] },
];

/**
 * Report what {@link migrateCommerceMoneyToMinorUnits} would do, without
 * writing anything.
 *
 * @param db - Root database handle.
 * @param options - `scale` (default 100) and `engineHint`.
 * @returns Per-column state plus the rows that would lose information.
 */
export function preflightCommerceMoneyMinorUnits(
  db: DatabaseInterface,
  options: { scale?: number; engineHint?: string } = {},
): Promise<MinorUnitsPreflightResult> {
  return preflightMinorUnitsRescale(db, COMMERCE_MONEY_COLUMNS, options);
}

/**
 * Convert every single-scale commerce money column from floating-point major
 * units to integer minor units.
 *
 * Idempotent: guarded by a `_smrt_backfills` marker, so re-running can never
 * multiply a table by the scale twice.
 *
 * Does **not** touch `payments.native_amount` or the `paymentOptions` JSON —
 * see this module's header and {@link COMMERCE_NATIVE_UNIT_COLUMNS}.
 *
 * @param db - Root database handle.
 * @param options - `scale` (default 100 — cents), `engineHint`, and `force` to
 *   convert despite rows the preflight flagged as lossy.
 * @throws `MinorUnitsPreflightError` when a row would be rounded or would
 *   overflow `int4` and `force` was not set. Print
 *   {@link preflightCommerceMoneyMinorUnits}'s summary, fix the data, retry.
 */
export function migrateCommerceMoneyToMinorUnits(
  db: DatabaseInterface,
  options: { scale?: number; engineHint?: string; force?: boolean } = {},
): Promise<MinorUnitsRescaleResult> {
  return rescaleMoneyColumnsToMinorUnits(db, COMMERCE_MONEY_COLUMNS, {
    ...options,
    backfillName: COMMERCE_MONEY_MINOR_UNITS_BACKFILL,
    packageName: '@happyvertical/smrt-commerce',
  });
}
