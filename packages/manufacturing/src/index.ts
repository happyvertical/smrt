/**
 * @happyvertical/smrt-manufacturing
 *
 * Bills of materials, cost rollup, and production-order operations for
 * the SMRT framework. Strictly industry-neutral: the same primitives
 * serve apparel, furniture, automotive, CPG, electronics, food production,
 * custom hardware, and any other vertical that builds finished goods from
 * a recipe.
 *
 * **Model hierarchy**
 *
 * - {@link BillOfMaterials} — recipe for one finished product. Multiple
 *   revisions per product via `version` + `status` lifecycle.
 * - {@link BomLine} — one component on a BOM with `qtyPerUnit`, `uom`,
 *   and optional `wastePercent`.
 *
 * **Services**
 *
 * - {@link BomService} — cost rollup, requirements explosion,
 *   "can we make this?" stock availability check.
 * - {@link ProductionService} — operational bridge from a production
 *   order to actual `StockMovement` rows via the inventory
 *   {@link StockService}.
 * - {@link installManufacturingDispatchHandlers} — opt-in DispatchBus
 *   wiring for `production_order:posted` and `production_order:completed`.
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
  BillOfMaterialsCollection,
  BomLineCollection,
} from './collections/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// Models (and per-model options interfaces)
// ─────────────────────────────────────────────────────────────────────────────
export {
  BillOfMaterials,
  type BillOfMaterialsOptions,
  BomLine,
  type BomLineOptions,
} from './models/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// Services and dispatch-bus hook helpers (opt-in)
// ─────────────────────────────────────────────────────────────────────────────
export {
  BomService,
  type BomServiceOptions,
  type ComponentCostResolver,
  type ConsumeMaterialsOptions,
  type ConsumeResult,
  createBomService,
  createProductionService,
  type InstalledManufacturingDispatchHandlers,
  type InstallManufacturingDispatchHandlersOptions,
  installManufacturingDispatchHandlers,
  type ProduceFinishedGoodsOptions,
  type ProduceResult,
  type ProductionOrderCompletedPayload,
  type ProductionOrderPostedPayload,
  type ProductionOrderRef,
  ProductionService,
  type ProductionServiceOptions,
} from './services/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// Shared types, error classes, and result shapes
// ─────────────────────────────────────────────────────────────────────────────
export {
  type BomCostRollup,
  type BomLineCost,
  BomNotFoundError,
  type BomStatus,
  type CanProduceResult,
  type MaterialRequirement,
  type MaterialShortage,
  NoActiveBomForProductError,
} from './types.js';
