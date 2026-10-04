/**
 * Shared types and error classes for `@happyvertical/smrt-manufacturing`.
 *
 * Strictly industry-neutral. The same vocabulary serves apparel, furniture,
 * automotive, CPG, electronics, food production, custom hardware, and any
 * other vertical that builds finished goods from raw inputs by recipe.
 *
 * @packageDocumentation
 */

import type { LabourEstimate } from './operation-types.js';
import type { ComponentKind } from './services/AssemblyService.js';

/**
 * Lifecycle state of a {@link BillOfMaterials}.
 *
 * - `draft` — under construction; not yet released for production. Cost
 *   rollups can still be computed, but the BOM should not yet be referenced
 *   by a production order.
 * - `active` — currently in use. New production orders should reference the
 *   active BOM for a given product.
 * - `superseded` — an older revision that has been replaced by a newer
 *   `active` BOM. Historical production orders may still reference the
 *   superseded row for audit, but no new orders should pick it up.
 */
export type BomStatus = 'draft' | 'active' | 'superseded';

/**
 * Per-line cost breakdown returned by {@link BomService.computeMaterialCost}.
 * Lets callers surface "here's where the $42 came from" UIs without
 * recomputing on the client.
 */
export interface BomLineCost {
  /**
   * Plain string reference to a component SKU id. The `Sku` model
   * itself lives in `@happyvertical/smrt-products`; inventory only
   * tracks stock motion against that id.
   */
  componentSkuId: string;
  /** Quantity per produced unit (pre-waste). */
  qtyPerUnit: number;
  /** Waste percent applied to this line (`0` if none). */
  wastePercent: number;
  /** Effective quantity used per produced unit, including waste. */
  effectiveQty: number;
  /** Latest known unit cost, or `0` if unavailable. */
  unitCost: number;
  /** Effective unit-cost contribution to the rolled-up total. */
  lineCost: number;
  /** Unit of measure as declared on the line (`'yards'`, `'each'`, ...). */
  uom: string;
  /**
   * `true` when the unit cost could not be resolved from upstream
   * `smrt-products`. The line still contributes `0` to the total; the
   * flag lets UIs warn the user that the cost rollup is incomplete.
   */
  costUnavailable: boolean;
  /**
   * Multi-level only: the active bill this sub-assembly line was rolled up
   * from. `unitCost` is then that bill's material cost per unit.
   */
  subBomId?: string;
  /** Multi-level only: the sub-assembly bill's own lines, rolled up the same way. */
  components?: BomLineCost[];
}

/**
 * Aggregate cost rollup returned by {@link BomService.computeMaterialCost}.
 */
export interface BomCostRollup {
  /** BOM that was rolled up. */
  bomId: string;
  /** Total material cost per produced unit. */
  totalCost: number;
  /** ISO 4217 currency code. Defaults to `'USD'`. */
  currency: string;
  /** Per-line breakdown. Empty array when the BOM has no lines. */
  lineBreakdown: BomLineCost[];
  /**
   * `true` when at least one line's unit cost could not be resolved, at any
   * level walked. Callers should treat `totalCost` as a lower bound in that
   * case.
   */
  hasMissingCosts: boolean;
}

/**
 * A single entry on a requirements explosion. Multiple BOM lines pointing
 * at the same component SKU are summed.
 */
export interface MaterialRequirement {
  /** Plain string reference to the required component {@link Sku}. */
  componentSkuId: string;
  /** Total quantity needed across the full production run (waste included). */
  totalQty: number;
  /** Unit of measure carried over from the originating BOM line(s). */
  uom: string;
}

/**
 * A single shortage discovered by {@link BomService.canProduce}.
 *
 * A single-level check (the default) reports one entry per component SKU
 * with the run's total and the SKU's whole available stock. A multi-level
 * check (`{ levels }`) reports each shortage on the line where it occurs, so
 * the same SKU can appear once per place it is used, and adds `level`,
 * `path`, `uom` and `buildable`.
 */
