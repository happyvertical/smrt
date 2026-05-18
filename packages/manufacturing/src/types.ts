/**
 * Shared types and error classes for `@happyvertical/smrt-manufacturing`.
 *
 * Strictly industry-neutral. The same vocabulary serves apparel, furniture,
 * automotive, CPG, electronics, food production, custom hardware, and any
 * other vertical that builds finished goods from raw inputs by recipe.
 *
 * @packageDocumentation
 */

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
  /** Plain string reference to the component {@link Sku} from `smrt-inventory`. */
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
   * `true` when at least one line's unit cost could not be resolved.
   * Callers should treat `totalCost` as a lower bound in that case.
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
 */
export interface MaterialShortage {
  /** Plain string reference to the missing component {@link Sku}. */
  componentSkuId: string;
  /** Total quantity required for the requested production run. */
  requested: number;
  /** Available stock across all locations (`available` state). */
  available: number;
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
