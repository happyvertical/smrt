/**
 * BomService — cost rollup, requirements explosion, and "can we make this?"
 * stock-availability checks for a {@link BillOfMaterials}.
 *
 * The service is the sanctioned planning surface for BOM-driven workflows.
 * It never mutates stock — it answers questions:
 *
 * - "How much does it cost to make one unit?" via {@link computeMaterialCost}
 * - "What do I need to buy / pull to make N units?" via {@link explodeRequirements}
 * - "Do I have enough on hand?" via {@link canProduce}
 *
 * Construct via {@link BomService.create} — the static factory wires up
 * the BOM, BOM-line, and inventory collections so a single `db` (or a
 * pre-built {@link StockService}) drives everything.
 *
 * Material cost resolution is pluggable. Pass a `costResolver` callback to
 * supply unit costs from anywhere — `@happyvertical/smrt-products`
 * (`Material.costPerUnit`), a purchase-order rolling average, a vendor
 * price book, anything. When no resolver is supplied, costs default to
 * `0` and the per-line `costUnavailable` flag is set so UIs can surface
 * "missing cost data" rather than silently rolling up a $0 BOM.
 *
 * @packageDocumentation
 */

import {
  createStockService,
  type StockService,
} from '@happyvertical/smrt-inventory';
import type { DatabaseInterface } from '@happyvertical/sql';
import { BillOfMaterialsCollection } from '../collections/BillOfMaterialsCollection.js';
import { BomLineCollection } from '../collections/BomLineCollection.js';
import type { BillOfMaterials } from '../models/BillOfMaterials.js';
import type { BomLine } from '../models/BomLine.js';
import {
  type BomCostRollup,
  type BomLineCost,
  BomNotFoundError,
  type CanProduceResult,
  type MaterialRequirement,
  type MaterialShortage,
} from '../types.js';

/**
 * Callback signature for resolving the unit cost of a component SKU.
 *
 * Implementations should return the latest known cost in the BOM's
 * currency, or `null` (or `undefined`) when no cost is available. The
 * service treats unresolved costs as `0` and marks the affected line so
 * callers can warn the user.
 *
 * @example
 * ```typescript
 * import { MaterialCollection } from '@happyvertical/smrt-products/models';
 *
 * const materials = await MaterialCollection.create({ db });
 *
 * const bom = await BomService.create({
 *   db,
 *   costResolver: async (componentSkuId) => {
 *     const sku = await skus.get(componentSkuId);
 *     if (!sku?.productId) return null;
 *     const material = await materials.get(sku.productId);
 *     return material?.costPerUnit ?? null;
 *   },
 * });
 * ```
 */
export type ComponentCostResolver = (
  componentSkuId: string,
) => Promise<number | null | undefined> | number | null | undefined;

/**
 * Options accepted by {@link BomService.create}.
 *
 * Either provide a `db` for the service to construct its own internal
 * collections + {@link StockService}, or pass a pre-built `stockService`
 * to share one across subsystems.
 */
export type BomServiceOptions = {
  /**
   * Optional resolver that returns the latest known unit cost for a
   * component SKU. See {@link ComponentCostResolver}. When omitted, all
   * costs default to `0` and per-line `costUnavailable` is set.
   */
  costResolver?: ComponentCostResolver;
} & (
  | { db: DatabaseInterface; stockService?: StockService }
  | { stockService: StockService; db?: DatabaseInterface }
);

/**
 * BOM-driven planning service. See module documentation for the role
 * this plays in the manufacturing pipeline.
 *
 * @example
 * ```typescript
 * const bomService = await BomService.create({ db });
 * const rollup = await bomService.computeMaterialCost(bom.id!);
 * const requirements = await bomService.explodeRequirements(bom.id!, 100);
 * const check = await bomService.canProduce(bom.id!, 100);
 * ```
 */
export class BomService {
  private constructor(
    public readonly boms: BillOfMaterialsCollection,
    public readonly lines: BomLineCollection,
    public readonly stockService: StockService,
    private readonly costResolver: ComponentCostResolver | undefined,
  ) {}

  /** Factory — prefer {@link createBomService}. */
  static async create(options: BomServiceOptions): Promise<BomService> {
    const stockService =
      options.stockService ??
      (await createStockService({ db: options.db as DatabaseInterface }));
    // Share the same db that the StockService uses so reads always hit
    // one connection / pool.
    const sharedDb =
      options.db ??
      (stockService as unknown as { skus: { db: DatabaseInterface } }).skus.db;
    const [boms, lines] = await Promise.all([
      BillOfMaterialsCollection.create({ db: sharedDb }),
      BomLineCollection.create({ db: sharedDb }),
    ]);
    return new BomService(boms, lines, stockService, options.costResolver);
  }