export interface MaterialShortage {
  /** Plain string reference to the missing component {@link Sku}. */
  componentSkuId: string;
  /** Total quantity required for the requested production run. */
  requested: number;
  /**
   * Available stock across all locations (`available` state). In a
   * multi-level check, the part of it not already allocated to lines planned
   * earlier in the walk.
   */
  available: number;
  /** Multi-level only: the level of the line that is short (1 = the bill's own lines). */
  level?: number;
  /** Multi-level only: the bills from the top down to the one the line is on. */
  path?: ExplosionPathEntry[];
  /** Multi-level only: the line's unit of measure. */
  uom?: string;
  /**
   * Multi-level only: `true` for a sub-assembly with an active bill that the
   * walk did not open because the `levels` limit was reached. It is short,
   * but could be built.
   */
  buildable?: boolean;
}

/**
 * Result returned by {@link BomService.canProduce}.
 *
 * `ok: true` means every material requirement is currently covered by
 * available stock; `ok: false` means at least one component is short.
 */
export type CanProduceResult =
  | { ok: true; shortages: [] }
  | { ok: false; shortages: MaterialShortage[] };

/**
 * Thrown when a service operation needs to resolve a BOM by id but the row
 * does not exist. Carries the requested id so callers can surface a
 * meaningful message.
 */
export class BomNotFoundError extends Error {
  override name = 'BomNotFoundError';

  constructor(public readonly bomId: string) {
    super(`Bill of Materials not found: ${bomId}`);
  }
}

/**
 * Thrown when a production-order operation needs a BOM to plan against but
 * no active BOM is currently registered for the production order's
 * `productId`. The caller should either link a BOM by passing one in
 * explicitly or activate one for the given product.
 */
export class NoActiveBomForProductError extends Error {
  override name = 'NoActiveBomForProductError';

