/**
 * @happyvertical/smrt-inventory
 *
 * Multi-location stock tracking for the SMRT framework. Strictly
 * industry-neutral: the same primitives serve apparel, furniture,
 * automotive, CPG, electronics, and any other vertical that needs to
 * count discrete units across locations.
 *
 * **Layering**
 *
 * Catalog shapes (`Product`, `Material`, `ProductVariant`, `Sku`) live
 * in `@happyvertical/smrt-products`. This package adds the
 * stock-motion layer on top: where the unit lives, how many are there,
 * and an append-only ledger of every change.
 *
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
 * Consumers typically import from both packages:
 *
 *     import { Sku, ProductVariant } from '@happyvertical/smrt-products';
 *     import { StockService, InventoryLocation } from '@happyvertical/smrt-inventory';
 *
 * We deliberately do NOT re-export catalog shapes from this barrel
 * because the products main entry pulls in vite virtual modules — that
 * would complicate downstream test setups in packages that depend
 * transitively on inventory.
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
  StockLevelCollection,
  StockMovementCollection,
} from './collections/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// Models (and per-model options interfaces)
// ─────────────────────────────────────────────────────────────────────────────
export {
  InventoryLocation,
  type InventoryLocationOptions,
  StockLevel,
  type StockLevelOptions,
  StockMovement,
  type StockMovementOptions,
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
