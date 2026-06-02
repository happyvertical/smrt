/**
 * Shared types for @happyvertical/smrt-inventory.
 *
 * These are deliberately industry-neutral: the same vocabulary serves
 * apparel, furniture, automotive, CPG, electronics, and any other domain
 * that tracks countable units across locations.
 *
 * @packageDocumentation
 */

/**
 * Logical state of a quantity of stock at a `(skuId, locationId)` pair.
 *
 * StockLevel rows are tuples of `(skuId, locationId, state)`, so a single
 * SKU at a single location can simultaneously have non-zero quantities in
 * several states (e.g. 50 available, 10 allocated, 3 damaged).
 *
 * - `available` — on hand and free to allocate.
 * - `allocated` — reserved against a contract, order, or production plan;
 *   physically still on site but no longer free to sell.
 * - `wip` — work-in-progress: consumed materials inside an active
 *   production order, not yet emitted as finished goods.
 * - `qc_hold` — held pending quality control; not available to allocate
 *   or ship until released.
 * - `damaged` — damaged or otherwise unsellable; kept on the books for
 *   shrinkage accounting until written off.
 */
export type StockState =
  | 'available'
  | 'allocated'
  | 'wip'
  | 'qc_hold'
  | 'damaged';

/**
 * Open-ended classifier for an InventoryLocation. The framework does not
 * special-case any value — pass whatever taxonomy your application needs.
 *
 * The strings listed here are conventions, not an exhaustive enum:
 * - `warehouse` — fulfillment warehouse
 * - `factory` — manufacturing site
 * - `retail` — storefront / point-of-sale
 * - `in_transit` — virtual location for stock that has left A but not yet
 *   arrived at B; balances `transfer()` semantics
 * - `virtual` — any other non-physical bucket (returns staging, scrap,
 *   consignment pool)
 */
export type InventoryLocationKind = string;

/**
 * Why a StockMovement was written.
 *
 * Each {@link StockService} method writes one movement with a `reasonCode`
 * drawn from this list. Free-form `string` is also accepted so consumers
 * can introduce vocabulary specific to their business (e.g. `'shrink'`,
 * `'sample'`, `'consignment_out'`) without forking the package.
 */
export type StockMovementReason =
  | 'receipt'
  | 'reservation'
  | 'release'
  | 'fulfillment'
  | 'transfer_out'
  | 'transfer_in'
  | 'adjustment'
  | 'production_consume'
  | 'production_produce'
  | (string & {});