  constructor(public readonly productId: string) {
    super(
      `No active Bill of Materials found for product: ${productId}. ` +
        `Activate a BOM for this product or pass one explicitly.`,
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Multi-level walks (sub-assemblies)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * How many bill levels a walk reads. `1` is the bill's own lines only (the
 * single-level behaviour every method keeps by default); `2` also opens each
 * sub-assembly's active bill; and so on. `'all'` walks down to materials,
 * bought items and assemblies without an active bill, up to
 * {@link MAX_EXPLOSION_DEPTH} levels.
 */
export type ExplosionLevels = number | 'all';

/** Options for the multi-level forms of the {@link BomService} methods. */
export interface ExplosionOptions {
  /** How deep to walk. Default `1`. See {@link ExplosionLevels}. */
  levels?: ExplosionLevels;
}

/**
 * The deepest structure a walk opens. A numeric `levels` above it is refused;
 * `'all'` on a structure deeper than this fails with
 * {@link BomExplosionLimitError} rather than running unbounded.
 */
export const MAX_EXPLOSION_DEPTH = 32;

/**
 * The most lines one walk returns. A structure that shares sub-assemblies
 * widely can multiply out; past this a walk fails with
 * {@link BomExplosionLimitError}.
 */
export const MAX_EXPLOSION_LINES = 10_000;

/** One bill on the way down a multi-level walk. */
export interface ExplosionPathEntry {
  /** The bill. */
  bomId: string;
  /** The product the bill makes. */
  productId: string;
  /** The product's name, or its id when it has none or cannot be read. */
  name: string;
}

/**
 * One bill line in a multi-level walk, in depth-first order: an expanded
 * sub-assembly is followed by its own bill's lines.
 */
export interface ExplodedLine {
  /** The `BomLine` id. */
  lineId: string;
  /** The bill the line is on. */
  bomId: string;
  /** 1 for the top bill's own lines, 2 for a sub-assembly's lines, ... */
  level: number;
  /** The bills from the top down to the one this line is on (`level` entries). */
  path: ExplosionPathEntry[];
  /** The component SKU. */
  componentSkuId: string;
  /** What the component is (see `AssemblyService.resolveComponent`). */
  kind: ComponentKind;
  /** The component product's name; `''` when it cannot be resolved. */
  name: string;
  /** The component SKU's code; `''` when it cannot be resolved. */
  skuCode: string;
  /** Quantity per unit of the parent, as on the line (before waste). */
  qtyPerUnit: number;
  /** Waste percent on the line. */
  wastePercent: number;
  /** Quantity per unit of the parent including this line's waste. */
  effectiveQtyPerUnit: number;
  /** The line's own unit of measure; never converted. */
  uom: string;
  /**
   * Quantity needed for the run: the parent's quantity times
   * `effectiveQtyPerUnit`, so waste compounds down the levels.
   */
  totalQty: number;
  /** `true` for a sub-assembly with an active bill (it can be built here). */
  buildable: boolean;
  /** The sub-assembly's active bill id, or `null`. */
  subBomId: string | null;
  /** `true` when the sub-assembly's bill was opened: its lines follow this one. */
  expanded: boolean;
}

/** Result of {@link BomService.explode}: the gross multi-level requirements. */
export interface Explosion {
  /** The top bill. */
  bomId: string;
  /** The product the top bill makes. */
  productId: string;
  /** Units of the top product the run makes. */
  qty: number;
  /** The `levels` the walk used. */
  levels: ExplosionLevels;
  /** Every line walked, depth first. */
  lines: ExplodedLine[];
  /**
   * The rolled-up shopping list: every line that was not expanded (materials,
   * bought items, missing components, sub-assemblies without an active bill
   * or past the `levels` limit), summed per component SKU. As in the
   * single-level form, a SKU listed in two units keeps the first unit.
   */
  totals: MaterialRequirement[];
}

/**
 * One line of {@link RequirementsPlan}. `totalQty` is the *net* quantity: the
 * run's quantity for the top bill's lines, and only a sub-assembly's
 * shortfall for the lines of its bill.
 */
export interface PlannedLine extends ExplodedLine {
  /**
   * Available stock of the component (all locations) not already allocated
   * to lines planned earlier in the walk, so stock used once is not counted
   * twice.
   */
  available: number;
  /** `totalQty` minus what `available` covers; `0` when covered. */
  short: number;
}

/**
 * Result of {@link BomService.planRequirements}: facts for deciding what to
 * build, buy or pull. A sub-assembly that is short and has an active bill is
 * opened for its shortfall only; whether the application builds or buys it is
 * the application's decision.
 */
export interface RequirementsPlan {
  /** The top bill. */
  bomId: string;
  /** The product the top bill makes. */
  productId: string;
  /** Units of the top product the run makes. */
  qty: number;
  /** The `levels` the walk used. */
  levels: ExplosionLevels;
  /** Every line planned, depth first. */
  lines: PlannedLine[];
  /**
   * Every line that is short and was not opened (a material, a bought item,
   * a missing component, or a sub-assembly with no active bill or past the
   * `levels` limit), reported at its own level.
   */
  shortages: MaterialShortage[];
  /** `true` when `shortages` is empty. */
  ok: boolean;
}

/** One sub-assembly's labour in a multi-level {@link LabourEstimate}. */
export interface SubAssemblyLabour {
  /** The line naming the sub-assembly. */
  lineId: string;
  /** The sub-assembly's component SKU. */
  componentSkuId: string;
  /** The sub-assembly's name. */
  name: string;
  /** The level of the line naming it (1 = on the top bill). */
  level: number;
  /** The bills from the top down to the one the line is on. */
  path: ExplosionPathEntry[];
  /**
   * Units of the sub-assembly per unit of the top product, waste compounded
   * through every level above.
   */
  unitsPerUnit: number;
  /** The sub-assembly bill's own routing, per unit of the sub-assembly. */
  estimate: LabourEstimate;
}

/**
 * Thrown when a multi-level walk would exceed {@link MAX_EXPLOSION_DEPTH}
 * levels (with `levels: 'all'`) or {@link MAX_EXPLOSION_LINES} lines.
 */
export class BomExplosionLimitError extends Error {
  override name = 'BomExplosionLimitError';

  constructor(
    /** The bill the walk started from. */
    public readonly bomId: string,
    /** Which limit was reached. */
    public readonly limit: 'depth' | 'lines',
  ) {
    super(
      limit === 'depth'
        ? `Bill ${bomId} is nested deeper than ${MAX_EXPLOSION_DEPTH} levels.`
        : `Bill ${bomId} explodes to more than ${MAX_EXPLOSION_LINES} lines.`,
    );
  }
}
