/**
 * @happyvertical/smrt-inventory
 *
 * Multi-location stock tracking for the SMRT framework. Strictly
 * industry-neutral: the same primitives serve apparel, furniture,
 * automotive, CPG, electronics, and any other vertical that needs to
 * count discrete units across locations.
 *
 * **Model hierarchy**
 *
 * - {@link Sku} — smallest sellable and countable unit. Plain-string
 *   `productId` reference to the upstream product catalog.
 * - {@link Variant} — declarative axis definition driving SKU attributes
 *   (e.g. `axisName: 'size'`, `values: ['XS','S','M','L','XL']`).
 * - {@link InventoryLocation} — physical or virtual stocking site.
 * - {@link StockLevel} — materialized `(skuId, locationId, state) → qty`
 *   view; mutated only by {@link StockService}.
 * - {@link StockMovement} — append-only audit log of every mutation.
 *
 * **The only sanctioned way to change `qty`** is the
 * {@link StockService} (`receive` / `reserve` / `release` / `fulfill` /
 * `transfer` / `adjust`). Each call writes one (or two, for transfers)
 * StockMovement rows so the audit ledger stays in lockstep with the
 * materialized levels.
 *
 * @packageDocumentation
 */

// Self-register this package's manifest before any @smrt() decorator
// fires downstream. Must come first so the side effect runs ahead of
// the class module loads below. See __smrt-register__.ts for the
// issue #1132 context.
import './__smrt-register__.js';

// ─────────────────────────────────────────────────────────────────────────────
// Collections
// ─────────────────────────────────────────────────────────────────────────────
export {
  InventoryLocationCollection,
  SkuCollection,
  StockLevelCollection,
  StockMovementCollection,
  VariantCollection,
} from './collections/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// Models (and per-model options interfaces)
// ─────────────────────────────────────────────────────────────────────────────
export {
  InventoryLocation,
  type InventoryLocationOptions,
  Sku,
  type SkuOptions,
  StockLevel,
  type StockLevelOptions,
  StockMovement,
  type StockMovementOptions,
  Variant,
  type VariantOptions,
} from './models/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// Services and dispatch-bus hook helpers (opt-in)
// ─────────────────────────────────────────────────────────────────────────────
export {
  type ContractCreatedLine,
  type ContractCreatedPayload,
  createStockService,
  type FulfillmentShippedLine,
  type FulfillmentShippedPayload,
  type InstalledInventoryDispatchHandlers,
  type InstallInventoryDispatchHandlersOptions,
  InsufficientStockError,
  installInventoryDispatchHandlers,
  type StockMutationOptions,
  StockService,
  type StockServiceOptions,
} from './services/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// Shared types and enums
// ─────────────────────────────────────────────────────────────────────────────
export type {
  InventoryLocationKind,
  StockMovementReason,
  StockState,
} from './types.js';