  /**
   * Walk every {@link BomLine} for the given BOM, resolve each line's
   * component cost, apply waste, and return the rolled-up material cost
   * per produced unit along with a per-line breakdown.
   *
   * Throws {@link BomNotFoundError} when the BOM does not exist.
   *
   * Lines whose cost cannot be resolved contribute `0` to the total and
   * set `costUnavailable: true` on their breakdown row; the aggregate
   * `hasMissingCosts` flag mirrors this so callers can surface a UI
   * warning.
   */
  async computeMaterialCost(bomId: string): Promise<BomCostRollup> {
    const bom = await this.requireBom(bomId);
    const lines = await this.lines.findByBom(bomId);
    const lineBreakdown: BomLineCost[] = [];
    let totalCost = 0;
    let hasMissingCosts = false;

    for (const line of lines) {
      const effectiveQty = line.effectiveQtyPerUnit();
      const resolved = await this.resolveCost(line.componentSkuId);
      const unitCost = resolved ?? 0;
      const costUnavailable = resolved === null || resolved === undefined;
      const lineCost = unitCost * effectiveQty;
      if (costUnavailable) {
        hasMissingCosts = true;
      } else {
        totalCost += lineCost;
      }

      lineBreakdown.push({
        componentSkuId: line.componentSkuId,
        qtyPerUnit: Number(line.qtyPerUnit ?? 0),
        wastePercent: Number(line.wastePercent ?? 0),
        effectiveQty,
        unitCost,
        lineCost,
        uom: line.uom,
        costUnavailable,
      });
    }

    return {
      bomId,
      totalCost,
      currency: bom.currency || 'USD',
      lineBreakdown,
      hasMissingCosts,
    };
  }

  /**
   * Return a "shopping list" of materials needed to produce `qty` units of
   * the parent product against the given BOM. Lines that reference the
   * same component SKU are summed so each `componentSkuId` appears once
   * in the result.
   *
   * Does NOT mutate stock — purely a planning helper. Use
   * {@link ProductionService.consumeMaterials} when you're ready to write
   * stock movements.
   *
   * Throws {@link BomNotFoundError} when the BOM does not exist; throws a
   * plain `Error` when `qty` is not a positive finite number.
   */
  async explodeRequirements(
    bomId: string,
    qty: number,
  ): Promise<MaterialRequirement[]> {
    assertPositiveQty(qty, 'explodeRequirements');
    await this.requireBom(bomId);
    const lines = await this.lines.findByBom(bomId);

    // Sum across duplicate component SKUs. Keep the first-seen `uom` per
    // SKU; if two lines disagree on `uom`, we surface the first one and
    // assume the caller noticed during BOM authoring.
    const aggregate = new Map<string, MaterialRequirement>();
    for (const line of lines) {
      const effectiveQty = line.effectiveQtyPerUnit() * qty;
      const existing = aggregate.get(line.componentSkuId);
      if (existing) {
        existing.totalQty += effectiveQty;
      } else {
        aggregate.set(line.componentSkuId, {
          componentSkuId: line.componentSkuId,
          totalQty: effectiveQty,
          uom: line.uom,
        });
      }
    }

    return Array.from(aggregate.values());
  }

  /**
   * Check whether the requirements for producing `qty` units against the
   * given BOM are currently satisfied by available stock. Returns
   * `{ ok: true, shortages: [] }` when every component has enough
   * `available` stock across all locations; `{ ok: false, shortages: [...] }`
   * with one entry per insufficient component otherwise.
   *
   * Available stock is summed across every location (the planning
   * question is "do we have it at all?"; the operational question of
   * "where do we pull from?" is left to the caller of
   * {@link ProductionService.consumeMaterials}).
   *
   * Throws {@link BomNotFoundError} when the BOM does not exist.
   */
  async canProduce(bomId: string, qty: number): Promise<CanProduceResult> {
    const requirements = await this.explodeRequirements(bomId, qty);
    const shortages: MaterialShortage[] = [];

    for (const requirement of requirements) {
      const available = await this.stockService.levels.totalForSku(
        requirement.componentSkuId,
        'available',
      );
      if (available < requirement.totalQty) {
        shortages.push({
          componentSkuId: requirement.componentSkuId,
          requested: requirement.totalQty,
          available,
        });
      }
    }

    if (shortages.length === 0) {
      return { ok: true, shortages: [] };
    }
    return { ok: false, shortages };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Internal helpers
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Fetch a BOM by id or throw {@link BomNotFoundError}. Centralises the
   * "missing BOM" error path so callers don't have to repeat the check.
   */
  private async requireBom(bomId: string): Promise<BillOfMaterials> {
    if (!bomId) throw new BomNotFoundError(bomId);
    const bom = await this.boms.get(bomId);
    if (!bom) throw new BomNotFoundError(bomId);
    return bom;
  }

  /**
   * Run the supplied {@link ComponentCostResolver} for the given component
   * SKU. Returns `null` when no resolver is registered or when the
   * resolver returns `null` / `undefined`.
   */
  private async resolveCost(componentSkuId: string): Promise<number | null> {
    if (!this.costResolver) return null;
    const value = await this.costResolver(componentSkuId);
    if (value === null || value === undefined) return null;
    if (!Number.isFinite(value)) return null;
    return Number(value);
  }
}

/**
 * Reject zero / negative / non-finite quantities up front for service
 * methods that accept production-run quantities.
 */
function assertPositiveQty(qty: number, op: string): void {
  if (!Number.isFinite(qty) || qty <= 0) {
    throw new Error(`${op}: qty must be a positive finite number (got ${qty})`);
  }
}

/**
 * Convenience factory. Returns a fully-initialized {@link BomService}.
 */
export async function createBomService(
  options: BomServiceOptions,
): Promise<BomService> {
  return BomService.create(options);
}

// Re-export the BomLine type alias to ease typing in adjacent code that
// wires `BomLine[]` payloads through this service.
export type { BomLine };
