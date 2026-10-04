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
 * - {@link Assembly} — the product that is made: a `Product` STI subtype
 *   (`productType: 'assembly'`) in the shared `products` table. Nesting
 *   lives in its bill: a line whose component SKU belongs to another
 *   assembly is a sub-assembly.
 * - {@link BillOfMaterials} — recipe for one finished product. Multiple
 *   revisions per product via `version` + `status` lifecycle.
 * - {@link BomLine} — one component on a BOM with `qtyPerUnit`, `uom`,
 *   and optional `wastePercent`.
 * - {@link Operation} — a kind of work (cut, weld, inspect); a managed list.
 * - {@link RoutingStep} — an operation in a BOM's optional routing, with an
 *   estimated duration.
 *
 * **Services**
 *
 * - {@link AssemblyService} — resolve a component SKU to an assembly (and
 *   its active bill), a material, or a bought item; refuse cycles.
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
  AssemblyCollection,
  BillOfMaterialsCollection,
  BomLineCollection,
  OperationCollection,
  RoutingStepCollection,
} from './collections/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// Models (and per-model options interfaces)
// ─────────────────────────────────────────────────────────────────────────────
export {
  Assembly,
  type AssemblyOptions,
  BillOfMaterials,
  type BillOfMaterialsOptions,
  BomLine,
  type BomLineOptions,
  Operation,
  type OperationOptions,
  RoutingStep,
  type RoutingStepOptions,
} from './models/index.js';
// ─────────────────────────────────────────────────────────────────────────────
// Operations, routing and the labour estimate
// ─────────────────────────────────────────────────────────────────────────────
export {
  type DefineOperationInput,
  DuplicateOperationCodeError,
  InvalidOperationInputError,
  type LabourEstimate,
  OperationNotFoundError,
  type OperationRateResolver,
  OperationRetiredError,
  type RoutingStepEstimate,
  type RoutingStepInput,
} from './operation-types.js';
// ─────────────────────────────────────────────────────────────────────────────
// Services and dispatch-bus hook helpers (opt-in)
// ─────────────────────────────────────────────────────────────────────────────
export {
  AssemblyService,
  type AssemblyServiceOptions,
  type BillStructure,
  type BillStructureLine,
  BomCycleError,
  type BomCyclePathEntry,
  BomService,
  type BomServiceOptions,
  type ComponentCostResolver,
  type ComponentKind,
  type ConsumeMaterialsOptions,
  type ConsumeResult,
  createAssemblyService,
  createBomService,
  createOperationService,
  createProductionService,
  createRoutingService,
  type InstalledManufacturingDispatchHandlers,
  type InstallManufacturingDispatchHandlersOptions,
  installManufacturingDispatchHandlers,
  OperationService,
  type OperationServiceOptions,
  type ProduceFinishedGoodsOptions,
  type ProduceResult,
  type ProductionOrderCompletedPayload,
  type ProductionOrderPostedPayload,
  type ProductionOrderRef,
  ProductionService,
  type ProductionServiceOptions,
  type ResolveComponentOptions,
  type ResolvedComponent,
  RoutingService,
  type RoutingServiceOptions,
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
